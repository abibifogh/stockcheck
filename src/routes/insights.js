import { badRequest, csvResponse, json } from '../lib/http.js';
import {
  dailyInsights, loadDataset, monthlyInsights, stockReport, weeklyInsights,
} from '../lib/analytics.js';
import { isDay, isMonth, monthOf, startOfWeek, todayIn } from '../util/dates.js';

export async function daily(ctx) {
  const ds = await loadDataset(ctx.db);
  const day = ctx.url.searchParams.get('day') || ds.recordedDays.at(-1) || todayIn(ds.timezone);
  if (!isDay(day)) throw badRequest('Invalid date');
  return json(dailyInsights(ds, day));
}

export async function weekly(ctx) {
  const ds = await loadDataset(ctx.db);
  const anchor = ctx.url.searchParams.get('week') || ds.recordedDays.at(-1) || todayIn(ds.timezone);
  if (!isDay(anchor)) throw badRequest('Invalid date');
  return json(weeklyInsights(ds, startOfWeek(anchor)));
}

export async function monthly(ctx) {
  const ds = await loadDataset(ctx.db);
  const month = ctx.url.searchParams.get('month')
    || monthOf(ds.recordedDays.at(-1) || todayIn(ds.timezone));
  if (!isMonth(month)) throw badRequest('Invalid month, expected YYYY-MM');
  return json(monthlyInsights(ds, month));
}

export async function stock(ctx) {
  const ds = await loadDataset(ctx.db);
  const asOf = ctx.url.searchParams.get('asOf') || todayIn(ds.timezone);
  if (!isDay(asOf)) throw badRequest('Invalid date');
  return json(stockReport(ds, asOf));
}

/**
 * Headline numbers for the landing screen: where the operation stands right
 * now, plus anything that needs a decision today.
 */
export async function overview(ctx) {
  const ds = await loadDataset(ctx.db);
  const today = todayIn(ds.timezone);
  const latest = ds.recordedDays.at(-1) || today;

  const day = dailyInsights(ds, latest);
  const week = weeklyInsights(ds, startOfWeek(latest));
  const month = monthlyInsights(ds, monthOf(latest));
  const stockNow = stockReport(ds, today);

  return json({
    today,
    latestDay: latest,
    todayRecorded: ds.serviceByDay.has(today),
    currency: ds.currency,
    propertyName: ds.settings.property_name || 'Breakfast Unit',
    headline: {
      guests: day.today.guests,
      cost: day.today.cost,
      costPerGuest: day.today.costPerGuest,
      revenue: day.today.revenue,
      weekCost: week.current.cost,
      weekGuests: week.current.guests,
      weekCostPerGuest: week.current.costPerGuest,
      weekCostDeltaPct: week.deltas.cost,
      weekCostPerGuestDeltaPct: week.deltas.costPerGuest,
      monthCost: month.current.cost,
      monthGuests: month.current.guests,
      monthCostPerGuest: month.current.costPerGuest,
      monthRevenue: month.current.revenue,
      stockValue: stockNow.totalValue,
      reorderCount: stockNow.reorder.length,
    },
    alerts: [
      ...day.alerts.slice(0, 6),
      ...stockNow.reorder.slice(0, 5).map((r) => ({
        level: r.status === 'negative' ? 'high' : 'warn',
        kind: 'stock',
        title: r.status === 'negative'
          ? `${r.name} shows negative stock`
          : `${r.name} below par`,
        detail: r.status === 'negative'
          ? `Book stock is ${r.stock} ${r.unit} — a delivery was probably never recorded.`
          : `${r.stock} ${r.unit} on hand against a par of ${r.parLevel} ${r.unit}. About ${r.daysCover ?? '—'} days of cover.`,
      })),
    ],
    trend: day.trend.slice(-21),
    weekSeries: week.series,
  });
}

export async function exportCsv(ctx) {
  const type = ctx.url.searchParams.get('type') || 'daily';
  const ds = await loadDataset(ctx.db);
  const from = ctx.url.searchParams.get('from') || ds.recordedDays[0] || todayIn(ds.timezone);
  const to = ctx.url.searchParams.get('to') || ds.recordedDays.at(-1) || todayIn(ds.timezone);
  if (!isDay(from) || !isDay(to)) throw badRequest('Invalid date range');

  const days = ds.recordedDays.filter((d) => d >= from && d <= to);

  if (type === 'daily') {
    const rows = [[
      'Date', 'Weekday', 'In-house', 'Outside', 'Total guests',
      `Food cost (${ds.currency})`, `Cost per guest (${ds.currency})`,
      `Outsider revenue (${ds.currency})`, 'Line items', 'Note',
    ]];
    for (const day of days) {
      const insight = dailyInsights(ds, day);
      const t = insight.today;
      rows.push([
        day, insight.weekday, t.inhouse, t.outside, t.guests,
        t.cost, t.costPerGuest ?? '', t.revenue, insight.lines.length, t.note ?? '',
      ]);
    }
    return csvResponse(`breakfast-daily-${from}-to-${to}.csv`, rows);
  }

  if (type === 'usage') {
    const rows = [['Date', 'Category', 'Ingredient', 'Unit', 'Quantity', 'Per guest', `Cost (${ds.currency})`, 'Guests']];
    for (const day of days) {
      const m = ds.usageByDay.get(day);
      if (!m) continue;
      const guests = (ds.serviceByDay.get(day)?.inhouse_guests ?? 0) + (ds.serviceByDay.get(day)?.outside_guests ?? 0);
      for (const [ingredientId, qty] of m) {
        const ing = ds.ingredientById.get(ingredientId);
        if (!ing) continue;
        rows.push([
          day,
          ds.categoryById.get(ing.category_id)?.name ?? '',
          ing.name, ing.unit, qty,
          guests ? (qty / guests).toFixed(4) : '',
          ds.ledger.cost(ingredientId, day).toFixed(2),
          guests,
        ]);
      }
    }
    return csvResponse(`breakfast-usage-${from}-to-${to}.csv`, rows);
  }

  if (type === 'purchases') {
    const rows = [['Date', 'Category', 'Ingredient', 'Unit', 'Quantity', `Unit cost (${ds.currency})`, `Total (${ds.currency})`, 'Supplier', 'Note']];
    for (const p of ds.purchases.filter((p) => p.day >= from && p.day <= to)) {
      const ing = ds.ingredientById.get(p.ingredient_id);
      rows.push([
        p.day,
        ing ? ds.categoryById.get(ing.category_id)?.name ?? '' : '',
        ing?.name ?? `#${p.ingredient_id}`,
        ing?.unit ?? '', p.qty, p.unit_cost,
        (Number(p.qty) * Number(p.unit_cost)).toFixed(2),
        p.supplier ?? '', p.note ?? '',
      ]);
    }
    return csvResponse(`breakfast-purchases-${from}-to-${to}.csv`, rows);
  }

  if (type === 'stock') {
    const report = stockReport(ds, to);
    const rows = [['Ingredient', 'Category', 'Unit', 'Book stock', 'Par level', `Unit cost (${ds.currency})`, `Value (${ds.currency})`, 'Avg daily use', 'Days cover', 'Status']];
    for (const r of report.rows) {
      rows.push([
        r.name, r.categoryName, r.unit, r.stock, r.parLevel,
        r.unitCost, r.value, r.avgDailyUse, r.daysCover ?? '', r.status,
      ]);
    }
    return csvResponse(`breakfast-stock-${to}.csv`, rows);
  }

  throw badRequest('Unknown export type. Use daily, usage, purchases or stock.');
}
