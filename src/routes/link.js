import { HttpError, badRequest, json } from '../lib/http.js';
import { verifyLink } from '../lib/link.js';
import { loadDataset, monthlyInsights, stockReport, weeklyInsights } from '../lib/analytics.js';
import { addDays, isDay, isMonth, monthBounds, startOfWeek, todayIn } from '../util/dates.js';
import { round } from '../util/stats.js';

const PATH = '/api/link/report';

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
