import { HttpError, badRequest, json } from '../lib/http.js';
import { verifyLink } from '../lib/link.js';
import { loadDataset, monthlyInsights, stockReport, weeklyInsights } from '../lib/analytics.js';
import { addDays, isDay, isMonth, monthBounds, startOfWeek, todayIn } from '../util/dates.js';
import { round } from '../util/stats.js';

const PATH = '/api/link/report';
const SUPPLIERS_PATH = '/api/link/suppliers';

/**
 * The breakfast unit's part of the group's management report: a week or a
 * month, as this app's own Week and Month reports have it, with the stock as
 * it stood at the end of it (or today, for a period still running), what was
 * delivered by supplier and what the bakery made.
 *
 *   { period: 'week', week: 'YYYY-MM-DD' }   any day in the week
 *   { period: 'month', month: 'YYYY-MM' }
 *
 * Signed by Insight (see lib/link.js). Read only.
 */
export async function report(ctx) {
  const bodyText = await ctx.request.text();
  const signed = await verifyLink(ctx.env.INSIGHT_SSO_SECRET || '', {
    at: ctx.request.headers.get('X-Till-At'), sig: ctx.request.headers.get('X-Till-Sig'), path: PATH, bodyText,
  });
  if (!signed) throw new HttpError(401, 'Only Insight may ask for this, and it signs what it asks.');
  let body = {};
  try { body = JSON.parse(bodyText || '{}'); } catch { throw badRequest('Not JSON.'); }

  const ds = await loadDataset(ctx.db);
  const today = todayIn(ds.timezone);
  let insights;
  let from;
  let to;
  if (body.period === 'month') {
    if (!isMonth(body.month)) throw badRequest('Which month? YYYY-MM.');
    insights = monthlyInsights(ds, body.month);
    ({ from, to } = monthBounds(body.month));
  } else {
    if (!isDay(body.week)) throw badRequest('Which week? Any day in it, YYYY-MM-DD.');
    from = startOfWeek(body.week);
    to = addDays(from, 6);
    insights = weeklyInsights(ds, from);
  }
  // A period still running: the stock as it is now.
  const asOf = to < today ? to : today;
  const stock = stockReport(ds, asOf);

  // Deliveries by supplier, and the bakery's output, in the period.
  const suppliers = new Map();
  for (const p of ds.purchases || []) {
    if (p.day < from || p.day > to) continue;
    const name = String(p.supplier || '').trim() || 'No supplier named';
    suppliers.set(name, (suppliers.get(name) || 0) + (Number(p.qty) || 0) * (Number(p.unit_cost) || 0));
  }
  const baked = (ds.production || []).filter((p) => p.day >= from && p.day <= to);

  // The days a breakfast was due and nobody recorded it.
  const lastDue = to < today ? to : addDays(today, -1);
  const missing = [];
  for (let d = from; d <= lastDue; d = addDays(d, 1)) if (!ds.serviceByDay.get(d)?.submitted_at) missing.push(d);

  return json({
    ok: true,
    period: body.period === 'month' ? 'month' : 'week',
    from,
    to,
    currency: ds.currency,
    insights,
    stock: {
      asOf: stock.asOf,
      totalValue: stock.totalValue,
      reorder: stock.reorder.slice(0, 25),
      shrinkage: stock.shrinkage.slice(0, 15),
    },
    suppliers: [...suppliers].map(([name, value]) => ({ name, value: round(value, 2) })).sort((a, b) => b.value - a.value),
    bakery: { runs: baked.length, qty: round(baked.reduce((t, p) => t + (Number(p.qty) || 0), 0), 2), value: round(baked.reduce((t, p) => t + (Number(p.qty) || 0) * (Number(p.unit_cost) || 0), 0), 2) },
    missingDays: missing,
  });
}

/**
 * The supplier list, from Insight. Odoo's suppliers that are not hidden there,
 * key suppliers first: each is added or brought up to date by its Odoo id (or
 * matched by name the first time), and one Insight no longer sends is retired,
 * its deliveries keeping their name. Suppliers added here by hand (no Odoo id)
 * are left as they are.
 *
 *   { suppliers: [{ odooId, name, phone, key, group }] }
 *
 * Signed by Insight, like the report.
 */
export async function suppliers(ctx) {
  const bodyText = await ctx.request.text();
  const signed = await verifyLink(ctx.env.INSIGHT_SSO_SECRET || '', {
    at: ctx.request.headers.get('X-Till-At'), sig: ctx.request.headers.get('X-Till-Sig'), path: SUPPLIERS_PATH, bodyText,
  });
  if (!signed) throw new HttpError(401, 'Only Insight may send this, and it signs what it sends.');
  let body = {};
  try { body = JSON.parse(bodyText || '{}'); } catch { throw badRequest('Not JSON.'); }
  const list = (Array.isArray(body.suppliers) ? body.suppliers : [])
    .map((s) => ({ odooId: Number(s?.odooId), name: String(s?.name || '').trim().slice(0, 120), phone: s?.phone ? String(s.phone).slice(0, 40) : null, key: s?.key ? 1 : 0, group: s?.group ? String(s.group).slice(0, 60) : null }))
    .filter((s) => Number.isInteger(s.odooId) && s.odooId > 0 && s.name);
  if (list.length > 5000) throw badRequest('That is more suppliers than this app takes at once.');

  const rows = (await ctx.db.prepare('SELECT id, name, odoo_id FROM suppliers').all()).results ?? [];
  const byOdoo = new Map(rows.filter((r) => r.odoo_id != null).map((r) => [Number(r.odoo_id), r]));
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  let added = 0;
  let updated = 0;
  // Key suppliers first in the pick list, in the order Insight sends them.
  for (const [i, s] of list.entries()) {
    const sort = s.key ? 10 + i : 1000 + i;
    const mine = byOdoo.get(s.odooId) || byName.get(s.name.toLowerCase());
    if (mine) {
      // A rename in Odoo that collides with a name already here keeps the old name.
      const clash = byName.get(s.name.toLowerCase());
      const name = clash && clash.id !== mine.id ? mine.name : s.name;
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare(`UPDATE suppliers SET name = ?, odoo_id = ?, key_supplier = ?, grp = ?, phone = COALESCE(?, phone), active = 1, sort_order = ? WHERE id = ?`)
        .bind(name, s.odooId, s.key, s.group, s.phone, sort, mine.id).run();
      updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await ctx.db.prepare('INSERT INTO suppliers (name, phone, odoo_id, key_supplier, grp, active, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(s.name, s.phone, s.odooId, s.key, s.group, sort).run();
      byName.set(s.name.toLowerCase(), { id: -1, name: s.name });
      added += 1;
    }
  }
  const sent = new Set(list.map((s) => s.odooId));
  let retired = 0;
  for (const r of rows.filter((x) => x.odoo_id != null && !sent.has(Number(x.odoo_id)))) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.db.prepare('UPDATE suppliers SET active = 0, key_supplier = 0 WHERE id = ?').bind(r.id).run();
    retired += 1;
  }
  return json({ ok: true, count: list.length, added, updated, retired });
}
