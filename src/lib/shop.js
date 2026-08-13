import { buildLedger } from './ledger.js';
import { pctChange, round, sum } from '../util/stats.js';
import { addDays, diffDays, rangeDays } from '../util/dates.js';

/**
 * The craft shop: what was sold, for how much, and what it had cost you.
 *
 * This is the first store in the system that takes money, and that changes the
 * shape of every report. Breakfast and maintenance measure spend; the shop
 * measures the gap between what a thing cost and what somebody paid for it. So
 * revenue, cost of goods and margin are computed together on every path — a
 * takings figure with no margin beside it is the number that lets a shop sell
 * hard all season and still lose money.
 *
 * Costing is the same weighted-average ledger as the other two stores. Selling
 * price is not costed at all: it is copied onto the sale line when the sale
 * happens, because what somebody was charged is a fact about that afternoon and
 * must survive the price list changing.
 */

const BASELINE_DAYS = 90;

export async function loadDataset(db) {
  const [categories, items, sales, lines, purchases, counts, settings] = await Promise.all([
    db.prepare('SELECT * FROM shop_categories ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM shop_items ORDER BY name').all(),
    db.prepare('SELECT * FROM shop_sales ORDER BY day, id').all(),
    db.prepare(
      `SELECT l.*, s.day, s.voided, s.payment_method
         FROM shop_sale_lines l JOIN shop_sales s ON s.id = l.sale_id
        ORDER BY s.day, l.id`,
    ).all(),
    db.prepare('SELECT * FROM shop_purchases ORDER BY day, id').all(),
    db.prepare('SELECT * FROM shop_counts ORDER BY day').all(),
    db.prepare('SELECT key, value FROM settings').all(),
  ]);

  return makeDataset({
    categories: categories.results ?? [],
    items: items.results ?? [],
    sales: sales.results ?? [],
    lines: lines.results ?? [],
    purchases: purchases.results ?? [],
    counts: counts.results ?? [],
    settings: settings.results ?? [],
  });
}

export function makeDataset(raw) {
  const settings = Object.fromEntries((raw.settings ?? []).map((r) => [r.key, r.value]));
  const items = raw.items ?? [];

  // A voided sale never happened: it did not take money and it did not take
  // anything off the shelf. Filtered once, here, so no report has to remember.
  const lines = (raw.lines ?? []).filter((l) => !Number(l.voided));
  const sales = (raw.sales ?? []).filter((s) => !Number(s.voided));

  const ledger = buildLedger({
    ingredients: items.map((i) => ({
      id: i.id,
      opening_stock: i.opening_stock,
      default_unit_cost: i.default_unit_cost,
    })),
    purchases: (raw.purchases ?? []).map((p) => ({
      day: p.day, ingredient_id: p.item_id, qty: p.qty, unit_cost: p.unit_cost,
    })),
    usage: lines.map((l) => ({ day: l.day, ingredient_id: l.item_id, qty: l.qty })),
    counts: (raw.counts ?? [])
      .filter((c) => c.status === 'approved')
      .map((c) => ({ day: c.day, ingredient_id: c.item_id, qty: c.counted_qty })),
  });

  // day -> item -> qty sold. Walked once; wanted by nearly every report.
  const soldByDay = new Map();
  for (const line of lines) {
    if (!soldByDay.has(line.day)) soldByDay.set(line.day, new Map());
    const perItem = soldByDay.get(line.day);
    perItem.set(line.item_id, (perItem.get(line.item_id) ?? 0) + Number(line.qty || 0));
  }

  return {
    settings,
    currency: settings.currency || 'GHS',
    timezone: settings.timezone || 'Africa/Accra',
    shopName: settings.shop_name || 'Craft Shop',
    lowCoverDays: Number(settings.shop_low_cover_days) || 21,
    categories: raw.categories ?? [],
    categoryById: new Map((raw.categories ?? []).map((c) => [c.id, c])),
    items,
    itemById: new Map(items.map((i) => [i.id, i])),
    sales,
    lines,
    purchases: raw.purchases ?? [],
    counts: raw.counts ?? [],
    recordedDays: [...new Set(sales.map((s) => s.day))].sort(),
    soldByDay,
    ledger,
  };
}

/** What one sold line cost you, at the unit cost in force on the day it went. */
export function lineCost(ds, line) {
  return round(Number(line.qty || 0) * ds.ledger.unitCostOn(line.item_id, line.day), 2);
}

function linesIn(ds, from, to) {
  return ds.lines.filter((l) => l.day >= from && l.day <= to);
}

function salesIn(ds, from, to) {
  return ds.sales.filter((s) => s.day >= from && s.day <= to);
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

/**
 * Revenue, cost and margin for a set of lines.
 *
 * Margin is reported both ways on purpose. The cash figure is what the shop
 * actually made; the percentage is what tells you whether a strong month was
 * strong trading or just a lot of low-margin volume.
 */
export function totals(ds, lines, sales) {
  const revenue = sum(lines.map((l) => Number(l.line_total || 0)));
  const cost = sum(lines.map((l) => lineCost(ds, l)));
  const units = sum(lines.map((l) => Number(l.qty || 0)));

  const cash = sum(sales.filter((s) => s.payment_method === 'cash').map((s) => Number(s.total || 0)));
  const card = sum(sales.filter((s) => s.payment_method === 'card').map((s) => Number(s.total || 0)));

  return {
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    margin: round(revenue - cost, 2),
    marginPct: revenue > 0 ? round(((revenue - cost) / revenue) * 100, 1) : null,
    units: round(units, 3),
    saleCount: sales.length,
    averageSale: sales.length ? round(revenue / sales.length, 2) : 0,
    cash: round(cash, 2),
    card: round(card, 2),
  };
}

/** One row per product sold in the window, best first. */
export function byItem(ds, from, to) {
  const lines = linesIn(ds, from, to);
  const grouped = new Map();

  for (const line of lines) {
    if (!grouped.has(line.item_id)) {
      grouped.set(line.item_id, { itemId: line.item_id, qty: 0, revenue: 0, cost: 0, sales: new Set() });
    }
    const row = grouped.get(line.item_id);
    row.qty += Number(line.qty || 0);
    row.revenue += Number(line.line_total || 0);
    row.cost += lineCost(ds, line);
    row.sales.add(line.sale_id);
  }

  return [...grouped.values()].map((row) => {
    const item = ds.itemById.get(row.itemId);
    const margin = row.revenue - row.cost;
    return {
      itemId: row.itemId,
      name: item?.name ?? 'Removed product',
      unit: item?.unit ?? 'pcs',
      attributes: item?.attributes ?? null,
      categoryName: ds.categoryById.get(item?.category_id)?.name ?? 'Uncategorised',
      qty: round(row.qty, 3),
      revenue: round(row.revenue, 2),
      cost: round(row.cost, 2),
      margin: round(margin, 2),
      marginPct: row.revenue > 0 ? round((margin / row.revenue) * 100, 1) : null,
      transactions: row.sales.size,
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** Revenue and margin by category, for "what actually sells here". */
export function byCategory(ds, from, to) {
  const rows = byItem(ds, from, to);
  const grouped = new Map();

  for (const row of rows) {
    if (!grouped.has(row.categoryName)) {
      grouped.set(row.categoryName, { name: row.categoryName, revenue: 0, cost: 0, qty: 0, lines: 0 });
    }
    const group = grouped.get(row.categoryName);
    group.revenue += row.revenue;
    group.cost += row.cost;
    group.qty += row.qty;
    group.lines += 1;
  }

  const total = sum([...grouped.values()].map((g) => g.revenue));
  return [...grouped.values()].map((g) => ({
    name: g.name,
    revenue: round(g.revenue, 2),
    cost: round(g.cost, 2),
    margin: round(g.revenue - g.cost, 2),
    marginPct: g.revenue > 0 ? round(((g.revenue - g.cost) / g.revenue) * 100, 1) : null,
    qty: round(g.qty, 3),
    products: g.lines,
    shareOfRevenue: total > 0 ? round((g.revenue / total) * 100, 1) : 0,
  })).sort((a, b) => b.revenue - a.revenue);
}

/** Takings day by day, for the chart and the daily-takings table. */
export function daily(ds, from, to) {
  return rangeDays(from, to).map((day) => {
    const dayLines = ds.lines.filter((l) => l.day === day);
    const daySales = ds.sales.filter((s) => s.day === day);
    const t = totals(ds, dayLines, daySales);
    return { day, ...t };
  });
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * What is on the shelf, what to reorder, and what has been sitting there.
 *
 * Cover is measured over 90 days: craft stock turns over slowly, and a hotel
 * shop that sells two carvings a month is not a shop in trouble.
 */
export function stockReport(ds, asOf) {
  const from = addDays(asOf, -BASELINE_DAYS);
  const window = ds.recordedDays.filter((d) => d > from && d <= asOf);
  const span = Math.max(1, Math.min(BASELINE_DAYS, window.length ? diffDays(window[0], asOf) + 1 : 1));

  const rows = ds.items.filter((i) => i.active).map((item) => {
    const stock = ds.ledger.stockOn(item.id, asOf);
    const unitCost = ds.ledger.unitCostOn(item.id, asOf);
    const sold = sum(window.map((d) => ds.soldByDay.get(d)?.get(item.id) ?? 0));
    const dailyRate = sold / span;
    const daysCover = dailyRate > 1e-9 ? round(stock / dailyRate, 0) : null;
    const par = Number(item.par_level) || 0;
    const sellPrice = Number(item.sell_price) || 0;

    // Anything not yet decided is waiting, including a row written before the
    // approval step existed. A count that fell through a gap must show as
    // waiting, never disappear.
    const pending = ds.counts
      .filter((c) => c.item_id === item.id && c.day <= asOf
        && c.status !== 'approved' && c.status !== 'rejected')
      .at(-1);
    const approved = ds.counts
      .filter((c) => c.item_id === item.id && c.day <= asOf && c.status === 'approved')
      .at(-1);

    const variance = pending ? round(Number(pending.counted_qty) - stock, 3) : null;

    let status = 'ok';
    if (stock < 0) status = 'negative';
    else if (par > 0 && stock < par) status = 'below_par';
    else if (daysCover != null && daysCover < ds.lowCoverDays) status = 'low_cover';

    return {
      itemId: item.id,
      name: item.name,
      sku: item.sku ?? null,
      unit: item.unit,
      attributes: item.attributes ?? null,
      categoryId: item.category_id,
      categoryName: ds.categoryById.get(item.category_id)?.name ?? 'Uncategorised',
      stock: round(stock, 3),
      parLevel: par,
      unitCost: round(unitCost, 2),
      sellPrice,
      // What the shelf is worth at cost, and what it would bring in if it all
      // sold at the current price. A shop needs both: one is the money tied up,
      // the other is what the season is worth.
      value: round(stock * unitCost, 2),
      retailValue: round(stock * sellPrice, 2),
      marginPct: sellPrice > 0 ? round(((sellPrice - unitCost) / sellPrice) * 100, 1) : null,
      sold90: round(sold, 3),
      avgDailySales: round(dailyRate, 4),
      daysCover,
      suggestedOrder: par > 0 && stock < par ? round(par - stock, 2) : 0,
      suggestedOrderValue: par > 0 && stock < par ? round((par - stock) * unitCost, 2) : 0,
      lastCountDay: approved?.day ?? null,
      pendingCountDay: pending?.day ?? null,
      pendingCountQty: pending ? round(Number(pending.counted_qty), 3) : null,
      countVariance: variance,
      countVarianceValue: variance != null ? round(variance * unitCost, 2) : null,
      status,
    };
  }).sort((a, b) => {
    const rank = { negative: 0, below_par: 1, low_cover: 2, ok: 3 };
    return rank[a.status] - rank[b.status] || (a.daysCover ?? 99999) - (b.daysCover ?? 99999);
  });

  const reorder = rows.filter((r) => r.status !== 'ok');

  return {
    asOf,
    currency: ds.currency,
    totalValue: round(sum(rows.map((r) => r.value)), 2),
    totalRetailValue: round(sum(rows.map((r) => r.retailValue)), 2),
    reorderValue: round(sum(reorder.map((r) => r.suggestedOrderValue)), 2),
    reorder,
    // Money on a shelf that is not moving. In a craft shop this is the usual
    // problem, not shortage — a season's unsold stock is a season's cash.
    idle: rows.filter((r) => r.sold90 === 0 && r.value > 0).sort((a, b) => b.value - a.value),
    // A product priced below what it cost you. Worth knowing before it sells.
    underpriced: rows.filter((r) => r.sellPrice > 0 && r.unitCost > 0 && r.sellPrice < r.unitCost),
    shrinkage: rows
      .filter((r) => r.countVariance != null && Math.abs(r.countVarianceValue) > 0.01)
      .sort((a, b) => a.countVarianceValue - b.countVarianceValue),
    rows,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

function delta(before, after) {
  return {
    before: round(before, 2),
    after: round(after, 2),
    change: round(after - before, 2),
    changePct: pctChange(before, after),
  };
}

/** Everything for one period, with the period before it for comparison. */
export function periodReport(ds, from, to) {
  const days = rangeDays(from, to);
  const length = days.length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const current = totals(ds, linesIn(ds, from, to), salesIn(ds, from, to));
  const previous = totals(ds, linesIn(ds, prevFrom, prevTo), salesIn(ds, prevFrom, prevTo));

  const items = byItem(ds, from, to);
  const categories = byCategory(ds, from, to);

  return {
    from,
    to,
    days: length,
    currency: ds.currency,
    shopName: ds.shopName,
    current,
    previous,
    previousRange: { from: prevFrom, to: prevTo },
    change: {
      revenue: delta(previous.revenue, current.revenue),
      margin: delta(previous.margin, current.margin),
      saleCount: delta(previous.saleCount, current.saleCount),
      averageSale: delta(previous.averageSale, current.averageSale),
    },
    daily: daily(ds, from, to),
    items,
    categories,
    best: items.slice(0, 10),
    // Sold nothing at all in the window, but is sitting on the shelf.
    unsold: stockReport(ds, to).rows
      .filter((r) => !items.some((i) => i.itemId === r.itemId) && r.stock > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 15),
    alerts: alertsFor(ds, from, to, current, previous, items),
  };
}

/**
 * What is worth saying out loud about this period.
 *
 * Deliberately few. A shop report that flags fifteen things every week is a
 * report nobody reads by the third week.
 */
function alertsFor(ds, from, to, current, previous, items) {
  const alerts = [];

  if (current.revenue > 0 && current.marginPct != null && current.marginPct < 20) {
    alerts.push({
      level: 'high',
      title: `Margin is thin at ${current.marginPct}%`,
      detail: `${ds.currency} ${current.revenue.toLocaleString('en-GB')} of takings left `
        + `${ds.currency} ${current.margin.toLocaleString('en-GB')} after what the stock cost. `
        + 'Check the selling prices against what you paid.',
    });
  }

  const losing = items.filter((i) => i.margin < 0);
  if (losing.length) {
    alerts.push({
      level: 'high',
      title: `${losing.length} ${losing.length === 1 ? 'product sold' : 'products sold'} below cost`,
      detail: `${losing.slice(0, 4).map((i) => i.name).join(', ')}`
        + `${losing.length > 4 ? ` and ${losing.length - 4} more` : ''}. `
        + 'Either the selling price is wrong or the cost price is.',
    });
  }

  if (previous.revenue > 0) {
    const change = pctChange(previous.revenue, current.revenue);
    if (change != null && change <= -25) {
      alerts.push({
        level: 'warn',
        title: `Takings down ${Math.abs(round(change, 0))}% on the period before`,
        detail: `${ds.currency} ${current.revenue.toLocaleString('en-GB')} against `
          + `${ds.currency} ${previous.revenue.toLocaleString('en-GB')}.`,
      });
    } else if (change != null && change >= 30) {
      alerts.push({
        level: 'info',
        title: `Takings up ${round(change, 0)}% on the period before`,
        detail: `${ds.currency} ${current.revenue.toLocaleString('en-GB')} against `
          + `${ds.currency} ${previous.revenue.toLocaleString('en-GB')}. `
          + 'Worth knowing what sold, so you can order more of it.',
      });
    }
  }

  const stock = stockReport(ds, to);
  // Two different problems wear the same badge on the stock screen, and they
  // call for different answers: one is below the level you set, the other is
  // selling faster than what is left will cover. Saying "about GHS 0 to bring
  // them back up" for the second is how an alert teaches people to ignore it.
  const belowPar = stock.reorder.filter((r) => r.status === 'below_par' || r.status === 'negative');
  const runningOut = stock.reorder.filter((r) => r.status === 'low_cover');

  if (belowPar.length) {
    alerts.push({
      level: 'warn',
      title: `${belowPar.length} ${belowPar.length === 1 ? 'product is' : 'products are'} below the level you set`,
      detail: `About ${ds.currency} ${stock.reorderValue.toLocaleString('en-GB')} to bring them back up.`,
    });
  }
  if (runningOut.length) {
    alerts.push({
      level: 'warn',
      title: `${runningOut.length} ${runningOut.length === 1 ? 'product is' : 'products are'} selling faster than the shelf will cover`,
      detail: `${runningOut.slice(0, 4).map((r) => r.name).join(', ')}`
        + `${runningOut.length > 4 ? ' and others' : ''} — `
        + `under ${ds.lowCoverDays} days left at the current rate.`,
    });
  }

  if (stock.underpriced.length) {
    alerts.push({
      level: 'high',
      title: `${stock.underpriced.length} ${stock.underpriced.length === 1 ? 'product is' : 'products are'} priced below cost`,
      detail: `${stock.underpriced.slice(0, 4).map((r) => r.name).join(', ')}`
        + `${stock.underpriced.length > 4 ? ' and others' : ''}. `
        + 'Every one sold loses money.',
    });
  }

  const idleValue = sum(stock.idle.map((r) => r.value));
  if (idleValue > 0 && stock.totalValue > 0 && idleValue / stock.totalValue > 0.4) {
    alerts.push({
      level: 'warn',
      title: `${ds.currency} ${round(idleValue, 0).toLocaleString('en-GB')} has not sold in three months`,
      detail: `That is ${round((idleValue / stock.totalValue) * 100, 0)}% of the shelf. `
        + 'Cash sitting still is the usual problem in a craft shop, not shortage.',
    });
  }

  return alerts;
}

/** The landing screen: today, this week, this month, and what needs doing. */
export function overview(ds, today) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const weekStart = addDays(today, -6);

  const period = (from, to) => totals(ds, linesIn(ds, from, to), salesIn(ds, from, to));

  const stock = stockReport(ds, today);
  const month = period(monthStart, today);

  return {
    today: period(today, today),
    week: period(weekStart, today),
    month,
    monthRange: { from: monthStart, to: today },
    currency: ds.currency,
    shopName: ds.shopName,
    stockValue: stock.totalValue,
    retailValue: stock.totalRetailValue,
    reorderCount: stock.reorder.length,
    idleValue: round(sum(stock.idle.map((r) => r.value)), 2),
    pendingCounts: ds.counts.filter((c) => c.status !== 'approved' && c.status !== 'rejected').length,
    best: byItem(ds, monthStart, today).slice(0, 6),
    daily: daily(ds, addDays(today, -20), today),
    alerts: alertsFor(ds, monthStart, today, month, period(
      addDays(monthStart, -diffDays(monthStart, today) - 1), addDays(monthStart, -1),
    ), byItem(ds, monthStart, today)),
  };
}

/** Two arbitrary windows, side by side. Mirrors the other two stores. */
export function compare(ds, a, b) {
  const left = totals(ds, linesIn(ds, a.from, a.to), salesIn(ds, a.from, a.to));
  const right = totals(ds, linesIn(ds, b.from, b.to), salesIn(ds, b.from, b.to));

  const leftItems = byItem(ds, a.from, a.to);
  const rightItems = byItem(ds, b.from, b.to);
  const ids = new Set([...leftItems, ...rightItems].map((i) => i.itemId));

  const items = [...ids].map((id) => {
    const l = leftItems.find((i) => i.itemId === id);
    const r = rightItems.find((i) => i.itemId === id);
    return {
      itemId: id,
      name: l?.name ?? r?.name ?? 'Removed product',
      a: { revenue: l?.revenue ?? 0, qty: l?.qty ?? 0 },
      b: { revenue: r?.revenue ?? 0, qty: r?.qty ?? 0 },
      change: round((r?.revenue ?? 0) - (l?.revenue ?? 0), 2),
      changePct: pctChange(l?.revenue ?? 0, r?.revenue ?? 0),
    };
  }).sort((x, y) => Math.abs(y.change) - Math.abs(x.change));

  return {
    currency: ds.currency,
    a: { ...a, ...left },
    b: { ...b, ...right },
    change: {
      revenue: delta(left.revenue, right.revenue),
      margin: delta(left.margin, right.margin),
      saleCount: delta(left.saleCount, right.saleCount),
      averageSale: delta(left.averageSale, right.averageSale),
      units: delta(left.units, right.units),
    },
    items: items.slice(0, 40),
  };
}
