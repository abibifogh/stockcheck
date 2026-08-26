import {
  badRequest, json, notFound, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import { readSettings } from '../lib/notify.js';
import { dueBackAt, graceHours } from '../lib/tools.js';

/**
 * The tool store.
 *
 * Parts are used up and counted; tools go out and come back, and what matters
 * is where one is and who has it. Every write here is about a journey rather
 * than a quantity.
 */

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

/**
 * Every tool, and for each one the journey it is on if it is out.
 *
 * One call rather than a list and then a status per row: the question somebody
 * opens this screen with is "what is out", and answering it per tool would be
 * one request per drill.
 */
export async function list(ctx) {
  let ready = true;
  const tools = await ctx.db.prepare(
    `SELECT t.*, c.name AS category_name
       FROM tools t
       LEFT JOIN mx_categories c ON c.id = t.category_id
      WHERE t.active = 1
      ORDER BY t.name`,
  ).all().catch((err) => {
    if (!/no such table|no such column/i.test(String(err?.message ?? err))) throw err;
    ready = false;
    return { results: [] };
  });
  if (!ready) return json({ ready: false, tools: [] });

  const out = await ctx.db.prepare(
    `SELECT m.*, a.name AS area_name
       FROM tool_movements m
       LEFT JOIN mx_areas a ON a.id = m.area_id
      WHERE m.returned_at IS NULL`,
  ).all().catch(() => ({ results: [] }));

  const byTool = new Map((out.results ?? []).map((m) => [m.tool_id, m]));
  const settings = await readSettings(ctx.db);

  return json({
    ready: true,
    graceHours: graceHours(settings),
    tools: (tools.results ?? []).map((t) => {
      const trip = byTool.get(t.id);
      return {
        id: t.id,
        name: t.name,
        tag: t.tag,
        categoryName: t.category_name,
        note: t.note,
        out: trip
          ? {
            movementId: trip.id,
            issuedTo: trip.issued_to,
            issuedBy: trip.issued_by,
            issuedAt: trip.issued_at,
            dueBackAt: trip.due_back_at,
            areaName: trip.area_name,
            note: trip.note,
          }
          : null,
      };
    }),
  });
}

/** Everywhere one tool has been, newest first. */
export async function history(ctx, id) {
  const tool = await ctx.db.prepare('SELECT * FROM tools WHERE id = ?').bind(Number(id)).first();
  if (!tool) throw notFound('That tool is not in the register.');

  const rows = await ctx.db.prepare(
    `SELECT m.*, a.name AS area_name
       FROM tool_movements m
       LEFT JOIN mx_areas a ON a.id = m.area_id
      WHERE m.tool_id = ?
      ORDER BY m.id DESC
      LIMIT 200`,
  ).bind(Number(id)).all();

  return json({
    tool: { id: tool.id, name: tool.name, tag: tool.tag, note: tool.note },
    movements: (rows.results ?? []).map((m) => ({
      id: m.id,
      issuedTo: m.issued_to,
      issuedBy: m.issued_by,
      issuedAt: m.issued_at,
      dueBackAt: m.due_back_at,
      areaName: m.area_name,
      returnedAt: m.returned_at,
      receivedBy: m.received_by,
      note: m.note,
      returnNote: m.return_note,
      // A trip that was chased. Worth showing on the history: a tool that goes
      // late every time is a fact about somebody's habits, not about one day.
      wasChased: Boolean(m.overdue_notified_at),
    })),
  });
}

// ---------------------------------------------------------------------------
// Out and back
// ---------------------------------------------------------------------------

/** Hand a tool to somebody, for work somewhere. */
export async function issue(ctx, id) {
  const body = await readJson(ctx.request);
  const toolId = Number(id);

  const tool = await ctx.db.prepare('SELECT * FROM tools WHERE id = ? AND active = 1')
    .bind(toolId).first();
  if (!tool) throw notFound('That tool is not in the register.');

  const issuedTo = str(body.issuedTo, 'Who is taking it', { required: true, max: 80 });
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;
  const areaId = body.areaId == null || body.areaId === '' ? null : Number(body.areaId);
  if (areaId != null) {
    const area = await ctx.db.prepare('SELECT id FROM mx_areas WHERE id = ? AND active = 1')
      .bind(areaId).first();
    if (!area) throw badRequest('That room or area is no longer on the list.');
  }

  const settings = await readSettings(ctx.db);
  const hours = graceHours(settings);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    await ctx.db.prepare(
      `INSERT INTO tool_movements (tool_id, area_id, issued_to, issued_by, issued_at, due_back_at, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(toolId, areaId, issuedTo, ctx.session.user.name, now, dueBackAt(now, hours), note).run();
  } catch (err) {
    // The partial unique index. Somebody is trying to hand out a drill that is
    // already in a van, which is worth saying plainly rather than as a 500.
    if (/UNIQUE/i.test(String(err?.message ?? err))) {
      const held = await ctx.db.prepare(
        'SELECT issued_to FROM tool_movements WHERE tool_id = ? AND returned_at IS NULL',
      ).bind(toolId).first();
      throw badRequest(`${tool.name} is already out${held?.issued_to ? ` with ${held.issued_to}` : ''}. `
        + 'Mark it returned before issuing it again.');
    }
    rethrowConstraint(err, { foreignKey: 'That room or area no longer exists.' });
    throw err;
  }

  await audit(ctx, 'mx.tool.issue', toolId, { issuedTo, areaId });
  return json({ ok: true, dueBackAt: dueBackAt(now, hours) }, { status: 201 });
}

/** Take it back in. */
export async function markReturned(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const toolId = Number(id);
  const returnNote = str(body.returnNote, 'Note', { max: 300, fallback: '' }) || null;

  const trip = await ctx.db.prepare(
    'SELECT * FROM tool_movements WHERE tool_id = ? AND returned_at IS NULL',
  ).bind(toolId).first();
  if (!trip) throw badRequest('That tool is not out — there is nothing to return.');

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await ctx.db.prepare(
    `UPDATE tool_movements
        SET returned_at = ?1, received_by = ?2, return_note = ?3
      WHERE id = ?4 AND returned_at IS NULL`,
  ).bind(now, ctx.session.user.name, returnNote, trip.id).run();

  await audit(ctx, 'mx.tool.return', toolId, { issuedTo: trip.issued_to });
  return json({ ok: true, wasOverdue: Boolean(trip.overdue_notified_at) });
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

export async function create(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 100 });
  const tag = str(body.tag, 'Tag', { max: 40, fallback: '' }) || null;

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO tools (name, tag, category_id, note)
       VALUES (?1, ?2, ?3, ?4) RETURNING *`,
    ).bind(
      name, tag,
      body.categoryId ? Number(body.categoryId) : null,
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
    ).first();
    await audit(ctx, 'mx.tool.create', row.id, { name, tag });
    return json({ tool: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, {
      unique: `Tag "${tag}" is already on another tool.`,
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }
}

export async function update(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 100 });
  const tag = str(body.tag, 'Tag', { max: 40, fallback: '' }) || null;

  try {
    const row = await ctx.db.prepare(
      `UPDATE tools SET name = ?2, tag = ?3, category_id = ?4, note = ?5
        WHERE id = ?1 RETURNING *`,
    ).bind(
      Number(id), name, tag,
      body.categoryId ? Number(body.categoryId) : null,
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
    ).first();
    if (!row) throw notFound('That tool is not in the register.');
    await audit(ctx, 'mx.tool.update', id, { name });
    return json({ tool: row });
  } catch (err) {
    rethrowConstraint(err, { unique: `Tag "${tag}" is already on another tool.` });
    throw err;
  }
}

/**
 * Retire a tool rather than delete it.
 *
 * Its journeys are the record of who had what and when, and a broken drill
 * thrown in a skip does not make last month's trips untrue.
 */
export async function retire(ctx, id) {
  const out = await ctx.db.prepare(
    'SELECT issued_to FROM tool_movements WHERE tool_id = ? AND returned_at IS NULL',
  ).bind(Number(id)).first();
  if (out) {
    throw badRequest(`That tool is still out with ${out.issued_to}. `
      + 'Mark it returned before retiring it.');
  }

  const result = await ctx.db.prepare('UPDATE tools SET active = 0 WHERE id = ? AND active = 1')
    .bind(Number(id)).run();
  if (!result.meta?.changes) throw notFound('That tool has already been retired.');

  await audit(ctx, 'mx.tool.retire', id, null);
  return json({ ok: true, retired: true });
}
