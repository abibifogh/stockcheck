import { api } from '../api.js';
import { replaceParams } from '../app.js';
import {
  deltaBadge, fmtDay, fmtDayShort, fmtMoney, fmtNum, h, mount, shiftDay, shiftMonth, toast, todayISO,
} from '../util.js';
import { barChart, lineChart, rankedBars } from '../charts.js';
import { card, exportButton, pctCell, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * Any two periods, side by side.
 *
 * The week and month views always compare against the period immediately
 * before, which answers exactly one question. This answers the rest: this
 * August against last August, the month before a menu change against the month
 * after, a quiet season against a busy one.
 */
export async function renderCompare(params) {
  const ranges = readRanges(params);
  const host = h('div');

  const reload = (next) => {
    replaceParams('compare', next);
    renderCompare(next).then((view) => mount(host, view));
  };

  let data;
  try {
    data = await api.compare(ranges.a, ranges.b);
  } catch (err) {
    mount(host,
      h('div.page-head', h('h1', 'Compare periods')),
      picker(ranges, reload),
      h('div.card.empty', h('h3', 'That comparison could not be built'), h('p.muted', err.message)),
    );
    return host;
  }

  const { a, b, comparable } = data;

  // Different-length periods can only be compared per guest. Say so once,
  // clearly, rather than letting somebody read two totals as a like-for-like.
  const caveat = comparable.note
    ? h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'These periods are not the same size'),
        h('div.alert-detail', `${comparable.note} Totals are still shown, but the cost-per-guest `
          + 'figures are the ones that mean something here.'),
      ))
    : null;

  const emptyB = !data.hasComparison
    ? h('div.alert.info',
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', 'Nothing recorded in the second period'),
        h('div.alert-detail', 'There are no service days in that range, so there is nothing to '
          + 'compare against. Pick a period the kitchen was recording.'),
      ))
    : null;

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    compareTile('Guests served', fmtNum(a.guests, 0), fmtNum(b.guests, 0), data.deltas.guests, true),
    compareTile('Food cost', fmtMoney(a.cost, { compact: true }), fmtMoney(b.cost, { compact: true }), data.deltas.cost),
    compareTile('Cost per guest', fmtMoney(a.costPerGuest), fmtMoney(b.costPerGuest),
      data.deltas.costPerGuest, false, 'var(--c3)'),
    compareTile('Outsider income', fmtMoney(a.revenue, { compact: true }),
      fmtMoney(b.revenue, { compact: true }), data.deltas.revenue, true, 'var(--good)'),
  );

  const perDay = h('div.grid.grid-3', { style: { marginBottom: '1rem' } },
    compareTile('Service days', fmtNum(a.servedDays, 0), fmtNum(b.servedDays, 0), null),
    compareTile('Guests per day', fmtNum(a.avgGuestsPerDay, 1), fmtNum(b.avgGuestsPerDay, 1),
      data.deltas.avgGuestsPerDay, true),
    compareTile('Cost per day', fmtMoney(a.avgCostPerDay, { compact: true }),
      fmtMoney(b.avgCostPerDay, { compact: true }), data.deltas.avgCostPerDay),
  );

  // Overlaid by position rather than by date, so periods of different lengths
  // can still be read against each other.
  const span = Math.max(data.series.a.length, data.series.b.length);
  const overlay = card('Cost per guest, day by day', {
    note: 'Both periods laid over each other from their first day',
    wide: true,
  },
    lineChart({
      labels: Array.from({ length: span }, (_, i) => {
        const dayA = data.series.a[i];
        return dayA ? fmtDayShort(dayA.day) : `Day ${i + 1}`;
      }),
      series: [
        { name: a.label, values: padTo(data.series.a.map((d) => d.costPerGuest), span), color: 'var(--c1)', area: true },
        { name: b.label, values: padTo(data.series.b.map((d) => d.costPerGuest), span), color: 'var(--c4)', dashed: true },
      ],
      format: (v) => fmtMoney(v),
      height: 250,
    }),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
      'Dates along the bottom are from the first period. The dashed line is the same position within '
      + 'the second period, not the same calendar date.'),
  );

  const weekdayCard = card('By day of the week', { note: 'Cost per guest' },
    barChart({
      groups: data.weekday.map((w) => ({
        label: w.weekday,
        values: [
          { name: a.label, value: w.aCostPerGuest || 0, color: 'var(--c1)' },
          { name: b.label, value: w.bCostPerGuest || 0, color: 'var(--c4)', faded: true },
        ],
      })),
      format: (v) => fmtMoney(v),
      height: 230,
    }),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
      'A weekday that moved while the others held still usually points at a change in that day’s '
      + 'service rather than at prices.'),
  );

  const moversLabel = comparable.totalsMeaningful ? 'in spend' : 'in cost per guest';
  const moverValue = (m) => (comparable.totalsMeaningful
    ? m.deltaCost
    : Math.round(((m.aCostPerGuest ?? 0) - (m.bCostPerGuest ?? 0)) * 1000) / 1000);
  const moverFormat = (v) => (comparable.totalsMeaningful
    ? fmtMoney(Math.abs(v), { withSymbol: false })
    : fmtMoney(Math.abs(v)));

  const moversCard = card('What changed most', { note: `Ranked ${moversLabel}`, wide: true },
    h('div.grid.grid-2',
      h('div',
        h('div.stat-label', { style: { marginBottom: '.6rem' } }, `Higher in ${a.label}`),
        data.risers.length
          ? rankedBars({
            rows: data.risers.map((m) => ({ label: m.name, value: moverValue(m) })),
            format: (v) => `+${moverFormat(v)}`,
            colorFor: () => 'var(--bad)',
          })
          : h('p.muted', 'Nothing rose materially.'),
      ),
      h('div',
        h('div.stat-label', { style: { marginBottom: '.6rem' } }, `Lower in ${a.label}`),
        data.fallers.length
          ? rankedBars({
            rows: data.fallers.map((m) => ({ label: m.name, value: Math.abs(moverValue(m)) })),
            format: (v) => `−${moverFormat(v)}`,
            colorFor: () => 'var(--good)',
          })
          : h('p.muted', 'Nothing fell materially.'),
      ),
    ),
  );

  const categoryCard = card('By category', { wide: true },
    table([
      { key: 'name', label: 'Category' },
      { key: 'aCost', label: a.label, align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'bCost', label: b.label, align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'deltaPct', label: 'Change', align: 'right', format: pctCell },
      {
        key: 'aCostPerGuest',
        label: 'Per guest',
        align: 'right',
        format: (v, r) => h('span', fmtMoney(v, { withSymbol: false }),
          h('span.muted', ` vs ${fmtMoney(r.bCostPerGuest, { withSymbol: false })}`)),
      },
      { key: 'aShare', label: 'Share', align: 'right', format: (v, r) => `${fmtNum(v, 1)}% vs ${fmtNum(r.bShare, 1)}%` },
    ], data.categories, { empty: 'Nothing recorded in the first period.' }),
  );

  const ingredientCard = card('Every ingredient', {
    note: 'Per-guest change is the fair measure when the periods differ in size',
    wide: true,
  },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
      { key: 'aQty', label: `${a.label} qty`, align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'bQty', label: `${b.label} qty`, align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'aPerGuest', label: 'Per guest', align: 'right', format: (v, r) => (v == null ? '—' : `${fmtNum(v, 3)} ${r.unit}`) },
      { key: 'bPerGuest', label: 'Was', align: 'right', format: (v, r) => (v == null ? '—' : `${fmtNum(v, 3)} ${r.unit}`) },
      { key: 'deltaPerGuestPct', label: 'Per-guest change', align: 'right', format: pctCell },
      { key: 'deltaCost', label: 'Cost change', align: 'right', format: (v) => h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`, `${v > 0 ? '+' : ''}${fmtMoney(v, { withSymbol: false })}`) },
    ], data.ingredients, { empty: 'Nothing recorded in either period.' }),
  );

  const econCard = card('Outside guests', { note: 'Does the fee still cover the food?' },
    table([
      { key: 'label', label: '' },
      { key: 'a', label: a.label, align: 'right' },
      { key: 'b', label: b.label, align: 'right' },
    ], [
      { label: 'Paying guests', a: fmtNum(data.economics.a.guests, 0), b: fmtNum(data.economics.b.guests, 0) },
      { label: 'Revenue', a: fmtMoney(data.economics.a.revenue, { withSymbol: false }), b: fmtMoney(data.economics.b.revenue, { withSymbol: false }) },
      { label: 'Average fee', a: fmtMoney(data.economics.a.avgFee, { withSymbol: false }), b: fmtMoney(data.economics.b.avgFee, { withSymbol: false }) },
      { label: 'Break-even fee', a: fmtMoney(data.economics.a.breakEvenFee, { withSymbol: false }), b: fmtMoney(data.economics.b.breakEvenFee, { withSymbol: false }) },
      { label: 'Contribution after food', a: fmtMoney(data.economics.a.contribution, { withSymbol: false }), b: fmtMoney(data.economics.b.contribution, { withSymbol: false }) },
    ]),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'If the break-even fee has risen above what you charge, the fee has stopped covering the plate.'),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Compare periods'),
        h('div.sub', `${a.label} against ${b.label}`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Breakfast — period comparison',
          subtitle: `${fmtDay(a.from)} to ${fmtDay(a.to)}  ·  against  ·  ${fmtDay(b.from)} to ${fmtDay(b.to)}`,
          note: comparable.note || 'Both periods cover the same number of days.',
        }),
        exportButton(api.exportUrl('daily', a.from, a.to), 'Export first period'),
      ),
    ),
    picker(ranges, reload),
    caveat,
    emptyB,
    tiles,
    perDay,
    overlay,
    moversCard,
    h('div.grid.grid-2', weekdayCard, econCard),
    categoryCard,
    ingredientCard,
  );
  return host;
}

function padTo(values, length) {
  const out = values.slice();
  while (out.length < length) out.push(null);
  return out;
}

function compareTile(label, aValue, bValue, deltaValue, higherIsBetter = false, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, aValue),
    h('div.stat-sub',
      deltaValue != null ? deltaBadge(deltaValue, { higherIsBetter }) : null,
      h('span', `was ${bValue}`),
    ),
  );
}

// ---------------------------------------------------------------------------
// Choosing the periods
// ---------------------------------------------------------------------------

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/**
 * The same slice of an earlier month as the days elapsed so far in this one.
 *
 * Nine days of August against the whole of July is not a comparison, it is a
 * guaranteed 70% "saving". Month-to-date is always matched against the same
 * number of days in the month it is measured against.
 */
function alignedMonth(month, elapsedTo) {
  const end = monthEnd(month);
  const dayOfMonth = `${month}-${elapsedTo.slice(8)}`;
  return { from: `${month}-01`, to: dayOfMonth > end ? end : dayOfMonth };
}

/** Ranges from the URL, defaulting to this month against last month so far. */
function readRanges(params) {
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);
  const aligned = alignedMonth(lastMonth, today);

  return {
    a: { from: params.aFrom || `${thisMonth}-01`, to: params.aTo || today },
    b: { from: params.bFrom || aligned.from, to: params.bTo || aligned.to },
  };
}

/**
 * Presets exist because most comparisons people actually want are one of about
 * six shapes, and typing four dates to get one of them is a good way to make a
 * useful feature go unused.
 */
function presets() {
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);
  const yearAgo = shiftMonth(thisMonth, -12);

  return [
    {
      label: 'This month vs last month',
      a: { from: `${thisMonth}-01`, to: today },
      b: alignedMonth(lastMonth, today),
    },
    {
      label: 'Last 7 days vs the 7 before',
      a: { from: shiftDay(today, -6), to: today },
      b: { from: shiftDay(today, -13), to: shiftDay(today, -7) },
    },
    {
      label: 'Last 30 days vs the 30 before',
      a: { from: shiftDay(today, -29), to: today },
      b: { from: shiftDay(today, -59), to: shiftDay(today, -30) },
    },
    {
      label: 'Last 90 days vs the 90 before',
      a: { from: shiftDay(today, -89), to: today },
      b: { from: shiftDay(today, -179), to: shiftDay(today, -90) },
    },
    {
      label: 'This month vs the same month last year',
      a: { from: `${thisMonth}-01`, to: today },
      b: alignedMonth(yearAgo, today),
    },
    {
      label: 'Last full month vs the same month last year',
      a: { from: `${lastMonth}-01`, to: monthEnd(lastMonth) },
      b: { from: `${shiftMonth(lastMonth, -12)}-01`, to: monthEnd(shiftMonth(lastMonth, -12)) },
    },
  ];
}

function picker(ranges, reload) {
  const aFrom = h('input', { type: 'date', value: ranges.a.from });
  const aTo = h('input', { type: 'date', value: ranges.a.to });
  const bFrom = h('input', { type: 'date', value: ranges.b.from });
  const bTo = h('input', { type: 'date', value: ranges.b.to });

  const apply = () => {
    if (aFrom.value > aTo.value || bFrom.value > bTo.value) {
      toast('A start date cannot be after its end date', 'bad');
      return;
    }
    reload({ aFrom: aFrom.value, aTo: aTo.value, bFrom: bFrom.value, bTo: bTo.value });
  };

  /** Set the second period to the same length as the first, ending just before it. */
  const matchLength = () => {
    const days = Math.round((new Date(`${aTo.value}T12:00:00Z`) - new Date(`${aFrom.value}T12:00:00Z`)) / 86400000);
    const to = shiftDay(aFrom.value, -1);
    reload({ aFrom: aFrom.value, aTo: aTo.value, bFrom: shiftDay(to, -days), bTo: to });
  };

  return card('Which periods?', { note: 'Pick a preset, or set any two ranges yourself' },
    h('div.btn-row', { style: { marginBottom: '.9rem' } },
      presets().map((p) => h('button.btn-sm', {
        onclick: () => reload({ aFrom: p.a.from, aTo: p.a.to, bFrom: p.b.from, bTo: p.b.to }),
      }, p.label)),
    ),
    h('div.compare-picker',
      h('div',
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'First period'),
        h('div.field-row',
          h('label.field', h('span', 'From'), aFrom),
          h('label.field', h('span', 'To'), aTo),
        ),
      ),
      h('div',
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Compared against'),
        h('div.field-row',
          h('label.field', h('span', 'From'), bFrom),
          h('label.field', h('span', 'To'), bTo),
        ),
      ),
    ),
    h('div.btn-row',
      h('button.btn-primary', { onclick: apply }, 'Compare'),
      h('button.btn-sm', {
        onclick: matchLength,
        title: 'Set the second period to the same length, ending the day before the first begins',
      }, 'Use the period immediately before'),
    ),
  );
}
