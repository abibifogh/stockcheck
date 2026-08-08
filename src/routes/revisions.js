import { badRequest, bool, json, notFound, readJson, str } from '../lib/http.js';
import { assertDayWritable } from '../lib/locks.js';

/**
 * Approving changes to a day that was already submitted.
 *
 * The point is that agreed figures do not move quietly. A cook correcting
 * yesterday's sheet is usually right — but "usually" is not good enough once
 * the numbers have been reported on, so somebody signs it off.
 */

function parse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** Build a readable comparison so a reviewer is not diffing raw JSON. */
function buildDiff(proposed, previous, ingredientsById) {
  const changes = [];

  const guestFields = [
    ['inhouse_guests', 'In-house guests'],
    ['outside_guests', 'Outside guests'],
  ];
  for (const [key, label] of guestFields) {
    const before = Number(previous[key]) || 0;
    const after = Number(proposed[key]) || 0;
    if (before !== after) changes.push({ kind: 'guests', label, before, after, unit: 'guests' });
  }

  if ((previous.note ?? '') !== (proposed.note ?? '')) {
    changes.push({ kind: 'note', label: 'Note', before: previous.note ?? '—', after: proposed.note ?? '—' });
  }

  const ids = new Set([
    ...Object.keys(proposed.usage ?? {}),
    ...Object.keys(previous.usage ?? {}),
  ].map(Number));

  for (const id of ids) {
    const before = previous.usage?.[id];
    const after = proposed.usage?.[id];
    const beforeNum = before == null ? null : Number(before);
    const afterNum = after == null ? null : Number(after);
    if (beforeNum === afterNum) continue;

    const ing = ingredientsById.get(id);
    changes.push({
      kind: 'usage',
      ingredientId: id,
      label: ing?.name ?? `Ingredient ${id}`,
      unit: ing?.unit ?? '',
      before: beforeNum,
      after: afterNum,
      delta: afterNum != null && beforeNum != null ? Math.round((afterNum - beforeNum) * 1000) / 1000 : null,
    });
  }

  changes.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  return changes;
}

export async function listRevisions(ctx) {
  const status = ctx.url.searchParams.get('status') || 'pending';
  if (!['pending', 'approved', 'rejected', 'superseded', 'all'].includes(status)) {
    throw badRequest('Unknown status filter');
  }

  const rows = status === 'all'
    ? await ctx.db.prepare('SELECT * FROM day_revisions ORDER BY submitted_at DESC LIMIT 100').all()
    : await ctx.db.prepare('SELECT * FROM day_revisions WHERE status = ? ORDER BY submitted_at DESC LIMIT 100')
      .bind(status).all();

  const ingredients = await ctx.db.prepare('SELECT id, name, unit FROM ingredients').all();
  const byId = new Map((ingredients.results ?? []).map((i) => [i.id, i]));

  return json({
    revisions: (rows.results ?? []).map((r) => {
      const proposed = parse(r.payload);
      const previous = parse(r.previous);
      return {
        id: r.id,
        day: r.day,
        status: r.status,
        submittedBy: r.submitted_by,
        submittedAt: r.submitted_at,
        reviewedBy: r.reviewed_by,
        reviewedAt: r.reviewed_at,
        reviewNote: r.review_note,
        changes: buildDiff(proposed, previous, byId),
      };
    }),
  });
}

export async function reviewRevision(ctx, id) {
  const body = await readJson(ctx.request);
  const approve = bool(body.approve, false);
  const note = str(body.note, 'Note', { max: 500 });

  const revision = await ctx.db.prepare('SELECT * FROM day_revisions WHERE id = ?').bind(id).first();
  if (!revision) throw notFound('That change request no longer exists');
  if (revision.status !== 'pending') {
    throw badRequest(`This request was already ${revision.status}.`);
  }

  const reviewer = `${ctx.session.user.name} (${ctx.session.user.role})`;

  if (!approve) {
    await ctx.db.batch([
      ctx.db.prepare(
        "UPDATE day_revisions SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?",
      ).bind(reviewer, note, id),
      ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
        .bind(reviewer, 'revision.reject', revision.day, JSON.stringify({ id, note })),
    ]);
    return json({ ok: true, status: 'rejected', day: revision.day });
  }

  // A period locked between proposal and approval still wins.
  await assertDayWritable(ctx.db, revision.day);

  const payload = parse(revision.payload);
  const usage = payload.usage ?? {};
  const cleared = Array.isArray(payload.cleared) ? payload.cleared : [];

  const statements = [
    ctx.db.prepare(
      `INSERT INTO service_days (day, inhouse_guests, outside_guests, outsider_fee, note, submitted_at, submitted_by, updated_at)
       VALUES (?1, ?2, ?3, COALESCE((SELECT outsider_fee FROM service_days WHERE day = ?1), 0), ?4, datetime('now'), ?5, datetime('now'))
       ON CONFLICT(day) DO UPDATE SET
         inhouse_guests = ?2,
         outside_guests = ?3,
         note           = ?4,
         submitted_at   = datetime('now'),
         submitted_by   = ?5,
         updated_at     = datetime('now')`,
    ).bind(
      revision.day,
      Number(payload.inhouse_guests) || 0,
      Number(payload.outside_guests) || 0,
      payload.note ?? null,
      revision.submitted_by,
    ),
  ];

  for (const [rawId, qty] of Object.entries(usage)) {
    statements.push(
      ctx.db.prepare(
        `INSERT INTO usage (day, ingredient_id, qty, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(day, ingredient_id) DO UPDATE SET qty = ?3, updated_at = datetime('now')`,
      ).bind(revision.day, Number(rawId), Number(qty) || 0),
    );
  }
  for (const rawId of cleared) {
    statements.push(
      ctx.db.prepare('DELETE FROM usage WHERE day = ? AND ingredient_id = ?')
        .bind(revision.day, Number(rawId)),
    );
  }

  statements.push(
    ctx.db.prepare(
      "UPDATE day_revisions SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ? WHERE id = ?",
    ).bind(reviewer, note, id),
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
      .bind(reviewer, 'revision.approve', revision.day, JSON.stringify({ id, lines: Object.keys(usage).length })),
  );

  await ctx.db.batch(statements);

  return json({ ok: true, status: 'approved', day: revision.day });
}

/** Badge count for the navigation. */
export async function pendingCount(ctx) {
  const row = await ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM day_revisions WHERE status = 'pending'",
  ).first();
  return json({ pending: row?.n ?? 0 });
}
