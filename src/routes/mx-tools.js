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
    // parent_tool_id is named rather than covered by t.*, so a database that
    // has 0019 but not 0020 trips the catch below and gets the "waiting on a
    // database update" card — instead of a screen that looks fine until
    // somebody presses Belongs to and gets "no such column".
    `SELECT t.*, t.parent_tool_id, c.name AS category_name
       FROM mx_tools t
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
       FROM mx_tool_movements m
       LEFT JOIN mx_areas a ON a.id = m.area_id
      WHERE m.returned_at IS NULL`,
  ).all().catch(() => ({ results: [] }));

  const byTool = new Map((out.results ?? []).map((m) => [m.tool_id, m]));
  const settings = await readSettings(ctx.db);

  const shape = (t) => {
    const trip = byTool.get(t.id);
    return {
      id: t.id,
      name: t.name,
      tag: t.tag,
      categoryName: t.category_name,
      note: t.note,
      parentToolId: t.parent_tool_id ?? null,
      out: trip
        ? {
          movementId: trip.id,
          issuedTo: trip.issued_to,
          issuedBy: trip.issued_by,
          issuedAt: trip.issued_at,
          dueBackAt: trip.due_back_at,
          areaName: trip.area_name,
          note: trip.note,
          // Whether it went out on its parent's trip or on one of its own.
          // "Out with the drill" and "out on its own" are different answers to
          // the question somebody is actually asking.
          withMovementId: trip.with_movement_id ?? null,
        }
        : null,
    };
  };

  const rows = (tools.results ?? []).map(shape);
  const present = new Set(rows.map((t) => t.id));
  const accessories = new Map();
  for (const t of rows) {
    // An accessory whose parent is not on this list — retired, or gone — is
    // shown at the top rather than nested under nothing. Otherwise it would be
    // in the database and on no screen, which is the one outcome a register
    // must not have.
    if (t.parentToolId == null || !present.has(t.parentToolId)) continue;
    if (!accessories.has(t.parentToolId)) accessories.set(t.parentToolId, []);
    accessories.get(t.parentToolId).push(t);
  }
  const nested = new Set([...accessories.values()].flat().map((t) => t.id));

  return json({
    ready: true,
    graceHours: graceHours(settings),
    // Accessories are listed under their parent and not again at the top
    // level, so the store reads as the shelf looks: a drill, and with it the
    // things that live in its case.
    tools: rows
      .filter((t) => !nested.has(t.id))
      .map((t) => ({ ...t, accessories: accessories.get(t.id) ?? [] })),
    // Everything, flat, for the screens that need to find one tool by id
    // without walking the tree.
    all: rows,
  });
}

/** Everywhere one tool has been, newest first. */
export async function history(ctx, id) {
  const tool = await ctx.db.prepare('SELECT * FROM mx_tools WHERE id = ?').bind(Number(id)).first();
  if (!tool) throw notFound('That tool is not in the register.');

  const rows = await ctx.db.prepare(
    `SELECT m.*, a.name AS area_name
       FROM mx_tool_movements m
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

  const tool = await ctx.db.prepare('SELECT * FROM mx_tools WHERE id = ? AND active = 1')
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

  const due = dueBackAt(now, hours);
  let trip;
  try {
    trip = await ctx.db.prepare(
      `INSERT INTO mx_tool_movements (tool_id, area_id, issued_to, issued_by, issued_at, due_back_at, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id`,
    ).bind(toolId, areaId, issuedTo, ctx.session.user.name, now, due, note).first();
  } catch (err) {
    // The partial unique index. Somebody is trying to hand out a drill that is
    // already in a van, which is worth saying plainly rather than as a 500.
    if (/UNIQUE/i.test(String(err?.message ?? err))) {
      const held = await ctx.db.prepare(
        'SELECT issued_to FROM mx_tool_movements WHERE tool_id = ? AND returned_at IS NULL',
      ).bind(toolId).first();
      throw badRequest(`${tool.name} is already out${held?.issued_to ? ` with ${held.issued_to}` : ''}. `
        + 'Mark it returned before issuing it again.');
    }
    rethrowConstraint(err, { foreignKey: 'That room or area no longer exists.' });
    throw err;
  }

  // The accessories that go with it, each its own journey pointing back at the
  // parent's. One at a time rather than in a batch: a batch is all-or-nothing,
  // so a case somebody else already has would refuse the drill as well — and
  // the storeman standing at the counter would rather hand over the three that
  // are on the shelf and be told about the fourth.
  const wanted = Array.isArray(body.accessoryIds)
    ? [...new Set(body.accessoryIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50)
    : [];
  const took = [];
  const missed = [];

  if (wanted.length) {
    // Read back rather than trusting the list: an id that is not actually an
    // accessory of this tool would otherwise let one request issue anything in
    // the register under somebody else's name.
    const holes = wanted.map(() => '?').join(',');
    const rows = await ctx.db.prepare(
      `SELECT id, name FROM mx_tools
        WHERE parent_tool_id = ? AND active = 1 AND id IN (${holes})
        ORDER BY name`,
    ).bind(toolId, ...wanted).all();

    for (const a of rows.results ?? []) {
      try {
        await ctx.db.prepare(
          `INSERT INTO mx_tool_movements
             (tool_id, area_id, issued_to, issued_by, issued_at, due_back_at, note, with_movement_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(a.id, areaId, issuedTo, ctx.session.user.name, now, due, note, trip.id).run();
        took.push(a.name);
      } catch (err) {
        if (!/UNIQUE/i.test(String(err?.message ?? err))) throw err;
        const held = await ctx.db.prepare(
          'SELECT issued_to FROM mx_tool_movements WHERE tool_id = ? AND returned_at IS NULL',
        ).bind(a.id).first();
        missed.push(`${a.name} is already out${held?.issued_to ? ` with ${held.issued_to}` : ''}`);
      }
    }
  }

  await audit(ctx, 'mx.tool.issue', toolId, {
    issuedTo, areaId, accessories: took.length, missed: missed.length,
  });
  return json({
    ok: true, dueBackAt: due, movementId: trip.id, accessories: took, missed,
  }, { status: 201 });
}

/** Take it back in. */
export async function markReturned(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const toolId = Number(id);
  const returnNote = str(body.returnNote, 'Note', { max: 300, fallback: '' }) || null;

  const trip = await ctx.db.prepare(
    'SELECT * FROM mx_tool_movements WHERE tool_id = ? AND returned_at IS NULL',
  ).bind(toolId).first();
  if (!trip) throw badRequest('That tool is not out — there is nothing to return.');

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // What went out on this trip and has not come back. Offered as one act
  // because that is how it happens at the counter — the drill is handed over
  // with its case and its charger — while still leaving each accessory its own
  // row, so one that stays behind can be seen to have stayed behind.
  const alongside = await ctx.db.prepare(
    `SELECT m.id, t.name
       FROM mx_tool_movements m
       JOIN mx_tools t ON t.id = m.tool_id
      WHERE m.with_movement_id = ? AND m.returned_at IS NULL`,
  ).bind(trip.id).all().catch(() => ({ results: [] }));

  const alsoBack = body.withAccessories === false ? [] : (alongside.results ?? []);

  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE mx_tool_movements
          SET returned_at = ?1, received_by = ?2, return_note = ?3
        WHERE id = ?4 AND returned_at IS NULL`,
    ).bind(now, ctx.session.user.name, returnNote, trip.id),
    ...alsoBack.map((a) => ctx.db.prepare(
      `UPDATE mx_tool_movements
          SET returned_at = ?1, received_by = ?2, return_note = ?3
        WHERE id = ?4 AND returned_at IS NULL`,
    ).bind(now, ctx.session.user.name, returnNote, a.id)),
  ]);

  await audit(ctx, 'mx.tool.return', toolId, {
    issuedTo: trip.issued_to, accessories: alsoBack.length,
  });
  return json({
    ok: true,
    wasOverdue: Boolean(trip.overdue_notified_at),
    accessories: alsoBack.map((a) => a.name),
    // What is still out from this trip because somebody said not to take it
    // back. Named so the screen can say it rather than quietly showing fewer.
    stillOut: body.withAccessories === false
      ? (alongside.results ?? []).map((a) => a.name)
      : [],
  });
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
      `INSERT INTO mx_tools (name, tag, category_id, note)
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
      `UPDATE mx_tools SET name = ?2, tag = ?3, category_id = ?4, note = ?5
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
 * Say that one tool belongs with another — or that it no longer does.
 *
 * Both directions through one handler, because they are the same decision:
 * `parentId: null` puts an accessory back on the shelf as a tool in its own
 * right. Nothing about its journeys changes either way. A charger that spent
 * six months in a drill's case was still somewhere every day of them, and the
 * history says where.
 *
 * One level deep. A tool that already has accessories cannot become one, and
 * an accessory cannot take accessories of its own — which is the rule that
 * makes a cycle impossible rather than merely unlikely.
 */
export async function setParent(ctx, id) {
  const body = await readJson(ctx.request);
  const toolId = Number(id);
  const parentId = body.parentId == null || body.parentId === '' ? null : Number(body.parentId);

  const tool = await ctx.db.prepare('SELECT * FROM mx_tools WHERE id = ? AND active = 1')
    .bind(toolId).first();
  if (!tool) throw notFound('That tool is not in the register.');

  if (parentId == null) {
    await ctx.db.prepare('UPDATE mx_tools SET parent_tool_id = NULL WHERE id = ?').bind(toolId).run();
    await audit(ctx, 'mx.tool.detach', toolId, { name: tool.name });
    return json({ ok: true, parentToolId: null });
  }

  if (parentId === toolId) throw badRequest('A tool cannot be an accessory of itself.');

  const parent = await ctx.db.prepare('SELECT * FROM mx_tools WHERE id = ? AND active = 1')
    .bind(parentId).first();
  if (!parent) throw notFound('That tool is not in the register.');
  if (parent.parent_tool_id != null) {
    throw badRequest(`${parent.name} is itself an accessory of something. `
      + 'Accessories go one level deep, so pick the tool it all belongs to.');
  }

  const own = await ctx.db.prepare(
    'SELECT COUNT(*) AS n FROM mx_tools WHERE parent_tool_id = ? AND active = 1',
  ).bind(toolId).first();
  if ((own?.n ?? 0) > 0) {
    throw badRequest(`${tool.name} has accessories of its own, so it cannot become one. `
      + 'Detach those first.');
  }

  await ctx.db.prepare('UPDATE mx_tools SET parent_tool_id = ?2 WHERE id = ?1')
    .bind(toolId, parentId).run();
  await audit(ctx, 'mx.tool.attach', toolId, { name: tool.name, parent: parent.name });
  return json({ ok: true, parentToolId: parentId });
}

/**
 * Retire a tool rather than delete it.
 *
 * Its journeys are the record of who had what and when, and a broken drill
 * thrown in a skip does not make last month's trips untrue.
 */
export async function retire(ctx, id) {
  const out = await ctx.db.prepare(
    'SELECT issued_to FROM mx_tool_movements WHERE tool_id = ? AND returned_at IS NULL',
  ).bind(Number(id)).first();
  if (out) {
    throw badRequest(`That tool is still out with ${out.issued_to}. `
      + 'Mark it returned before retiring it.');
  }

  // Anything hanging off it goes back to being a tool in its own right. The
  // drill is in a skip; the charger is still on the shelf, and leaving it
  // pointing at a retired parent would take it off the list altogether —
  // present in the database, absent from every screen.
  const freed = await ctx.db.prepare(
    'SELECT COUNT(*) AS n FROM mx_tools WHERE parent_tool_id = ? AND active = 1',
  ).bind(Number(id)).first();

  const [result] = await ctx.db.batch([
    ctx.db.prepare('UPDATE mx_tools SET active = 0 WHERE id = ? AND active = 1').bind(Number(id)),
    ctx.db.prepare('UPDATE mx_tools SET parent_tool_id = NULL WHERE parent_tool_id = ?').bind(Number(id)),
  ]);
  if (!result.meta?.changes) throw notFound('That tool has already been retired.');

  await audit(ctx, 'mx.tool.retire', id, { freed: freed?.n ?? 0 });
  return json({ ok: true, retired: true, freed: freed?.n ?? 0 });
}
