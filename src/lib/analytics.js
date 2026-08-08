import { buildLedger } from './ledger.js';
import {
  addDays, addMonths, diffDays, dow, DOW_LABELS, monthBounds, monthOf, rangeDays, startOfWeek,
} from '../util/dates.js';
import {
  cv, mean, median, pctChange, percentile, relativeSpread, robustZ, round, slope, sum,
} from '../util/stats.js';

// Trailing window used to learn "normal" behaviour for an ingredient.
const BASELINE_DAYS = 28;
// A line item must have been recorded on at least this share of recent service
// days before we complain that it is missing today.
const HABITUAL_THRESHOLD = 0.6;
// Per-guest deviation that counts as notable, on top of the robust z-score.
const DEVIATION_PCT = 25;
const Z_THRESHOLD = 2;
// Below this relative spread an item's history is effectively a constant — a
// kitchen that always records ten loaves. A z-score says nothing there, so the
// percentage deviation alone decides.
const FLAT_SPREAD = 0.02;
// Minimum history before an item is judged at all.
const MIN_SAMPLE = 4;

/**
 * Load everything the analytics need in one shot.
 *
 * The whole history is pulled deliberately: correct weighted-average costing
 * and book stock both depend on every prior movement, and a breakfast unit's
 * dataset is a few tens of thousands of rows a year — small enough that a full
 * read is faster and far less error-prone than incremental bookkeeping.
 */
export async function loadDataset(db) {
  const [categories, ingredients, serviceDays, usage, purchases, settings, counts] = await Promise.all([
    db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM ingredients ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM service_days ORDER BY day').all(),
    db.prepare('SELECT day, ingredient_id, qty FROM usage ORDER BY day').all(),
    db.prepare('SELECT * FROM purchases ORDER BY day').all(),
    db.prepare('SELECT key, value FROM settings').all(),
    db.prepare('SELECT * FROM stock_counts ORDER BY day').all(),
  ]);

  return makeDataset({
    categories: categories.results ?? [],
    ingredients: ingredients.results ?? [],
    serviceDays: serviceDays.results ?? [],
    usage: usage.results ?? [],
    purchases: purchases.results ?? [],
    settings: settings.results ?? [],
    stockCounts: counts.results ?? [],
  });
}

export function makeDataset(raw) {
  const settings = Object.fromEntries((raw.settings ?? []).map((r) => [r.key, r.value]));
  const ingredientById = new Map(raw.ingredients.map((i) => [i.id, i]));
  const categoryById = new Map(raw.categories.map((c) => [c.id, c]));

  const serviceByDay = new Map(raw.serviceDays.map((d) => [d.day, d]));
  const usageByDay = new Map();
  for (const u of raw.usage) {
    if (!usageByDay.has(u.day)) usageByDay.set(u.day, new Map());
    usageByDay.get(u.day).set(u.ingredient_id, Number(u.qty) || 0);
  }

  const ledger = buildLedger({
    ingredients: raw.ingredients,
    purchases: raw.purchases,
    usage: raw.usage,
  });

  const dataset = {
    ...raw,
    settings,
    currency: settings.currency || 'GHS',
    timezone: settings.timezone || 'UTC',
    ingredientById,
    categoryById,
    serviceByDay,
    usageByDay,
    ledger,
    _dayCache: new Map(),
  };

  dataset.recordedDays = [...serviceByDay.keys()].sort();
  return dataset;
}

/** Core per-day roll-up. Everything else is built from this. */
export function dayMetrics(ds, day) {
  if (ds._dayCache.has(day)) return ds._dayCache.get(day);

  const svc = ds.serviceByDay.get(day);
  const usage = ds.usageByDay.get(day) ?? new Map();

  const inhouse = Number(svc?.inhouse_guests) || 0;
  const outside = Number(svc?.outside_guests) || 0;
  const guests = inhouse + outside;
  const fee = Number(svc?.outsider_fee) || 0;

  const lines = [];
  let cost = 0;
  for (const [ingredientId, qty] of usage) {
    const ing = ds.ingredientById.get(ingredientId);
    if (!ing) continue;
    const lineCost = ds.ledger.cost(ingredientId, day);
    cost += lineCost;
    lines.push({
      ingredientId,
      name: ing.name,
      unit: ing.unit,
      categoryId: ing.category_id,
      qty: round(qty, 3),
      cost: round(lineCost, 2),
      unitCost: ds.ledger.unitCostOn(ingredientId, day),
      perGuest: guests ? round(qty / guests, 4) : null,
    });
  }
  lines.sort((a, b) => b.cost - a.cost);

  const revenue = outside * fee;
  const metrics = {
    day,
    weekday: DOW_LABELS[dow(day)],
    exists: Boolean(svc),
    submitted: Boolean(svc?.submitted_at),
    inhouse,
    outside,
    guests,
    outsiderFee: fee,
    revenue: round(revenue, 2),
    cost: round(cost, 2),
    costPerGuest: guests ? round(cost / guests, 2) : null,
    outsiderShare: guests ? round((outside / guests) * 100, 1) : 0,
    // Outsiders eat the same food, so their attributable cost is the per-guest
    // cost times their headcount. Anything above that is contribution.
    outsiderMargin: guests ? round(revenue - (cost / guests) * outside, 2) : round(revenue, 2),
    lineCount: lines.length,
    lines,
    note: svc?.note ?? null,
  };

  ds._dayCache.set(day, metrics);
  return metrics;
}

/** Days with an actual service record, oldest first, within an optional range. */
function recordedDaysBetween(ds, from, to) {
  return ds.recordedDays.filter((d) => (!from || d >= from) && (!to || d <= to));
}

/** The N recorded service days strictly before `day`. */
function trailingDays(ds, day, n = BASELINE_DAYS) {
  const out = [];
  for (let i = ds.recordedDays.length - 1; i >= 0 && out.length < n; i--) {
    const d = ds.recordedDays[i];
    if (d < day) out.push(d);
  }
  return out.reverse();
}

function aggregate(ds, days) {
  const metrics = days.map((d) => dayMetrics(ds, d));
  const served = metrics.filter((m) => m.guests > 0);
  const guests = sum(metrics.map((m) => m.guests));
  const cost = sum(metrics.map((m) => m.cost));
  const revenue = sum(metrics.map((m) => m.revenue));
  const inhouse = sum(metrics.map((m) => m.inhouse));
  const outside = sum(metrics.map((m) => m.outside));

  return {
    days: days.length,
    servedDays: served.length,
    guests,
    inhouse,
    outside,
    outsiderShare: guests ? round((outside / guests) * 100, 1) : 0,
    cost: round(cost, 2),
    revenue: round(revenue, 2),
    costPerGuest: guests ? round(cost / guests, 2) : null,
    avgGuestsPerDay: served.length ? round(guests / served.length, 1) : 0,
    avgCostPerDay: served.length ? round(cost / served.length, 2) : 0,
    metrics,
  };
}

function categoryBreakdown(ds, days) {
  const totals = new Map();
  let grand = 0;
  for (const day of days) {
    for (const line of dayMetrics(ds, day).lines) {
      const prev = totals.get(line.categoryId) ?? 0;
      totals.set(line.categoryId, prev + line.cost);
      grand += line.cost;
    }
  }
  return [...totals.entries()]
    .map(([categoryId, cost]) => ({
      categoryId,
      name: ds.categoryById.get(categoryId)?.name ?? 'Uncategorised',
      cost: round(cost, 2),
      share: grand ? round((cost / grand) * 100, 1) : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

function ingredientTotals(ds, days) {
  const acc = new Map();
  let guests = 0;
  for (const day of days) {
    const m = dayMetrics(ds, day);
    guests += m.guests;
    for (const line of m.lines) {
      let row = acc.get(line.ingredientId);
      if (!row) {
        row = {
          ingredientId: line.ingredientId,
          name: line.name,
          unit: line.unit,
          categoryId: line.categoryId,
          categoryName: ds.categoryById.get(line.categoryId)?.name ?? 'Uncategorised',
          qty: 0,
          cost: 0,
          daysUsed: 0,
          perGuestSeries: [],
        };
        acc.set(line.ingredientId, row);
      }
      row.qty += line.qty;
      row.cost += line.cost;
      if (line.qty > 0) row.daysUsed += 1;
      if (line.perGuest != null) row.perGuestSeries.push(line.perGuest);
    }
  }

  return [...acc.values()]
    .map((row) => ({
      ...row,
      qty: round(row.qty, 3),
      cost: round(row.cost, 2),
      perGuest: guests ? round(row.qty / guests, 4) : null,
      costPerGuest: guests ? round(row.cost / guests, 3) : null,
      // How erratic the per-guest rate is. High values mean the item is either
      // being portioned inconsistently or recorded carelessly.
      volatility: round(cv(row.perGuestSeries) * 100, 1),
      perGuestSeries: undefined,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/**
 * The expected per-guest rate for an ingredient, learned from recent history.
 * Median rather than mean so one blow-out day does not move the yardstick.
 */
function baselineFor(ds, ingredientId, days) {
  const rates = [];
  let recordedOn = 0;
  for (const day of days) {
    const m = dayMetrics(ds, day);
    if (!m.guests) continue;
    const qty = ds.usageByDay.get(day)?.get(ingredientId);
    if (qty == null) continue;
    recordedOn += 1;
    rates.push(qty / m.guests);
  }
  return {
    rates,
    recordedOn,
    coverage: days.length ? recordedOn / days.length : 0,
    expectedPerGuest: rates.length ? median(rates) : null,
  };
}

// ---------------------------------------------------------------------------
// Daily
// ---------------------------------------------------------------------------

export function dailyInsights(ds, day) {
  const today = dayMetrics(ds, day);
  const trailing = trailingDays(ds, day, BASELINE_DAYS);
  const last7 = trailing.slice(-7);
  const sameWeekday = trailing.filter((d) => dow(d) === dow(day)).slice(-4);

  const prev7 = aggregate(ds, last7);
  const prevSameDow = aggregate(ds, sameWeekday);

  const cpgHistory = trailing
    .map((d) => dayMetrics(ds, d).costPerGuest)
    .filter((v) => v != null);

  const lines = [];
  const alerts = [];

  const activeIngredients = ds.ingredients.filter((i) => i.active);
  for (const ing of activeIngredients) {
    const qty = ds.usageByDay.get(day)?.get(ing.id);
    const base = baselineFor(ds, ing.id, trailing);
    const recorded = qty != null;

    // Habitual item with nothing keyed in today — most likely a forgotten entry.
    if (!recorded) {
      if (base.coverage >= HABITUAL_THRESHOLD && today.guests > 0) {
        alerts.push({
          level: 'warn',
          kind: 'missing_entry',
          ingredientId: ing.id,
          title: `${ing.name} not recorded`,
          detail: `Normally used on ${Math.round(base.coverage * 100)}% of service days. Expected about ${round((base.expectedPerGuest ?? 0) * today.guests, 2)} ${ing.unit}.`,
        });
      }
      continue;
    }

    const perGuest = today.guests ? qty / today.guests : null;
    const expectedQty = base.expectedPerGuest != null && today.guests
      ? base.expectedPerGuest * today.guests
      : null;
    const deltaQty = expectedQty != null ? qty - expectedQty : null;
    const deltaPct = expectedQty ? pctChange(expectedQty, qty) : null;
    const enoughHistory = base.rates.length >= MIN_SAMPLE;
    const z = perGuest != null && enoughHistory ? robustZ(perGuest, base.rates) : 0;

    // A perfectly steady item produces no z-score at all, so the deviation
    // percentage has to stand on its own there — otherwise the most
    // predictable items in the kitchen would be the only ones never flagged.
    const spread = enoughHistory ? relativeSpread(base.rates) : null;
    const flatHistory = spread != null && spread < FLAT_SPREAD;

    const notable = deltaPct != null
      && Math.abs(deltaPct) >= DEVIATION_PCT
      && enoughHistory
      && (Math.abs(z) >= Z_THRESHOLD || flatHistory);
    const unitCost = ds.ledger.unitCostOn(ing.id, day);

    const line = {
      ingredientId: ing.id,
      name: ing.name,
      unit: ing.unit,
      categoryId: ing.category_id,
      categoryName: ds.categoryById.get(ing.category_id)?.name ?? 'Uncategorised',
      qty: round(qty, 3),
      perGuest: perGuest != null ? round(perGuest, 4) : null,
      expectedPerGuest: base.expectedPerGuest != null ? round(base.expectedPerGuest, 4) : null,
      expectedQty: expectedQty != null ? round(expectedQty, 2) : null,
      deltaQty: deltaQty != null ? round(deltaQty, 2) : null,
      deltaPct: deltaPct != null ? round(deltaPct, 1) : null,
      costImpact: deltaQty != null ? round(deltaQty * unitCost, 2) : null,
      z: round(z, 2),
      cost: round(ds.ledger.cost(ing.id, day), 2),
      unitCost: round(unitCost, 2),
      sampleDays: base.rates.length,
      steadyHistory: flatHistory,
      flag: notable ? (deltaQty > 0 ? 'high' : 'low') : 'normal',
    };
    lines.push(line);

    if (notable) {
      alerts.push({
        level: Math.abs(z) >= 3 || (flatHistory && Math.abs(deltaPct) >= 100) ? 'high' : 'warn',
        kind: 'usage_deviation',
        ingredientId: ing.id,
        title: `${ing.name} ${deltaQty > 0 ? 'above' : 'below'} normal`,
        detail: `${round(qty, 2)} ${ing.unit} against an expected ${round(expectedQty, 2)} ${ing.unit} for ${today.guests} guests (${deltaPct > 0 ? '+' : ''}${round(deltaPct, 0)}%). Cost impact ${round(deltaQty * unitCost, 2)}.`,
        value: round(deltaQty * unitCost, 2),
      });
    }
  }

  lines.sort((a, b) => Math.abs(b.costImpact ?? 0) - Math.abs(a.costImpact ?? 0));

  // Day-level cost-per-guest sanity check against the trailing distribution.
  if (today.costPerGuest != null && cpgHistory.length >= 8) {
    const p90 = percentile(cpgHistory, 0.9);
    const p10 = percentile(cpgHistory, 0.1);
    if (today.costPerGuest > p90) {
      alerts.unshift({
        level: 'high',
        kind: 'cost_per_guest',
        title: 'Cost per guest above normal range',
        detail: `${today.costPerGuest} today against a typical ceiling of ${round(p90, 2)} over the last ${cpgHistory.length} service days.`,
      });
    } else if (today.costPerGuest < p10) {
      alerts.unshift({
        level: 'info',
        kind: 'cost_per_guest',
        title: 'Cost per guest unusually low',
        detail: `${today.costPerGuest} today against a typical floor of ${round(p10, 2)}. Worth confirming the entries are complete.`,
      });
    }
  }

  if (today.exists && today.guests === 0) {
    alerts.unshift({
      level: 'warn',
      kind: 'no_guests',
      title: 'No guest count recorded',
      detail: 'Usage cannot be analysed per guest until the headcount is entered.',
    });
  }

  const expectedLines = activeIngredients.filter((i) => baselineFor(ds, i.id, trailing).coverage >= HABITUAL_THRESHOLD);
  const missing = expectedLines.filter((i) => ds.usageByDay.get(day)?.get(i.id) == null);

  return {
    day,
    weekday: today.weekday,
    currency: ds.currency,
    today: {
      guests: today.guests,
      inhouse: today.inhouse,
      outside: today.outside,
      outsiderShare: today.outsiderShare,
      cost: today.cost,
      costPerGuest: today.costPerGuest,
      revenue: today.revenue,
      outsiderFee: today.outsiderFee,
      outsiderMargin: today.outsiderMargin,
      submitted: today.submitted,
      exists: today.exists,
      note: today.note,
    },
    comparisons: {
      last7: {
        label: 'Trailing 7 service days',
        sample: prev7.servedDays,
        guests: prev7.avgGuestsPerDay,
        cost: prev7.avgCostPerDay,
        costPerGuest: prev7.costPerGuest,
        guestsDeltaPct: delta(prev7.avgGuestsPerDay, today.guests),
        costDeltaPct: delta(prev7.avgCostPerDay, today.cost),
        costPerGuestDeltaPct: delta(prev7.costPerGuest, today.costPerGuest),
      },
      sameWeekday: {
        label: `Last ${sameWeekday.length} ${today.weekday}s`,
        sample: sameWeekday.length,
        guests: prevSameDow.avgGuestsPerDay,
        cost: prevSameDow.avgCostPerDay,
        costPerGuest: prevSameDow.costPerGuest,
        costPerGuestDeltaPct: delta(prevSameDow.costPerGuest, today.costPerGuest),
      },
    },
    categories: categoryBreakdown(ds, [day]),
    lines,
    topCosts: today.lines.slice(0, 8),
    alerts,
    completeness: {
      expected: expectedLines.length,
      recorded: today.lineCount,
      missing: missing.map((i) => ({ id: i.id, name: i.name, unit: i.unit })),
      score: expectedLines.length
        ? round(Math.min(1, today.lineCount / expectedLines.length) * 100, 0)
        : today.lineCount > 0 ? 100 : 0,
    },
    trend: trailing.concat(day).map((d) => {
      const m = dayMetrics(ds, d);
      return { day: d, guests: m.guests, cost: m.cost, costPerGuest: m.costPerGuest };
    }),
  };
}

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------

export function weeklyInsights(ds, weekStart) {
  const start = startOfWeek(weekStart);
  const end = addDays(start, 6);
  const prevStart = addDays(start, -7);
  const prevEnd = addDays(start, -1);

  const days = rangeDays(start, end);

  // A week in progress must not be compared against a full one — on a Tuesday
  // that would read as a 70% collapse in spend every single time. Only the
  // elapsed days are compared, against the same weekdays a week earlier.
  const lastRecorded = ds.recordedDays.at(-1) ?? end;
  const elapsedCount = Math.max(1, days.filter((d) => d <= lastRecorded).length);
  const isPartial = elapsedCount < 7;

  const comparedDays = days.slice(0, elapsedCount);
  const prevDays = rangeDays(prevStart, prevEnd);
  const prevComparedDays = prevDays.slice(0, elapsedCount);

  const current = aggregate(ds, comparedDays);
  const previous = aggregate(ds, prevComparedDays);
  const previousFull = aggregate(ds, prevDays);

  const currentTotals = ingredientTotals(ds, comparedDays);
  const previousTotals = new Map(ingredientTotals(ds, prevComparedDays).map((r) => [r.ingredientId, r]));

  // Movers are ranked on cost-per-guest so that a busy week does not read as
  // overspending simply because more people ate.
  const movers = currentTotals
    .map((row) => {
      const prev = previousTotals.get(row.ingredientId);
      const prevCpg = prev?.costPerGuest ?? null;
      const deltaCost = round(row.cost - (prev?.cost ?? 0), 2);
      return {
        ingredientId: row.ingredientId,
        name: row.name,
        unit: row.unit,
        categoryName: row.categoryName,
        cost: row.cost,
        prevCost: prev?.cost ?? 0,
        deltaCost,
        costPerGuest: row.costPerGuest,
        prevCostPerGuest: prevCpg,
        deltaCostPerGuestPct: prevCpg != null && row.costPerGuest != null
          ? round(pctChange(prevCpg, row.costPerGuest) ?? 0, 1)
          : null,
        perGuest: row.perGuest,
        prevPerGuest: prev?.perGuest ?? null,
        deltaPerGuestPct: prev?.perGuest != null && row.perGuest != null
          ? round(pctChange(prev.perGuest, row.perGuest) ?? 0, 1)
          : null,
      };
    })
    .filter((m) => m.prevCost > 0 || m.cost > 0);

  const risers = [...movers].sort((a, b) => b.deltaCost - a.deltaCost).slice(0, 6);
  const fallers = [...movers].sort((a, b) => a.deltaCost - b.deltaCost).slice(0, 6);

  // Day-of-week profile over the last 8 weeks, so the manager can see which
  // mornings genuinely run heavier.
  const profileWindow = rangeDays(addDays(start, -49), lastRecorded < end ? lastRecorded : end);
  const profile = DOW_LABELS.map((label, idx) => {
    const dowDays = profileWindow.filter((d) => dow(d) === idx && ds.serviceByDay.has(d));
    const agg = aggregate(ds, dowDays);
    return {
      weekday: label,
      sample: agg.servedDays,
      avgGuests: agg.avgGuestsPerDay,
      avgCost: agg.avgCostPerDay,
      costPerGuest: agg.costPerGuest,
    };
  });

  const erratic = currentTotals
    .filter((r) => r.daysUsed >= 3 && r.volatility > 35)
    .sort((a, b) => b.volatility - a.volatility)
    .slice(0, 6);

  const currentCats = categoryBreakdown(ds, comparedDays);
  const prevCats = new Map(categoryBreakdown(ds, prevComparedDays).map((c) => [c.categoryId, c]));

  return {
    weekStart: start,
    weekEnd: end,
    label: `${start} → ${end}`,
    currency: ds.currency,
    // When the week is still running, every figure below covers the elapsed
    // days only, and the previous week is cut to the same length.
    partial: {
      isPartial,
      elapsedDays: elapsedCount,
      comparedThrough: comparedDays[comparedDays.length - 1],
      note: isPartial
        ? `Comparing the first ${elapsedCount} ${elapsedCount === 1 ? 'day' : 'days'} of each week`
        : null,
    },
    current: stripMetrics(current),
    previous: stripMetrics(previous),
    previousFullWeek: stripMetrics(previousFull),
    deltas: {
      guests: delta(previous.guests, current.guests),
      cost: delta(previous.cost, current.cost),
      costPerGuest: delta(previous.costPerGuest, current.costPerGuest),
      revenue: delta(previous.revenue, current.revenue),
      outsiders: delta(previous.outside, current.outside),
    },
    hasComparison: previous.servedDays > 0,
    series: days.map((d) => {
      const m = dayMetrics(ds, d);
      const p = dayMetrics(ds, addDays(d, -7));
      return {
        day: d,
        weekday: m.weekday,
        guests: m.guests,
        inhouse: m.inhouse,
        outside: m.outside,
        cost: m.cost,
        costPerGuest: m.costPerGuest,
        prevGuests: p.guests,
        prevCost: p.cost,
        prevCostPerGuest: p.costPerGuest,
        recorded: m.exists,
      };
    }),
    categories: currentCats.map((c) => {
      const prev = prevCats.get(c.categoryId);
      return {
        ...c,
        prevCost: prev?.cost ?? 0,
        deltaPct: prev?.cost ? round(pctChange(prev.cost, c.cost) ?? 0, 1) : null,
      };
    }),
    risers,
    fallers,
    erratic,
    profile,
    ingredients: currentTotals,
    coverage: {
      recorded: days.filter((d) => ds.serviceByDay.has(d)).length,
      expected: days.filter((d) => d <= (ds.recordedDays.at(-1) ?? d)).length,
      missingDays: days.filter((d) => !ds.serviceByDay.has(d) && d <= (ds.recordedDays.at(-1) ?? '')),
    },
  };
}

function stripMetrics(agg) {
  const { metrics, ...rest } = agg;
  return rest;
}

/**
 * Percentage change that stays null when there is nothing to compare against.
 * Collapsing that to zero would report "no change" for a period with no
 * history at all, which reads as a verified fact rather than a missing one.
 */
function delta(previous, current) {
  // A missing figure on either side is not a 100% swing — it is an unknown.
  if (previous == null || current == null) return null;
  const value = pctChange(previous, current);
  return value == null ? null : round(value, 1);
}

// ---------------------------------------------------------------------------
// Monthly
// ---------------------------------------------------------------------------

export function monthlyInsights(ds, month) {
  const { from, to } = monthBounds(month);
  const prevMonth = addMonths(month, -1);
  const prevBounds = monthBounds(prevMonth);

  const days = rangeDays(from, to);
  const prevDays = rangeDays(prevBounds.from, prevBounds.to);

  // Month-to-date against a full previous month would always look like a
  // saving. Comparisons run over the same number of elapsed days.
  const lastRecorded = ds.recordedDays.at(-1) ?? to;
  const partialMonth = lastRecorded < to && monthOf(lastRecorded) === month;
  const elapsedDays = partialMonth ? diffDays(from, lastRecorded) + 1 : days.length;
  const prevComparedDays = prevDays.slice(0, Math.min(elapsedDays, prevDays.length));

  const current = aggregate(ds, days);
  const previous = aggregate(ds, prevComparedDays);
  const previousFull = aggregate(ds, prevDays);

  const totals = ingredientTotals(ds, days);
  const prevTotals = new Map(ingredientTotals(ds, prevComparedDays).map((r) => [r.ingredientId, r]));

  const purchasesInMonth = ds.purchases.filter((p) => p.day >= from && p.day <= to);
  const purchaseValue = round(sum(purchasesInMonth.map((p) => (Number(p.qty) || 0) * (Number(p.unit_cost) || 0))), 2);

  const closingStockValue = round(
    sum(ds.ingredients.filter((i) => i.active).map((i) => {
      const stock = ds.ledger.stockOn(i.id, to);
      return stock * ds.ledger.unitCostOn(i.id, to);
    })),
    2,
  );

  const weeks = [];
  let cursor = startOfWeek(from);
  while (cursor <= to) {
    const wEnd = addDays(cursor, 6);
    const wDays = rangeDays(cursor, wEnd).filter((d) => d >= from && d <= to);
    const agg = aggregate(ds, wDays);
    weeks.push({
      weekStart: cursor,
      weekEnd: wEnd,
      label: `${cursor.slice(5)} – ${wEnd.slice(5)}`,
      days: wDays.length,
      guests: agg.guests,
      cost: agg.cost,
      revenue: agg.revenue,
      costPerGuest: agg.costPerGuest,
    });
    cursor = addDays(cursor, 7);
  }

  const servedMetrics = current.metrics.filter((m) => m.guests > 0 && m.costPerGuest != null);
  const ranked = [...servedMetrics].sort((a, b) => a.costPerGuest - b.costPerGuest);

  const cpgSeries = servedMetrics.map((m) => m.costPerGuest);
  const trendPerDay = round(slope(cpgSeries), 3);

  // Projection for a month still in progress.
  const projection = partialMonth && elapsedDays > 0
    ? {
        elapsedDays,
        totalDays: days.length,
        projectedCost: round((current.cost / elapsedDays) * days.length, 2),
        projectedGuests: Math.round((current.guests / elapsedDays) * days.length),
        projectedRevenue: round((current.revenue / elapsedDays) * days.length, 2),
      }
    : null;

  return {
    month,
    label: new Date(`${from}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    from,
    to,
    currency: ds.currency,
    partial: {
      isPartial: partialMonth,
      elapsedDays,
      totalDays: days.length,
      note: partialMonth
        ? `Month to date — compared against the first ${elapsedDays} days of ${prevMonth}`
        : null,
    },
    current: stripMetrics(current),
    previous: { ...stripMetrics(previous), month: prevMonth },
    previousFullMonth: { ...stripMetrics(previousFull), month: prevMonth },
    deltas: {
      guests: delta(previous.guests, current.guests),
      cost: delta(previous.cost, current.cost),
      costPerGuest: delta(previous.costPerGuest, current.costPerGuest),
      revenue: delta(previous.revenue, current.revenue),
    },
    hasComparison: previous.servedDays > 0,
    inventory: {
      purchaseValue,
      usageValue: current.cost,
      // Positive means the store grew this month; negative means you ate stock
      // bought in an earlier month.
      stockMovement: round(purchaseValue - current.cost, 2),
      closingStockValue,
      purchaseCount: purchasesInMonth.length,
    },
    economics: {
      outsiderRevenue: current.revenue,
      outsiderGuests: current.outside,
      inhouseGuests: current.inhouse,
      avgFee: current.outside ? round(current.revenue / current.outside, 2) : 0,
      outsiderFoodCost: current.costPerGuest != null ? round(current.costPerGuest * current.outside, 2) : 0,
      outsiderContribution: current.costPerGuest != null
        ? round(current.revenue - current.costPerGuest * current.outside, 2)
        : current.revenue,
      breakEvenFee: current.costPerGuest,
    },
    weeks,
    series: days.map((d) => {
      const m = dayMetrics(ds, d);
      return {
        day: d,
        weekday: m.weekday,
        guests: m.guests,
        inhouse: m.inhouse,
        outside: m.outside,
        cost: m.cost,
        costPerGuest: m.costPerGuest,
        recorded: m.exists,
      };
    }),
    categories: categoryBreakdown(ds, days),
    ingredients: totals.map((row) => {
      const prev = prevTotals.get(row.ingredientId);
      return {
        ...row,
        prevCost: prev?.cost ?? 0,
        prevPerGuest: prev?.perGuest ?? null,
        deltaCostPct: prev?.cost ? round(pctChange(prev.cost, row.cost) ?? 0, 1) : null,
        deltaPerGuestPct: prev?.perGuest != null && row.perGuest != null
          ? round(pctChange(prev.perGuest, row.perGuest) ?? 0, 1)
          : null,
        share: current.cost ? round((row.cost / current.cost) * 100, 1) : 0,
      };
    }),
    best: ranked.slice(0, 3).map(slimDay),
    worst: ranked.slice(-3).reverse().map(slimDay),
    trend: {
      costPerGuestPerDay: trendPerDay,
      direction: trendPerDay > 0.01 ? 'rising' : trendPerDay < -0.01 ? 'falling' : 'flat',
      medianCostPerGuest: round(median(cpgSeries), 2),
      spreadCostPerGuest: cpgSeries.length
        ? { p10: round(percentile(cpgSeries, 0.1), 2), p90: round(percentile(cpgSeries, 0.9), 2) }
        : null,
    },
    projection,
  };
}

function slimDay(m) {
  return {
    day: m.day,
    weekday: m.weekday,
    guests: m.guests,
    cost: m.cost,
    costPerGuest: m.costPerGuest,
  };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export function stockReport(ds, asOf) {
  const window = 14;
  const recent = ds.recordedDays.filter((d) => d <= asOf).slice(-window);
  const servedDays = recent.filter((d) => dayMetrics(ds, d).guests > 0).length || 1;

  const rows = ds.ingredients
    .filter((i) => i.active)
    .map((ing) => {
      const stock = ds.ledger.stockOn(ing.id, asOf);
      const unitCost = ds.ledger.unitCostOn(ing.id, asOf);
      const used = sum(recent.map((d) => ds.usageByDay.get(d)?.get(ing.id) ?? 0));
      const dailyRate = used / servedDays;
      const daysCover = dailyRate > 1e-9 ? round(stock / dailyRate, 1) : null;
      const par = Number(ing.par_level) || 0;

      const count = ds.stockCounts
        .filter((c) => c.ingredient_id === ing.id && c.day <= asOf)
        .at(-1);
      const variance = count ? round(Number(count.counted_qty) - ds.ledger.stockOn(ing.id, count.day), 3) : null;

      let status = 'ok';
      if (stock < 0) status = 'negative';
      else if (par > 0 && stock < par) status = 'below_par';
      else if (daysCover != null && daysCover < 3) status = 'low_cover';

      return {
        ingredientId: ing.id,
        name: ing.name,
        unit: ing.unit,
        categoryId: ing.category_id,
        categoryName: ds.categoryById.get(ing.category_id)?.name ?? 'Uncategorised',
        stock: round(stock, 3),
        parLevel: par,
        unitCost: round(unitCost, 2),
        value: round(stock * unitCost, 2),
        avgDailyUse: round(dailyRate, 3),
        daysCover,
        suggestedOrder: par > 0 && stock < par ? round(par - stock, 2) : 0,
        lastCountDay: count?.day ?? null,
        lastCountQty: count ? round(Number(count.counted_qty), 3) : null,
        countVariance: variance,
        countVarianceValue: variance != null ? round(variance * unitCost, 2) : null,
        status,
      };
    })
    .sort((a, b) => {
      const rank = { negative: 0, below_par: 1, low_cover: 2, ok: 3 };
      return rank[a.status] - rank[b.status] || (a.daysCover ?? 999) - (b.daysCover ?? 999);
    });

  return {
    asOf,
    currency: ds.currency,
    totalValue: round(sum(rows.map((r) => r.value)), 2),
    reorder: rows.filter((r) => r.status !== 'ok'),
    shrinkage: rows
      .filter((r) => r.countVariance != null && Math.abs(r.countVarianceValue) > 0.01)
      .sort((a, b) => a.countVarianceValue - b.countVarianceValue),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Entry-screen hints
// ---------------------------------------------------------------------------

/**
 * "Usual" quantities for the entry screen. Given tonight's headcount the cooks
 * get a one-tap suggestion per item, which is what keeps data entry to seconds
 * without pre-filling the form and inviting rubber-stamped numbers.
 */
export function entryHints(ds, day, guests) {
  const trailing = trailingDays(ds, day, BASELINE_DAYS);
  const hints = {};
  for (const ing of ds.ingredients) {
    if (!ing.active) continue;
    const base = baselineFor(ds, ing.id, trailing);
    const recentQty = trailing
      .map((d) => ds.usageByDay.get(d)?.get(ing.id))
      .filter((q) => q != null);
    hints[ing.id] = {
      usualQty: recentQty.length ? round(median(recentQty), 2) : null,
      perGuest: base.expectedPerGuest != null ? round(base.expectedPerGuest, 4) : null,
      suggested: base.expectedPerGuest != null && guests
        ? round(base.expectedPerGuest * guests, 2)
        : recentQty.length ? round(median(recentQty), 2) : null,
      coverage: round(base.coverage * 100, 0),
      sampleDays: recentQty.length,
      lastQty: recentQty.length ? recentQty[recentQty.length - 1] : null,
    };
  }
  return hints;
}
