import { badRequest, bool, int, json, num, readJson, str } from '../lib/http.js';
import { entryHints, loadDataset } from '../lib/analytics.js';
import { isDay, todayIn } from '../util/dates.js';

/**
 * The day sheet: guest counts plus one quantity per ingredient.
 * GET returns the saved sheet alongside the "usual" hints that let a cook fill
 * the whole form with a couple of taps.
 */
export async function getDay(ctx, day) {
  if (!isDay(day)) throw badRequest('Invalid date');
  const { db } = ctx;

  const [service, usage] = await Promise.all([
    db.prepare('SELECT * FROM service_days WHERE day = ?').bind(day).first(),
    db.prepare('SELECT ingredient_id, qty FROM usage WHERE day = ?').bind(day).all(),
  ]);

  const ds = await loadDataset(db);
  const guests = (Number(service?.inhouse_guests) || 0) + (Number(service?.outside_guests) || 0);

  return json({
    day,
    today: todayIn(ds.timezone),
    service: service ?? {
      day,
      inhouse_guests: null,
      outside_guests: null,
      outsider_fee: Number(ds.settings.default_outsider_fee) || 0,
      note: null,
      submitted_at: null,
    },
    usage: Object.fromEntries((usage.results ?? []).map((r) => [r.ingredient_id, r.qty])),
    hints: entryHints(ds, day, guests),
  });
}

/**
 * Save (or re-save) a day sheet. The whole sheet is written in one batch so a
 * dropped connection never leaves half a morning recorded.
 *
 * Quantities are upserted, not replaced wholesale: sending `null` for an item
 * removes it, which is how "I keyed that by mistake" is expressed. Items simply
 * absent from the payload are left untouched, so two cooks can save different
 * sections without clobbering each other.
 */
export async function saveDay(ctx, day) {
  if (!isDay(day)) throw badRequest('Invalid date');
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  const inhouse = int(body.inhouse_guests, 'In-house guests', { min: 0, max: 100000, fallback: 0 });
  const outside = int(body.outside_guests, 'Outside guests', { min: 0, max: 100000, fallback: 0 });
  const fee = num(body.outsider_fee, 'Outsider fee', { min: 0, max: 1e6, fallback: 0 });
  const note = str(body.note, 'Note', { max: 1000 });
  const submit = bool(body.submit, false);

  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  const entries = Object.entries(usage);
  if (entries.length > 1000) throw badRequest('Too many line items in one save');

  const validIds = new Set(
    ((await db.prepare('SELECT id FROM ingredients').all()).results ?? []).map((r) => r.id),
  );

  const statements = [
    db.prepare(
      `INSERT INTO service_days (day, inhouse_guests, outside_guests, outsider_fee, note, submitted_at, submitted_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?6 = 1 THEN datetime('now') ELSE NULL END, ?7, datetime('now'))
       ON CONFLICT(day) DO UPDATE SET
         inhouse_guests = ?2,
         outside_guests = ?3,
         outsider_fee   = ?4,
         note           = ?5,
         submitted_at   = CASE WHEN ?6 = 1 THEN datetime('now') ELSE service_days.submitted_at END,
         submitted_by   = CASE WHEN ?6 = 1 THEN ?7 ELSE service_days.submitted_by END,
         updated_at     = datetime('now')`,
    ).bind(day, inhouse, outside, fee, note, submit ? 1 : 0, session.role),
  ];

  let written = 0;
  let cleared = 0;
  for (const [rawId, rawQty] of entries) {
    const ingredientId = Number(rawId);
    if (!validIds.has(ingredientId)) continue;

    if (rawQty === null || rawQty === '') {
      statements.push(
        db.prepare('DELETE FROM usage WHERE day = ? AND ingredient_id = ?').bind(day, ingredientId),
      );
      cleared += 1;
      continue;
    }

    const qty = num(rawQty, `Quantity for ingredient ${ingredientId}`, { min: 0, max: 1e6 });
    statements.push(
      db.prepare(
        `INSERT INTO usage (day, ingredient_id, qty, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(day, ingredient_id) DO UPDATE SET qty = ?3, updated_at = datetime('now')`,
      ).bind(day, ingredientId, qty),
    );
    written += 1;
  }

  statements.push(
    db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      session.role,
      submit ? 'day.submit' : 'day.save',
      day,
      JSON.stringify({ inhouse, outside, lines: written, cleared }),
    ),
  );

  await db.batch(statements);

  return json({ ok: true, day, saved: written, cleared, submitted: submit });
}

/** Recent day sheets, for the "recent entries" strip on the entry screen. */
export async function listDays(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 30, 200);
  const rows = await ctx.db.prepare(
    `SELECT s.day, s.inhouse_guests, s.outside_guests, s.submitted_at,
            (SELECT COUNT(*) FROM usage u WHERE u.day = s.day) AS lines
     FROM service_days s
     ORDER BY s.day DESC
     LIMIT ?`,
  ).bind(limit).all();
  return json({ days: rows.results ?? [] });
}
