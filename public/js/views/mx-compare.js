import { api } from '../api.js';
import { replaceParams } from '../app.js';
import {
  deltaBadge, fmtDay, fmtDayShort, fmtMoney, fmtNum, fmtQty, h, mount, shiftDay, shiftMonth, toast, todayISO,
} from '../util.js';
import { lineChart } from '../charts.js';
import { card, pctCell, table } from './components.js';
import { printButton } from '../print.js';

/**
 * Any two periods of maintenance spending, side by side.
 *
 * The seasonal question is the one this answers: whether the rains cost more
 * than the dry months, whether a wing got better or worse after the rewiring,
 * whether this quarter is really worse than the last or just longer.
 */
export async function renderMxCompare(params = {}) {
  const ranges = readRanges(params);
  const host = h('div');

  const reload = (next) => {
    replaceParams('mx-compare', next);
    renderMxCompare(next).then((view) => mount(host, view));
  };

  let data;
  try {
    data = await api.mxCompare(ranges.a, ranges.b);
  } catch (err) {
    mount(host,
      h('div.page-head', h('h1', 'Compare periods')),
      picker(ranges, reload),
      h('div.card.empty', h('h3', 'That comparison could not be built'), h('p.muted', err.message)),
    );
    return host;
  }

  const { a, b, comparable } = data;

  const caveat = comparable.note
    ? h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'These periods are not the same size'),
        h('div.alert-detail', `${comparable.note} Totals are still shown, but the per-day figures `
          + 'are the ones that mean something here.'),
      ))
    : null;

  const tile = (label, value, was, delta) => h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', value),
    h('div.stat-sub',
      delta != null ? deltaBadge(delta) : null,
      h('span', `was ${was}`),
    ),
  );

  const span = Math.max(data.series.a.length, data.series.b.length);
  const pad = (values) => {
    const out = values.slice();
    while (out.length < span) out.push(null);
    return out;
  };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Compare periods'),
        h('div.sub', `${a.label} against ${b.label}`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Maintenance — period comparison',
          subtitle: `${fmtDay(a.from)} to ${fmtDay(a.to)}  ·  against  ·  ${fmtDay(b.from)} to ${fmtDay(b.to)}`,
          note: comparable.note || 'Both periods cover the same number of days.',
        }),
      ),
    ),

    picker(ranges, reload),
    caveat,

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      tile('Parts issued', fmtMoney(a.cost, { compact: true }), fmtMoney(b.cost, { compact: true }), data.deltas.cost),
      tile('Separate issues', fmtNum(a.issues, 0), fmtNum(b.issues, 0), data.deltas.issues),
      tile('Places touched', fmtNum(a.areasTouched, 0), fmtNum(b.areasTouched, 0), data.deltas.areasTouched),
      tile('Cost per active day', fmtMoney(a.costPerDay), fmtMoney(b.costPerDay), data.deltas.costPerDay),
    ),

    card('Day by day, laid over each other', {
      wide: true,
      note: 'Both periods drawn from their own first day',
    },
      lineChart({
        labels: Array.from({ length: span }, (_, i) => {
          const dayA = data.series.a[i];
          return dayA ? fmtDayShort(dayA.day) : `Day ${i + 1}`;
        }),
        series: [
          { name: a.label, values: pad(data.series.a.map((d) => d.cost)), color: 'var(--c1)', area: true },
          { name: b.label, values: pad(data.series.b.map((d) => d.cost)), color: 'var(--c4)', dashed: true },
        ],
        format: (v) => fmtMoney(v),
        height: 240,
      }),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
        'Dates along the bottom are from the first period. The dashed line is the same position '
        + 'within the second period, not the same calendar date.'),
    ),

    card('Room by room', { wide: true, note: 'Biggest movers first' },
      table([
        { key: 'name', label: 'Where', format: (v, r) => h('div', h('div', v), h('small.muted', r.kind === 'room' ? 'Room' : 'Area')) },
        { key: 'aCost', label: a.label, align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'bCost', label: b.label, align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        {
          key: 'deltaCost',
          label: 'Change',
          align: 'right',
          format: (v) => h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`,
            `${v > 0 ? '+' : ''}${fmtMoney(v, { withSymbol: false })}`),
        },
        { key: 'deltaPct', label: '%', align: 'right', format: pctCell },
      ], data.areas, { sortable: true, empty: 'Nothing issued in either period.' })),

    card('Part by part', { wide: true },
      table([
        { key: 'name', label: 'Part', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
        { key: 'aQty', label: `${a.label} qty`, align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'bQty', label: `${b.label} qty`, align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'aCost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'bCost', label: 'Was', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        {
          key: 'deltaCost',
          label: 'Change',
          align: 'right',
          format: (v) => h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`,
            `${v > 0 ? '+' : ''}${fmtMoney(v, { withSymbol: false })}`),
        },
      ], data.items, { sortable: true, empty: 'Nothing issued in either period.' })),
  );

  return host;
}

function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** The same slice of an earlier month as the days elapsed so far in this one. */
function alignedMonth(month, elapsedTo) {
  const end = monthEnd(month);
  const dayOfMonth = `${month}-${elapsedTo.slice(8)}`;
  return { from: `${month}-01`, to: dayOfMonth > end ? end : dayOfMonth };
}

function readRanges(params) {
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const aligned = alignedMonth(shiftMonth(thisMonth, -1), today);
  return {
    a: { from: params.aFrom || `${thisMonth}-01`, to: params.aTo || today },
    b: { from: params.bFrom || aligned.from, to: params.bTo || aligned.to },
  };
}

function presets() {
  const today = todayISO();
  const thisMonth = today.slice(0, 7);
  const lastMonth = shiftMonth(thisMonth, -1);
  const yearAgo = shiftMonth(thisMonth, -12);

  return [
    { label: 'This month vs last month', a: { from: `${thisMonth}-01`, to: today }, b: alignedMonth(lastMonth, today) },
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
    { label: 'This month vs the same month last year', a: { from: `${thisMonth}-01`, to: today }, b: alignedMonth(yearAgo, today) },
    {
      label: 'Last full month vs the same last year',
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
      h('button.btn-sm', { onclick: matchLength }, 'Use the period immediately before'),
    ),
  );
}
