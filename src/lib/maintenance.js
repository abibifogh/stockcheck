import { buildLedger } from './ledger.js';
import { median, pctChange, relativeSpread, robustZ, round, sum } from '../util/stats.js';
import { addDays, diffDays, dow, rangeDays } from '../util/dates.js';

/**
 * Maintenance stores: what was issued, to where, and what it cost.
 *
 * The breakfast side asks "what did each guest cost", and normalises everything
 * by headcount. Maintenance has no headcount. Its natural denominator is the
 * place: a room that swallows parts every month is the finding, and the same
 * spend spread evenly over forty rooms is not. So every figure here is grouped
 * by area first and by time second, which is the reverse of the kitchen.
 *
 * Costing is shared with the kitchen ledger — weighted moving average, book
 * stock, negative balances kept rather than clamped — because "what is on the
 * shelf and what did it cost" is the same question in both stores.
 */

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const BASELINE_DAYS = 90;

export async function loadDataset(db) {
  const [categories, items, areas, issues, purchases, counts, settings] = await Promise.all([
    db.prepare('SELECT * FROM mx_categories ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM mx_items ORDER BY name').all(),
    db.prepare('SELECT * FROM mx_areas ORDER BY kind, sort_order, name').all(),
    db.prepare('SELECT * FROM mx_issues ORDER BY day, id').all(),
    db.prepare('SELECT * FROM mx_purchases ORDER BY day, id').all(),
    db.prepare('SELECT * FROM mx_counts ORDER BY day').all(),
    db.prepare('SELECT key, value FROM settings').all(),
  ]);

  return makeDataset({
    categories: categories.results ?? [],
    items: items.results ?? [],
    areas: areas.results ?? [],
    issues: issues.results ?? [],
    purchases: purchases.results ?? [],
    counts: counts.results ?? [],
    settings: settings.results ?? [],
  });
}

export function makeDataset(raw) {
  const settings = Object.fromEntries((raw.settings ?? []).map((r) => [r.key, r.value]));
  const items = raw.items ?? [];
  const issues = raw.issues ?? [];

  // The ledger speaks the kitchen's vocabulary. Translating here rather than
  // forking it keeps one implementation of the costing rules.
  const ledger = buildLedger({
    ingredients: items.map((i) => ({
      id: i.id,
      opening_stock: i.opening_stock,
      default_unit_cost: i.default_unit_cost,
    })),
    purchases: (raw.purchases ?? []).map((p) => ({
      day: p.day, ingredient_id: p.item_id, qty: p.qty, unit_cost: p.unit_cost,
    })),
    usage: issues.map((i) => ({ day: i.day, ingredient_id: i.item_id, qty: i.qty })),
    // Only counts an administrator has accepted move the book. A pending one
    // is reported as a difference and changes nothing, which is what makes the
    // approval step mean something.
    counts: (raw.counts ?? [])
      .filter((c) => c.status === 'approved')
      .map((c) => ({ day: c.day, ingredient_id: c.item_id, qty: c.counted_qty })),
  });

  const days = [...new Set(issues.map((i) => i.day))].sort();

  // day -> item -> qty, and day -> area -> item -> qty. Both are wanted often
  // enough that walking the issue list again each time would show.
  const usageByDay = new Map();
  const byDayArea = new Map();
  for (const issue of issues) {
    if (!usageByDay.has(issue.day)) usageByDay.set(issue.day, new Map());
    const perItem = usageByDay.get(issue.day);
    perItem.set(issue.item_id, (perItem.get(issue.item_id) ?? 0) + Number(issue.qty || 0));

    if (!byDayArea.has(issue.day)) byDayArea.set(issue.day, new Map());
    const areas = byDayArea.get(issue.day);
    const key = issue.area_id ?? 0;
    if (!areas.has(key)) areas.set(key, new Map());
    const areaItems = areas.get(key);
    areaItems.set(issue.item_id, (areaItems.get(issue.item_id) ?? 0) + Number(issue.qty || 0));
  }

  return {
    settings,
    currency: settings.currency || 'GHS',
    timezone: settings.timezone || 'Africa/Accra',
    lowCoverDays: Number(settings.mx_low_cover_days) || 7,
    categories: raw.categories ?? [],
    categoryById: new Map((raw.categories ?? []).map((c) => [c.id, c])),
    items,
    itemById: new Map(items.map((i) => [i.id, i])),
    areas: raw.areas ?? [],
    areaById: new Map((raw.areas ?? []).map((a) => [a.id, a])),
    issues,
    purchases: raw.purchases ?? [],
    counts: raw.counts ?? [],
    recordedDays: days,
    usageByDay,
    byDayArea,
    ledger,
  };
}

/** What one issue cost, at the unit price in force on the day it went out. */
export function issueCost(ds, issue) {
  return round(Number(issue.qty || 0) * ds.ledger.unitCostOn(issue.item_id, issue.day), 2);
}

function issuesIn(ds, from, to) {
  return ds.issues.filter((i) => i.day >= from && i.day <= to);
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function totals(ds, issues) {
  const cost = round(sum(issues.map((i) => issueCost(ds, i))), 2);
  const areas = new Set(issues.map((i) => i.area_id ?? 0));
  const days = new Set(issues.map((i) => i.day));
  return {
    issues: issues.length,
    cost,
    items: new Set(issues.map((i) => i.item_id)).size,
    areasTouched: areas.size,
    activeDays: days.size,
    costPerArea: areas.size ? round(cost / areas.size, 2) : null,
    costPerDay: days.size ? round(cost / days.size, 2) : null,
  };
}

/**
 * Spend by place, which is the question this system exists to answer.
 *
 * Rooms are ranked against each other rather than against a budget, because
 * nobody sets a parts budget per room — but everybody can act on "room 214 cost
 * four times the average this quarter".
 */
export function byArea(ds, from, to) {
  const issues = issuesIn(ds, from, to);
  const groups = new Map();

  for (const issue of issues) {
    const key = issue.area_id ?? 0;
    if (!groups.has(key)) groups.set(key, { issues: [], cost: 0, items: new Map() });
    const g = groups.get(key);
    g.issues.push(issue);
    g.cost += issueCost(ds, issue);
    g.items.set(issue.item_id, (g.items.get(issue.item_id) ?? 0) + Number(issue.qty || 0));
  }

  const rows = [...groups.entries()].map(([areaId, g]) => {
    const area = ds.areaById.get(areaId);
    const top = [...g.items.entries()]
      .map(([itemId, qty]) => ({
        itemId,
        name: ds.itemById.get(itemId)?.name ?? `#${itemId}`,
        unit: ds.itemById.get(itemId)?.unit ?? '',
        qty: round(qty, 3),
        cost: round(qty * ds.ledger.unitCostOn(itemId, to), 2),
      }))
      .sort((a, b) => b.cost - a.cost);

    return {
      areaId: areaId || null,
      name: area?.name ?? 'Not recorded',
      kind: area?.kind ?? 'area',
      block: area?.block ?? null,
      issues: g.issues.length,
      cost: round(g.cost, 2),
      visits: new Set(g.issues.map((i) => i.day)).size,
      lastIssue: g.issues.map((i) => i.day).sort().at(-1) ?? null,
      topItems: top.slice(0, 5),
    };
  }).sort((a, b) => b.cost - a.cost);

  const costs = rows.map((r) => r.cost);
  const typical = median(costs);

  // A room is "heavy" when it is out of line with the others, judged the same
  // robust way the kitchen judges an ingredient: median and deviation, so one
  // extraordinary refurbishment does not redefine normal for everybody else.
  const spread = relativeSpread(costs);
  for (const row of rows) {
    const z = robustZ(row.cost, costs);
    const overMedian = typical > 0 ? ((row.cost - typical) / typical) * 100 : null;
    row.vsTypicalPct = overMedian == null ? null : round(overMedian, 1);
    row.heavy = row.cost > typical
      && (spread < 0.15 ? (overMedian ?? 0) > 60 : z > 3);
  }

  return { rows, typicalCost: round(typical, 2), heavy: rows.filter((r) => r.heavy) };
}

/** Spend by category, and by item, over a range. */
export function byItem(ds, from, to) {
  const issues = issuesIn(ds, from, to);
  const perItem = new Map();

  for (const issue of issues) {
    if (!perItem.has(issue.item_id)) perItem.set(issue.item_id, { qty: 0, cost: 0, areas: new Set(), days: new Set() });
    const rec = perItem.get(issue.item_id);
    rec.qty += Number(issue.qty || 0);
    rec.cost += issueCost(ds, issue);
    rec.areas.add(issue.area_id ?? 0);
    rec.days.add(issue.day);
  }

  const rows = [...perItem.entries()].map(([itemId, rec]) => {
    const item = ds.itemById.get(itemId);
    return {
      itemId,
      name: item?.name ?? `#${itemId}`,
      unit: item?.unit ?? '',
      attributes: item?.attributes ?? null,
      categoryId: item?.category_id ?? null,
      categoryName: ds.categoryById.get(item?.category_id)?.name ?? 'Uncategorised',
      qty: round(rec.qty, 3),
      cost: round(rec.cost, 2),
      areas: rec.areas.size,
      // Something used in one place many times behaves differently from
      // something used once in many places; both are worth seeing.
      perArea: rec.areas.size ? round(rec.qty / rec.areas.size, 3) : null,
    };
  }).sort((a, b) => b.cost - a.cost);

  const total = sum(rows.map((r) => r.cost));
  const categories = new Map();
  for (const row of rows) {
    const key = row.categoryId ?? 0;
    if (!categories.has(key)) categories.set(key, { categoryId: row.categoryId, name: row.categoryName, cost: 0, qty: 0 });
    categories.get(key).cost += row.cost;
  }

  return {
    rows,
    total: round(total, 2),
    categories: [...categories.values()]
      .map((c) => ({ ...c, cost: round(c.cost, 2), share: total ? round((c.cost / total) * 100, 1) : 0 }))
      .sort((a, b) => b.cost - a.cost),
  };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * What is on the shelf, and what needs ordering.
 *
 * "Days of cover" is deliberately measured over 90 days rather than the
 * kitchen's fortnight: a hotel gets through bulbs steadily but replaces a
 * cistern valve twice a year, and a two-week window would call almost
 * everything dead stock.
 */
export function stockReport(ds, asOf) {
  const from = addDays(asOf, -BASELINE_DAYS);
  const window = ds.recordedDays.filter((d) => d > from && d <= asOf);
  const span = Math.max(1, Math.min(BASELINE_DAYS, window.length ? diffDays(window[0], asOf) + 1 : 1));

  const rows = ds.items.filter((i) => i.active).map((item) => {
    const stock = ds.ledger.stockOn(item.id, asOf);
    const unitCost = ds.ledger.unitCostOn(item.id, asOf);
    const used = sum(window.map((d) => ds.usageByDay.get(d)?.get(item.id) ?? 0));
    const dailyRate = used / span;
    const daysCover = dailyRate > 1e-9 ? round(stock / dailyRate, 0) : null;
    const par = Number(item.par_level) || 0;

    // A pending count is the interesting one: it is a claim about the shelf
    // that the book has not accepted yet.
    // Anything not yet decided counts as pending, including a row written
    // before the approval step existed. A count that fell through a gap must
    // show up as waiting, never disappear.
    const pending = ds.counts
      .filter((c) => c.item_id === item.id && c.day <= asOf
        && c.status !== 'approved' && c.status !== 'rejected')
      .at(-1);
    const count = ds.counts
      .filter((c) => c.item_id === item.id && c.day <= asOf && c.status === 'approved')
      .at(-1);

    // For an approved count the book has already been moved to match, so the
    // difference worth showing is the one still outstanding.
    const variance = pending
      ? round(Number(pending.counted_qty) - stock, 3)
      : null;

    let status = 'ok';
    if (stock < 0) status = 'negative';
    else if (par > 0 && stock < par) status = 'below_par';
    else if (daysCover != null && daysCover < ds.lowCoverDays) status = 'low_cover';

    return {
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      attributes: item.attributes ?? null,
      categoryId: item.category_id,
      categoryName: ds.categoryById.get(item.category_id)?.name ?? 'Uncategorised',
      stock: round(stock, 3),
      parLevel: par,
      unitCost: round(unitCost, 2),
      value: round(stock * unitCost, 2),
      used90: round(used, 3),
      avgDailyUse: round(dailyRate, 4),
      daysCover,
      suggestedOrder: par > 0 && stock < par ? round(par - stock, 2) : 0,
      suggestedOrderValue: par > 0 && stock < par ? round((par - stock) * unitCost, 2) : 0,
      lastCountDay: count?.day ?? null,
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
    reorderValue: round(sum(reorder.map((r) => r.suggestedOrderValue)), 2),
    reorder,
    // Dead stock ties up money on a shelf; worth seeing next to the shortages.
    idle: rows.filter((r) => r.used90 === 0 && r.value > 0).sort((a, b) => b.value - a.value),
    shrinkage: rows
      .filter((r) => r.countVariance != null && Math.abs(r.countVarianceValue) > 0.01)
      .sort((a, b) => a.countVarianceValue - b.countVarianceValue),
    rows,
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Everything for one period, with the period before it for comparison. */
export function periodReport(ds, from, to) {
  const days = rangeDays(from, to);
  const length = days.length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const current = totals(ds, issuesIn(ds, from, to));
  const previous = totals(ds, issuesIn(ds, prevFrom, prevTo));

  const areas = byArea(ds, from, to);
  const items = byItem(ds, from, to);
  const prevItems = new Map(byItem(ds, prevFrom, prevTo).rows.map((r) => [r.itemId, r]));

  const movers = items.rows.map((row) => {
    const before = prevItems.get(row.itemId);
    return {
      ...row,
      prevCost: before?.cost ?? 0,
      deltaCost: round(row.cost - (before?.cost ?? 0), 2),
      deltaPct: before?.cost ? round(pctChange(before.cost, row.cost) ?? 0, 1) : null,
    };
  });

  const purchases = ds.purchases.filter((p) => p.day >= from && p.day <= to);
  const purchaseValue = round(sum(purchases.map((p) => Number(p.qty || 0) * Number(p.unit_cost || 0))), 2);

  return {
    from,
    to,
    days: length,
    currency: ds.currency,
    current,
    previous: { ...previous, from: prevFrom, to: prevTo },
    deltas: {
      cost: delta(previous.cost, current.cost),
      issues: delta(previous.issues, current.issues),
      areasTouched: delta(previous.areasTouched, current.areasTouched),
      costPerArea: delta(previous.costPerArea, current.costPerArea),
    },
    areas,
    items,
    risers: [...movers].sort((a, b) => b.deltaCost - a.deltaCost).filter((m) => m.deltaCost > 0).slice(0, 8),
    fallers: [...movers].sort((a, b) => a.deltaCost - b.deltaCost).filter((m) => m.deltaCost < 0).slice(0, 8),
    inventory: {
      purchaseValue,
      issuedValue: current.cost,
      // Buying much more than you issue puts money on a shelf; the reverse
      // means you are running down what was bought earlier.
      movement: round(purchaseValue - current.cost, 2),
      purchaseCount: purchases.length,
    },
    series: days.map((day) => {
      const dayIssues = ds.issues.filter((i) => i.day === day);
      return {
        day,
        weekday: DOW_LABELS[dow(day)],
        cost: round(sum(dayIssues.map((i) => issueCost(ds, i))), 2),
        issues: dayIssues.length,
        areas: new Set(dayIssues.map((i) => i.area_id ?? 0)).size,
      };
    }),
    alerts: alertsFor(ds, from, to, areas, items),
  };
}

/** Null rather than zero when there is nothing to compare against. */
function delta(before, after) {
  if (before == null || after == null) return null;
  if (!before) return null;
  return round(pctChange(before, after) ?? 0, 1);
}

/**
 * What actually needs somebody's attention. Ordered by how much money is
 * behind it, because a list sorted by anything else gets skimmed.
 */
function alertsFor(ds, from, to, areas, items) {
  const alerts = [];

  for (const area of areas.heavy.slice(0, 5)) {
    alerts.push({
      level: 'high',
      kind: 'heavy_area',
      areaId: area.areaId,
      title: `${area.name} is consuming far more than the others`,
      detail: `${ds.currency} ${area.cost.toLocaleString('en-GB')} across ${area.issues} `
        + `${area.issues === 1 ? 'issue' : 'issues'}, against a typical ${ds.currency} `
        + `${areas.typicalCost.toLocaleString('en-GB')}. Worth looking at what keeps failing there.`,
    });
  }

  const stock = stockReport(ds, to);
  for (const row of stock.reorder.slice(0, 8)) {
    alerts.push({
      level: row.status === 'negative' ? 'high' : 'warn',
      kind: 'stock',
      itemId: row.itemId,
      title: row.status === 'negative'
        ? `${row.name} shows negative stock`
        : row.status === 'below_par'
          ? `${row.name} is below its restock level`
          : `${row.name} has about ${row.daysCover} days left`,
      detail: row.status === 'negative'
        ? `The book says ${row.stock} ${row.unit}, which means a purchase was never recorded.`
        : `${row.stock} ${row.unit} on the shelf against a level of ${row.parLevel} ${row.unit}. `
          + `Order about ${row.suggestedOrder} ${row.unit}.`,
    });
  }

  // Something issued repeatedly to the same place in a short window is usually
  // a fault being patched rather than fixed.
  const repeats = new Map();
  for (const issue of issuesIn(ds, from, to)) {
    const key = `${issue.area_id ?? 0}:${issue.item_id}`;
    if (!repeats.has(key)) repeats.set(key, []);
    repeats.get(key).push(issue);
  }
  for (const [key, list] of repeats) {
    if (list.length < 3) continue;
    const [areaId, itemId] = key.split(':').map(Number);
    const days = new Set(list.map((i) => i.day));
    if (days.size < 3) continue;
    alerts.push({
      level: 'warn',
      kind: 'repeat',
      areaId: areaId || null,
      itemId,
      title: `${ds.itemById.get(itemId)?.name ?? 'An item'} went to `
        + `${ds.areaById.get(areaId)?.name ?? 'the same place'} ${list.length} times`,
      detail: `Across ${days.size} separate days in this period. Repeatedly replacing the same part `
        + 'in the same place usually points at a cause that has not been dealt with.',
    });
  }

  return alerts;
}

/** Two ranges of the reader's choosing, side by side. */
export function compare(ds, a, b) {
  const one = periodReport(ds, a.from, a.to);
  const two = periodReport(ds, b.from, b.to);

  const aAreas = new Map(one.areas.rows.map((r) => [r.areaId ?? 0, r]));
  const bAreas = new Map(two.areas.rows.map((r) => [r.areaId ?? 0, r]));
  const areaKeys = new Set([...aAreas.keys(), ...bAreas.keys()]);

  const aItems = new Map(one.items.rows.map((r) => [r.itemId, r]));
  const bItems = new Map(two.items.rows.map((r) => [r.itemId, r]));
  const itemKeys = new Set([...aItems.keys(), ...bItems.keys()]);

  const sameLength = one.days === two.days;

  return {
    currency: ds.currency,
    a: { from: a.from, to: a.to, days: one.days, label: `${a.from} → ${a.to}`, ...one.current },
    b: { from: b.from, to: b.to, days: two.days, label: `${b.from} → ${b.to}`, ...two.current },
    comparable: {
      sameLength,
      note: sameLength ? null
        : `These periods are different lengths (${one.days} days against ${two.days}). `
          + 'Compare the per-day figures rather than the totals.',
    },
    deltas: {
      cost: delta(two.current.cost, one.current.cost),
      issues: delta(two.current.issues, one.current.issues),
      costPerDay: delta(two.current.costPerDay, one.current.costPerDay),
      areasTouched: delta(two.current.areasTouched, one.current.areasTouched),
    },
    areas: [...areaKeys].map((key) => {
      const first = aAreas.get(key);
      const second = bAreas.get(key);
      return {
        areaId: key || null,
        name: first?.name ?? second?.name ?? 'Not recorded',
        kind: first?.kind ?? second?.kind ?? 'area',
        aCost: first?.cost ?? 0,
        bCost: second?.cost ?? 0,
        deltaCost: round((first?.cost ?? 0) - (second?.cost ?? 0), 2),
        deltaPct: delta(second?.cost, first?.cost),
      };
    }).sort((x, y) => Math.abs(y.deltaCost) - Math.abs(x.deltaCost)),
    items: [...itemKeys].map((key) => {
      const first = aItems.get(key);
      const second = bItems.get(key);
      return {
        itemId: key,
        name: first?.name ?? second?.name ?? `#${key}`,
        unit: first?.unit ?? second?.unit ?? '',
        categoryName: first?.categoryName ?? second?.categoryName ?? '',
        aQty: first?.qty ?? 0,
        bQty: second?.qty ?? 0,
        aCost: first?.cost ?? 0,
        bCost: second?.cost ?? 0,
        deltaCost: round((first?.cost ?? 0) - (second?.cost ?? 0), 2),
        deltaPct: delta(second?.cost, first?.cost),
      };
    }).sort((x, y) => Math.abs(y.deltaCost) - Math.abs(x.deltaCost)),
    series: { a: one.series, b: two.series },
  };
}

/**
 * The landing screen: where the store stands, and what wants a decision.
 */
export function overview(ds, today) {
  const monthFrom = `${today.slice(0, 7)}-01`;
  const month = periodReport(ds, monthFrom, today);
  const stock = stockReport(ds, today);
  const last30 = periodReport(ds, addDays(today, -29), today);

  const recent = [...ds.issues].slice(-12).reverse().map((issue) => ({
    id: issue.id,
    day: issue.day,
    item: ds.itemById.get(issue.item_id)?.name ?? `#${issue.item_id}`,
    unit: ds.itemById.get(issue.item_id)?.unit ?? '',
    qty: issue.qty,
    area: ds.areaById.get(issue.area_id)?.name ?? 'Not recorded',
    cost: issueCost(ds, issue),
    by: issue.issued_by,
    jobRef: issue.job_ref,
  }));

  return {
    today,
    currency: ds.currency,
    headline: {
      monthCost: month.current.cost,
      monthIssues: month.current.issues,
      monthAreas: month.current.areasTouched,
      monthDelta: month.deltas.cost,
      last30Cost: last30.current.cost,
      stockValue: stock.totalValue,
      reorderCount: stock.reorder.length,
      reorderValue: stock.reorderValue,
      idleValue: round(sum(stock.idle.map((r) => r.value)), 2),
    },
    alerts: month.alerts.slice(0, 8),
    topAreas: month.areas.rows.slice(0, 8),
    topItems: month.items.rows.slice(0, 8),
    recent,
    series: last30.series,
  };
}
