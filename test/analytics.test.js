import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLedger } from '../src/lib/ledger.js';
import {
  compareInsights, dailyInsights, dayMetrics, entryHints, makeDataset, monthlyInsights,
  stockReport, weeklyInsights,
} from '../src/lib/analytics.js';
import { addDays, dow, monthBounds, rangeDays, startOfWeek } from '../src/util/dates.js';
import { median, pctChange, relativeSpread, robustZ } from '../src/util/stats.js';

const CATEGORIES = [
  { id: 1, name: 'Eggs & Dairy', sort_order: 10 },
  { id: 2, name: 'Bakery', sort_order: 20 },
];

const INGREDIENTS = [
  { id: 1, category_id: 1, name: 'Eggs', unit: 'pcs', step: 6, par_level: 100, default_unit_cost: 1, opening_stock: 200, is_core: 1, active: 1 },
  { id: 2, category_id: 2, name: 'Bread', unit: 'loaf', step: 1, par_level: 10, default_unit_cost: 10, opening_stock: 20, is_core: 1, active: 1 },
];

/** 20 consecutive days of steady service, 2 eggs and 0.2 loaves per guest. */
function steadyDataset({ days = 20, guests = 50, start = '2026-03-02' } = {}) {
  const serviceDays = [];
  const usage = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    serviceDays.push({ day, inhouse_guests: guests - 5, outside_guests: 5, outsider_fee: 20, note: null, submitted_at: 'x' });
    usage.push({ day, ingredient_id: 1, qty: guests * 2 });
    usage.push({ day, ingredient_id: 2, qty: guests * 0.2 });
  }
  return {
    serviceDays,
    usage,
    purchases: [
      { id: 1, day: start, ingredient_id: 1, qty: 5000, unit_cost: 1.5 },
      { id: 2, day: start, ingredient_id: 2, qty: 400, unit_cost: 12 },
    ],
  };
}

function build(overrides = {}) {
  const base = steadyDataset();
  return makeDataset({
    categories: CATEGORIES,
    ingredients: INGREDIENTS,
    settings: [{ key: 'currency', value: 'GHS' }, { key: 'timezone', value: 'Africa/Accra' }],
    stockCounts: [],
    ...base,
    ...overrides,
  });
}

// --------------------------------------------------------------- ledger --

test('weighted average cost blends an opening balance with a new purchase', () => {
  const ledger = buildLedger({
    ingredients: [INGREDIENTS[0]], // 200 pcs opening at 1.00
    purchases: [{ day: '2026-03-02', ingredient_id: 1, qty: 200, unit_cost: 2 }],
    usage: [{ day: '2026-03-02', ingredient_id: 1, qty: 100 }],
  });
  const entry = ledger.entry(1, '2026-03-02');
  // (200 × 1.00 + 200 × 2.00) / 400 = 1.50
  assert.equal(entry.unitCost, 1.5);
  assert.equal(entry.usedCost, 150);
  assert.equal(entry.closingStock, 300);
});

test('a later purchase only affects days from that point on', () => {
  const ledger = buildLedger({
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 100, default_unit_cost: 1 }],
    purchases: [{ day: '2026-03-05', ingredient_id: 1, qty: 100, unit_cost: 3 }],
    usage: [
      { day: '2026-03-03', ingredient_id: 1, qty: 10 },
      { day: '2026-03-06', ingredient_id: 1, qty: 10 },
    ],
  });
  assert.equal(ledger.cost(1, '2026-03-03'), 10);
  // 90 left at 1.00, plus 100 at 3.00 → 2.05 average
  assert.equal(ledger.entry(1, '2026-03-06').unitCost, 2.0526);
});

test('book stock goes negative when a delivery was never recorded', () => {
  const ledger = buildLedger({
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 10 }],
    purchases: [],
    usage: [{ day: '2026-03-02', ingredient_id: 1, qty: 40 }],
  });
  assert.equal(ledger.stockOn(1, '2026-03-02'), -30);
});

test('unit cost and stock walk back to the last known movement', () => {
  const ledger = buildLedger({
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 50, default_unit_cost: 2 }],
    purchases: [{ day: '2026-03-02', ingredient_id: 1, qty: 50, unit_cost: 4 }],
    usage: [{ day: '2026-03-02', ingredient_id: 1, qty: 20 }],
  });
  assert.equal(ledger.unitCostOn(1, '2026-03-20'), 3);
  assert.equal(ledger.stockOn(1, '2026-03-20'), 80);
  // Before any movement, the opening balance stands.
  assert.equal(ledger.stockOn(1, '2026-03-01'), 50);
});

// -------------------------------------------------------------- daily ----

test('day metrics roll up guests, cost and outsider economics', () => {
  const ds = build();
  const m = dayMetrics(ds, '2026-03-10');
  assert.equal(m.guests, 50);
  assert.equal(m.inhouse, 45);
  assert.equal(m.outside, 5);
  assert.equal(m.revenue, 100); // 5 × 20
  assert.ok(m.costPerGuest > 0);
  // 100 eggs at 1.48 + 10 loaves at 11.9 ≈ 267
  assert.ok(Math.abs(m.cost - (100 * 1.4808 + 10 * 11.9048)) < 1);
});

test('a spike in one ingredient is flagged with its cost impact', () => {
  const base = steadyDataset();
  const spikeDay = '2026-03-19';
  for (const row of base.usage) {
    if (row.day === spikeDay && row.ingredient_id === 1) row.qty = 300; // 3× normal
  }
  const ds = build(base);
  const insight = dailyInsights(ds, spikeDay);

  const eggLine = insight.lines.find((l) => l.ingredientId === 1);
  assert.equal(eggLine.flag, 'high');
  assert.equal(eggLine.expectedQty, 100);
  assert.equal(eggLine.deltaQty, 200);
  assert.ok(eggLine.costImpact > 250);

  const alert = insight.alerts.find((a) => a.kind === 'usage_deviation' && a.ingredientId === 1);
  assert.ok(alert, 'expected a deviation alert for eggs');
});

test('steady usage produces no deviation alerts', () => {
  const ds = build();
  const insight = dailyInsights(ds, '2026-03-19');
  assert.equal(insight.lines.filter((l) => l.flag !== 'normal').length, 0);
  assert.equal(insight.alerts.filter((a) => a.kind === 'usage_deviation').length, 0);
});

test('expectations scale with the headcount rather than the raw quantity', () => {
  const base = steadyDataset();
  const busyDay = '2026-03-19';
  // Twice the guests, twice the eggs — that is normal, not a deviation.
  for (const row of base.serviceDays) {
    if (row.day === busyDay) { row.inhouse_guests = 95; row.outside_guests = 5; }
  }
  for (const row of base.usage) {
    if (row.day === busyDay) row.qty *= 2;
  }
  const ds = build(base);
  const insight = dailyInsights(ds, busyDay);
  assert.equal(insight.today.guests, 100);
  assert.equal(insight.lines.find((l) => l.ingredientId === 1).expectedQty, 200);
  assert.equal(insight.lines.filter((l) => l.flag !== 'normal').length, 0);
});

test('a habitual ingredient that is missing raises a missing-entry alert', () => {
  const base = steadyDataset();
  const day = '2026-03-19';
  base.usage = base.usage.filter((u) => !(u.day === day && u.ingredient_id === 2));
  const ds = build(base);
  const insight = dailyInsights(ds, day);

  const alert = insight.alerts.find((a) => a.kind === 'missing_entry' && a.ingredientId === 2);
  assert.ok(alert, 'expected a missing-entry alert for bread');
  assert.equal(insight.completeness.missing.length, 1);
  assert.equal(insight.completeness.missing[0].name, 'Bread');
});

test('a day with no guests is reported rather than dividing by zero', () => {
  const base = steadyDataset();
  for (const row of base.serviceDays) {
    if (row.day === '2026-03-19') { row.inhouse_guests = 0; row.outside_guests = 0; }
  }
  const ds = build(base);
  const insight = dailyInsights(ds, '2026-03-19');
  assert.equal(insight.today.costPerGuest, null);
  assert.ok(insight.alerts.some((a) => a.kind === 'no_guests'));
});

// -------------------------------------------------------------- weekly ---

test('weekly insights compare like with like against the previous week', () => {
  const ds = build(steadyDataset({ days: 28, start: '2026-03-02' }));
  const week = weeklyInsights(ds, '2026-03-16');

  assert.equal(week.weekStart, '2026-03-16');
  assert.equal(week.weekEnd, '2026-03-22');
  assert.equal(week.current.servedDays, 7);
  assert.equal(week.current.guests, 350);
  assert.equal(week.previous.guests, 350);
  assert.equal(week.deltas.guests, 0);
  assert.equal(week.series.length, 7);
  assert.equal(week.profile.length, 7);
});

test('week-over-week movers are ranked by the money they moved', () => {
  const base = steadyDataset({ days: 28, start: '2026-03-02' });
  for (const row of base.usage) {
    if (row.day >= '2026-03-16' && row.day <= '2026-03-22' && row.ingredient_id === 1) row.qty *= 2;
  }
  const ds = build(base);
  const week = weeklyInsights(ds, '2026-03-16');

  assert.equal(week.risers[0].name, 'Eggs');
  assert.ok(week.risers[0].deltaCost > 500);
  assert.ok(week.deltas.cost > 0);
});

test('a week still running is compared against the same days of the week before', () => {
  // Two full weeks, then a third that stops after Wednesday. Spend per day is
  // identical throughout, so an honest comparison must report no change.
  const ds = build(steadyDataset({ days: 17, start: '2026-03-02' }));
  const week = weeklyInsights(ds, '2026-03-16');

  assert.equal(week.partial.isPartial, true);
  assert.equal(week.partial.elapsedDays, 3);
  assert.equal(week.partial.comparedThrough, '2026-03-18');

  // 3 days at 50 guests on both sides — not 150 against a full week's 350.
  assert.equal(week.current.guests, 150);
  assert.equal(week.previous.guests, 150);
  assert.equal(week.deltas.guests, 0);
  assert.equal(week.deltas.cost, 0);

  // The full previous week is still available for context.
  assert.equal(week.previousFullWeek.guests, 350);
});

test('a completed week compares the whole seven days', () => {
  const ds = build(steadyDataset({ days: 28, start: '2026-03-02' }));
  const week = weeklyInsights(ds, '2026-03-16');
  assert.equal(week.partial.isPartial, false);
  assert.equal(week.partial.elapsedDays, 7);
  assert.equal(week.current.guests, 350);
  assert.equal(week.previous.guests, 350);
});

test('with no prior history the comparison is reported as unknown, not as zero change', () => {
  // A first-ever week: the week before contains nothing at all.
  const ds = build(steadyDataset({ days: 7, start: '2026-03-02' }));
  const week = weeklyInsights(ds, '2026-03-02');

  assert.equal(week.hasComparison, false);
  assert.equal(week.previous.servedDays, 0);
  assert.equal(week.deltas.cost, null, 'no baseline must not read as 0% change');
  assert.equal(week.deltas.guests, null);
  assert.equal(week.deltas.costPerGuest, null);
});

test('a day with no guests does not report a -100% swing against its baseline', () => {
  const base = steadyDataset();
  for (const row of base.serviceDays) {
    if (row.day === '2026-03-19') { row.inhouse_guests = 0; row.outside_guests = 0; }
  }
  const ds = build(base);
  const insight = dailyInsights(ds, '2026-03-19');

  assert.equal(insight.today.costPerGuest, null);
  assert.equal(insight.comparisons.last7.costPerGuestDeltaPct, null);
  assert.equal(insight.comparisons.sameWeekday.costPerGuestDeltaPct, null);
});

// ------------------------------------------------------------- monthly ---

test('monthly insights total the month and value the store movement', () => {
  const ds = build(steadyDataset({ days: 31, start: '2026-03-01' }));
  const month = monthlyInsights(ds, '2026-03');

  assert.equal(month.from, '2026-03-01');
  assert.equal(month.to, '2026-03-31');
  assert.equal(month.current.servedDays, 31);
  assert.equal(month.current.guests, 31 * 50);
  assert.equal(month.economics.outsiderGuests, 31 * 5);
  assert.equal(month.economics.outsiderRevenue, 31 * 5 * 20);
  // Everything was bought on day one, so the store must have been drawn down.
  assert.ok(month.inventory.purchaseValue > 0);
  assert.ok(month.inventory.stockMovement > 0);
  assert.ok(month.weeks.length >= 5);
});

test('the outsider fee is judged against the food cost per guest', () => {
  const ds = build(steadyDataset({ days: 31, start: '2026-03-01' }));
  const month = monthlyInsights(ds, '2026-03');
  assert.equal(month.economics.breakEvenFee, month.current.costPerGuest);
  assert.equal(
    month.economics.outsiderContribution,
    Math.round((month.current.revenue - month.current.costPerGuest * month.current.outside) * 100) / 100,
  );
});

test('a partial month is projected from the days actually recorded', () => {
  const ds = build(steadyDataset({ days: 10, start: '2026-03-01' }));
  const month = monthlyInsights(ds, '2026-03');
  assert.ok(month.projection, 'expected a projection for a partial month');
  assert.equal(month.projection.elapsedDays, 10);
  assert.equal(month.projection.totalDays, 31);
  assert.equal(month.projection.projectedGuests, Math.round((500 / 10) * 31));
});

test('month to date is compared against the same stretch of the previous month', () => {
  // All of February, then ten days of March at an identical daily rate.
  const ds = build(steadyDataset({ days: 38, start: '2026-02-01' }));
  const month = monthlyInsights(ds, '2026-03');

  assert.equal(month.partial.isPartial, true);
  assert.equal(month.partial.elapsedDays, 10);
  // 10 days against February's first 10 — a flat comparison, not a fake saving.
  assert.equal(month.current.guests, 500);
  assert.equal(month.previous.guests, 500);
  assert.equal(month.deltas.guests, 0);
  assert.equal(month.deltas.cost, 0);
  // The complete previous month stays available for context.
  assert.equal(month.previousFullMonth.guests, 28 * 50);
});

// --------------------------------------------------------------- stock ---

test('stock report flags below-par items and suggests an order quantity', () => {
  const ds = makeDataset({
    categories: CATEGORIES,
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 120, par_level: 500 }],
    settings: [],
    stockCounts: [],
    serviceDays: [{ day: '2026-03-02', inhouse_guests: 50, outside_guests: 0, outsider_fee: 0 }],
    usage: [{ day: '2026-03-02', ingredient_id: 1, qty: 20 }],
    purchases: [],
  });
  const report = stockReport(ds, '2026-03-02');
  const row = report.rows[0];

  assert.equal(row.stock, 100);
  assert.equal(row.status, 'below_par');
  assert.equal(row.suggestedOrder, 400);
  assert.equal(report.reorder.length, 1);
});

test('a physical count is reported as a variance against the book balance', () => {
  const ds = makeDataset({
    categories: CATEGORIES,
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 100, par_level: 0, default_unit_cost: 2 }],
    settings: [],
    stockCounts: [{ id: 1, day: '2026-03-02', ingredient_id: 1, counted_qty: 70 }],
    serviceDays: [{ day: '2026-03-02', inhouse_guests: 50, outside_guests: 0, outsider_fee: 0 }],
    usage: [{ day: '2026-03-02', ingredient_id: 1, qty: 20 }],
    purchases: [],
  });
  const report = stockReport(ds, '2026-03-02');

  // Book says 80, the shelf says 70 — a shortfall of 10 worth 20.
  assert.equal(report.rows[0].countVariance, -10);
  assert.equal(report.rows[0].countVarianceValue, -20);
  assert.equal(report.shrinkage.length, 1);
});

// --------------------------------------------------------------- hints ---

test('entry hints scale the usual quantity to the expected headcount', () => {
  const ds = build();
  const hints = entryHints(ds, '2026-03-22', 80);
  assert.equal(hints[1].perGuest, 2);
  assert.equal(hints[1].suggested, 160);
  assert.equal(hints[1].coverage, 100);
});

test('entry hints stay silent for an ingredient with no history', () => {
  const ds = build();
  const hints = entryHints(ds, '2026-03-01', 50);
  assert.equal(hints[1].suggested, null);
  assert.equal(hints[1].sampleDays, 0);
});

// ---------------------------------------------------------------- util ---

test('date helpers treat weeks as Monday-based', () => {
  assert.equal(startOfWeek('2026-03-18'), '2026-03-16'); // Wednesday → Monday
  assert.equal(dow('2026-03-16'), 0);
  assert.equal(dow('2026-03-22'), 6);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  assert.equal(rangeDays('2026-03-01', '2026-03-05').length, 5);
});

test('statistics helpers return numbers, never NaN, on empty input', () => {
  assert.equal(median([]), 0);
  assert.equal(robustZ(5, []), 0);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(0, 5), null);
  assert.equal(pctChange(100, 150), 50);
  assert.equal(median([1, 2, 3, 100]), 2.5);
});

test('the robust z-score is not blunted by a single freak value', () => {
  const series = [1, 2, 1, 2, 1, 2, 1, 20];
  // A classic z-score is dragged up by the outlier itself and rates 20 at only
  // about 2.4; MAD scaling keeps the yardstick honest and rates it far higher.
  assert.ok(robustZ(20, series) > 10);
});

test('a constant history has no usable spread, and says so', () => {
  assert.equal(relativeSpread([10, 10, 10, 10]), 0);
  assert.ok(relativeSpread([8, 10, 12, 10]) > 0.1);
  assert.equal(relativeSpread([0, 0, 0]), null);
});

test('a tripling is flagged even when the item was previously recorded identically', () => {
  // Ten loaves every single day, then thirty. The z-score is undefined here
  // because the spread is zero, so the percentage deviation has to catch it.
  const serviceDays = [];
  const usage = [];
  for (let i = 0; i < 15; i++) {
    const day = addDays('2026-04-01', i);
    serviceDays.push({ day, inhouse_guests: 50, outside_guests: 0, outsider_fee: 0 });
    usage.push({ day, ingredient_id: 2, qty: i === 14 ? 30 : 10 });
  }
  const ds = makeDataset({
    categories: CATEGORIES,
    ingredients: [INGREDIENTS[1]],
    settings: [],
    stockCounts: [],
    serviceDays,
    usage,
    purchases: [],
  });

  const insight = dailyInsights(ds, '2026-04-15');
  const line = insight.lines.find((l) => l.ingredientId === 2);
  assert.equal(line.flag, 'high');
  assert.equal(line.expectedQty, 10);
  assert.equal(line.steadyHistory, true);
  assert.ok(insight.alerts.some((a) => a.kind === 'usage_deviation' && a.level === 'high'));
});

// -------------------------------------------------------------- compare --

/**
 * Two months of steady service where a single item doubles part way through,
 * so a comparison has something real to find.
 */
function comparableDataset() {
  const serviceDays = [];
  const usage = [];
  for (let i = 0; i < 40; i++) {
    const day = addDays('2026-05-01', i);
    serviceDays.push({ day, inhouse_guests: 45, outside_guests: 5, outsider_fee: 20, note: null, submitted_at: 'x' });
    usage.push({ day, ingredient_id: 1, qty: i < 20 ? 100 : 200 }); // eggs double
    usage.push({ day, ingredient_id: 2, qty: 10 });
  }
  return makeDataset({
    categories: CATEGORIES,
    ingredients: INGREDIENTS,
    settings: [{ key: 'currency', value: 'GHS' }, { key: 'timezone', value: 'Africa/Accra' }],
    stockCounts: [],
    serviceDays,
    usage,
    purchases: [
      { id: 1, day: '2026-05-01', ingredient_id: 1, qty: 20000, unit_cost: 1 },
      { id: 2, day: '2026-05-01', ingredient_id: 2, qty: 1000, unit_cost: 10 },
    ],
  });
}

test('two equal periods compare on totals, and name the item that moved', () => {
  const ds = comparableDataset();
  const result = compareInsights(
    ds,
    { from: '2026-05-21', to: '2026-05-30' }, // the doubled half
    { from: '2026-05-01', to: '2026-05-10' },
  );

  assert.equal(result.comparable.sameLength, true);
  assert.equal(result.comparable.totalsMeaningful, true);
  assert.equal(result.comparable.note, null);
  assert.equal(result.hasComparison, true);

  // Same guests either side, so the cost difference is entirely the eggs.
  assert.equal(result.deltas.guests, 0);
  assert.ok(result.deltas.cost > 0);

  const eggs = result.ingredients.find((i) => i.name === 'Eggs');
  assert.equal(eggs.aQty, 2000);
  assert.equal(eggs.bQty, 1000);
  assert.equal(eggs.deltaPerGuestPct, 100);
  assert.equal(result.risers[0].name, 'Eggs');
  assert.equal(result.fallers[0].name, 'Bread'); // unchanged, so bottom of the list
});

test('periods of different lengths are flagged and ranked per guest, not on totals', () => {
  const ds = comparableDataset();
  // 20 days against 5: the longer period wins on raw money no matter what.
  const result = compareInsights(
    ds,
    { from: '2026-05-01', to: '2026-05-20' },
    { from: '2026-05-21', to: '2026-05-25' },
  );

  assert.equal(result.comparable.sameLength, false);
  assert.equal(result.comparable.totalsMeaningful, false);
  assert.match(result.comparable.note, /different lengths \(20 days against 5\)/);
  assert.match(result.comparable.note, /per-guest/);

  // Raw cost favours the 20-day period, but per guest the eggs are down.
  assert.ok(result.a.cost > result.b.cost);
  const eggs = result.ingredients.find((i) => i.name === 'Eggs');
  assert.equal(eggs.deltaPerGuestPct, -50);
  assert.equal(result.fallers[0].name, 'Eggs');

  // The charts overlay by position, so each period keeps its own length.
  assert.equal(result.series.a.length, 20);
  assert.equal(result.series.b.length, 5);
});

test('an item used in only one period is still reported, not silently dropped', () => {
  const ds = comparableDataset();
  const result = compareInsights(
    ds,
    { from: '2026-05-21', to: '2026-05-30' },
    { from: '2026-05-01', to: '2026-05-10' },
  );
  assert.equal(result.ingredients.length, 2);

  // A period with no service at all: nothing to compare against.
  const empty = compareInsights(
    ds,
    { from: '2026-05-01', to: '2026-05-10' },
    { from: '2026-01-01', to: '2026-01-10' },
  );
  assert.equal(empty.hasComparison, false);
  assert.equal(empty.comparable.bServedDays, 0);
});

test('a delivery landing on negative stock is not priced against the shortfall', () => {
  // Book stock goes to −20 because a delivery was never keyed in. The next
  // real delivery brings it to +5. The shortfall is not stock, so the new
  // average must be the delivery's own price — not the whole delivery's value
  // divided by the 5 units left showing.
  const ledger = buildLedger({
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 0, default_unit_cost: 10 }],
    purchases: [{ day: '2026-03-10', ingredient_id: 1, qty: 25, unit_cost: 30 }],
    usage: [
      { day: '2026-03-05', ingredient_id: 1, qty: 20 },
      { day: '2026-03-11', ingredient_id: 1, qty: 1 },
    ],
  });

  assert.equal(ledger.entry(1, '2026-03-10').closingStock, 5);
  assert.equal(ledger.unitCostOn(1, '2026-03-10'), 30);
  // The next issue is costed at the honest price, not an inflated one.
  assert.equal(ledger.entry(1, '2026-03-11').usedCost, 30);
  assert.equal(ledger.entry(1, '2026-03-11').closingStock, 4);
});

test('stock value never disagrees with the unit cost being reported', () => {
  const ledger = buildLedger({
    ingredients: [{ ...INGREDIENTS[0], opening_stock: 10, default_unit_cost: 5 }],
    purchases: [
      { day: '2026-03-04', ingredient_id: 1, qty: 40, unit_cost: 8 },
      { day: '2026-03-09', ingredient_id: 1, qty: 30, unit_cost: 6 },
    ],
    usage: [
      { day: '2026-03-03', ingredient_id: 1, qty: 30 }, // drives it negative
      { day: '2026-03-05', ingredient_id: 1, qty: 5 },
      { day: '2026-03-10', ingredient_id: 1, qty: 12 },
    ],
  });

  for (const day of ['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-09', '2026-03-10']) {
    const entry = ledger.entry(1, day);
    assert.equal(
      Math.abs(entry.closingStock * entry.unitCost - ledger.stockOn(1, day) * ledger.unitCostOn(1, day)) < 0.01,
      true,
      `${day}: value and unit cost disagree`,
    );
    assert.ok(entry.unitCost >= 0 && entry.unitCost < 100, `${day}: unit cost ${entry.unitCost} is not plausible`);
  }
});

// ------------------------------------------------- the cleared entry sheet --

/**
 * The rule the entry screen applies: a submitted day opens blank for somebody
 * whose only permission is entry. Extracted here in the same shape the route
 * uses it, so the decision itself is pinned down even though the route needs a
 * database to run.
 */
function clearsForEntry(permissions, submittedAt) {
  const entryOnly = permissions.length === 1 && permissions[0] === 'entry';
  return entryOnly && Boolean(submittedAt);
}

test('a submitted day opens blank for a cook, and only for a cook', () => {
  // The cook, on a day already sent.
  assert.equal(clearsForEntry(['entry'], '2026-08-11T09:00:00Z'), true);

  // Same cook, day not submitted yet — a draft must survive being reopened,
  // or a morning's work disappears on a dropped connection.
  assert.equal(clearsForEntry(['entry'], null), false);

  // Anybody who can also see reports is reviewing, not recording, and needs
  // the figures in front of them to correct one.
  assert.equal(clearsForEntry(['entry', 'reports'], '2026-08-11T09:00:00Z'), false);
  assert.equal(clearsForEntry(['entry', 'reports', 'approvals'], '2026-08-11T09:00:00Z'), false);
  assert.equal(clearsForEntry(['entry', 'stock'], '2026-08-11T09:00:00Z'), false);
});

test('clearing the form never touches what was stored', () => {
  // The day still reads back in full from the dataset the reports are built
  // from — blanking is a decision about one screen, not about the record.
  const ds = build();
  const day = '2026-03-10';
  assert.equal(dayMetrics(ds, day).guests, 50);
  assert.equal(ds.usageByDay.get(day).size, 2);

  const insight = dailyInsights(ds, day);
  assert.equal(insight.today.guests, 50);
  assert.equal(insight.lines.length, 2);
});
