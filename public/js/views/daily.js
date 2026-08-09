import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, fmtDayShort, fmtMoney, fmtNum, h, mount, shiftDay } from '../util.js';
import { donutChart, lineChart, rankedBars } from '../charts.js';
import { alertList, card, exportButton, pctCell, statTile, table, unitCell } from './components.js';
import { printButton } from '../print.js';

/**
 * One morning in full detail: what it cost, how that compares with a normal
 * day of the same shape, and which specific items moved the number.
 */
export async function renderDaily(params) {
  const data = await api.daily(params.day);
  const t = data.today;
  const host = h('div');

  const reload = async (day) => {
    replaceParams('daily', { day });
    mount(host, await renderDaily({ day }));
  };

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.day, -1)) }, '‹ Previous day'),
    h('input', {
      type: 'date', value: data.day,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.day, 1)) }, 'Next day ›'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `Breakfast — ${fmtDay(data.day, { withYear: true })}`,
      subtitle: `${data.weekday} service · ${fmtNum(t.guests, 0)} guests`,
      note: 'Expected quantities are the usual rate per guest over the last 28 service days, '
        + 'scaled to this day’s headcount.',
    }),
    exportButton(api.exportUrl('usage', data.day, data.day), 'Export this day'),
  );

  if (!t.exists) {
    mount(host,
      h('div.page-head', h('h1', fmtDay(data.day, { withYear: true }))),
      nav,
      h('div.card.empty',
        h('h3', 'No service recorded for this day'),
        h('p', 'Either breakfast was not served, or the day sheet has not been entered yet.'),
      ),
    );
    return host;
  }

  const cmp = data.comparisons;

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({
      label: 'Guests served',
      value: fmtNum(t.guests, 0),
      sub: `${fmtNum(t.inhouse, 0)} in-house · ${fmtNum(t.outside, 0)} outside`,
      delta: cmp.last7.guestsDeltaPct,
      higherIsBetter: true,
    }),
    statTile({
      label: 'Food cost',
      value: fmtMoney(t.cost, { compact: true }),
      sub: `vs ${fmtMoney(cmp.last7.cost, { compact: true })} typical`,
      delta: cmp.last7.costDeltaPct,
    }),
    statTile({
      label: 'Cost per guest',
      value: fmtMoney(t.costPerGuest),
      sub: `7-day average ${fmtMoney(cmp.last7.costPerGuest)}`,
      delta: cmp.last7.costPerGuestDeltaPct,
      accent: 'var(--c3)',
    }),
    statTile({
      label: 'Outsider income',
      value: fmtMoney(t.revenue, { compact: true }),
      sub: t.outside
        ? `${fmtNum(t.outside, 0)} × ${fmtMoney(t.outsiderFee)} · ${fmtMoney(t.outsiderMargin)} above food cost`
        : 'no outside guests',
      accent: 'var(--good)',
    }),
  );

  const weekdayCard = card(`Against a typical ${data.weekday}`, { note: cmp.sameWeekday.label },
    h('div.grid.grid-3',
      statTile({ label: 'Guests', value: fmtNum(cmp.sameWeekday.guests, 1), sub: 'average' }),
      statTile({ label: 'Cost', value: fmtMoney(cmp.sameWeekday.cost, { compact: true }), sub: 'average' }),
      statTile({
        label: 'Cost / guest',
        value: fmtMoney(cmp.sameWeekday.costPerGuest),
        delta: cmp.sameWeekday.costPerGuestDeltaPct,
      }),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Comparing like with like matters: weekends usually run heavier than midweek, so the same-weekday view is the fairer benchmark.'),
  );

  const catSlices = data.categories.map((c, i) => ({ label: c.name, value: c.cost, color: `var(--c${(i % 8) + 1})` }));
  const categoryCard = card('Where the money went', { note: 'By category' },
    h('div.grid', { style: { gridTemplateColumns: 'auto 1fr', gap: '1rem', alignItems: 'center' } },
      donutChart({
        slices: catSlices,
        format: (v) => fmtMoney(v),
        centerValue: fmtMoney(t.cost, { compact: true, withSymbol: false }),
        centerLabel: 'total',
      }),
      rankedBars({
        rows: data.categories.map((c) => ({ label: c.name, value: c.cost })),
        format: (v) => fmtMoney(v, { compact: true }),
      }),
    ),
  );

  // Deviations, ordered by the money each one moved — the manager's real
  // question is "what did this cost me", not "what changed by the biggest %".
  const deviations = data.lines.filter((l) => l.flag !== 'normal');
  const varianceCard = card('Usage against expectation', {
    note: `Expected quantities are the median rate per guest over the last 28 service days, scaled to today's ${fmtNum(t.guests, 0)} guests`,
    wide: true,
  },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
      { key: 'qty', label: 'Used', align: 'right', format: (v, r) => unitCell(v, r.unit) },
      { key: 'expectedQty', label: 'Expected', align: 'right', format: (v, r) => unitCell(v, r.unit) },
      { key: 'deltaPct', label: 'Variance', align: 'right', format: pctCell },
      { key: 'costImpact', label: 'Cost impact', align: 'right', format: (v) => (v == null ? '—' : h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`, `${v > 0 ? '+' : ''}${fmtMoney(v, { withSymbol: false })}`)) },
      { key: 'perGuest', label: 'Per guest', align: 'right', format: (v, r) => (v == null ? '—' : `${fmtNum(v, 3)} ${r.unit}`) },
      { key: 'sampleDays', label: 'History', align: 'right', format: (v) => h('span.muted', `${v}d`) },
      { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
    ], data.lines, {
      rowClass: (r) => (r.flag === 'high' ? 'row-flag-high' : r.flag === 'low' ? 'row-flag-low' : ''),
      empty: 'No usage recorded for this day.',
    }),
    deviations.length
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        `${deviations.length} ${deviations.length === 1 ? 'item is' : 'items are'} outside their normal range for this headcount. Items with fewer than about a week of history are not flagged, because there is not yet enough to compare against.`)
      : null,
  );

  const trend = data.trend.slice(-28);
  const trendCard = card('Recent trend', {
    note: 'Cost per guest on the left axis, guests served on the right',
    wide: true,
  },
    lineChart({
      labels: trend.map((d) => fmtDayShort(d.day)),
      series: [
        { name: 'Cost per guest', values: trend.map((d) => d.costPerGuest), color: 'var(--c3)', area: true },
        { name: 'Guests', values: trend.map((d) => d.guests), color: 'var(--c1)', dashed: true, axis: 'right' },
      ],
      format: (v) => fmtMoney(v),
      rightFormat: (v) => `${fmtNum(v, 0)} guests`,
      height: 250,
    }),
  );

  const completeness = data.completeness;
  const qualityCard = card('Entry quality', { note: 'Was the sheet filled in fully?' },
    h('div.stat-value', { style: { color: completeness.score >= 90 ? 'var(--good)' : completeness.score >= 70 ? 'var(--warn)' : 'var(--bad)' } },
      `${fmtNum(completeness.score, 0)}%`),
    h('p.muted', { style: { fontSize: '.85rem' } },
      `${completeness.recorded} items recorded against ${completeness.expected} normally used on a service day.`),
    completeness.missing.length
      ? h('div',
        h('div.stat-label', { style: { marginBottom: '.35rem' } }, 'Not recorded'),
        h('div.btn-row', completeness.missing.slice(0, 12).map((m) => h('span.pill.warn', m.name))))
      : h('span.pill.good', 'Nothing missing'),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', fmtDay(data.day, { withYear: true })),
        h('div.sub', t.note ? `Note: ${t.note}` : `${data.weekday} breakfast service`),
      ),
      t.submitted ? h('span.pill.good', 'Submitted by kitchen') : h('span.pill.warn', 'Draft — not submitted'),
    ),
    nav,
    tiles,
    card('What stands out', { wide: true }, alertList(data.alerts, { empty: 'Every line item is within its normal range for this headcount.' })),
    h('div.grid.grid-2', categoryCard, weekdayCard),
    varianceCard,
    trendCard,
    qualityCard,
  );
  return host;
}
