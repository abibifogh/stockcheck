import { api } from '../api.js';
import { navigate, replaceParams } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, shiftDay } from '../util.js';
import { barChart, lineChart, rankedBars } from '../charts.js';
import { card, exportButton, pctCell, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * Week view. The whole point is comparison: this week against last week, and
 * each weekday against how that weekday normally behaves.
 */
export async function renderWeekly(params) {
  const data = await api.weekly(params.week);
  const host = h('div');

  const reload = async (week) => {
    replaceParams('weekly', { week });
    mount(host, await renderWeekly({ week }));
  };

  const cur = data.current;
  const prev = data.previous;

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.weekStart, -7)) }, '‹ Previous week'),
    h('input', {
      type: 'date', value: data.weekStart,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', { onclick: () => reload(shiftDay(data.weekStart, 7)) }, 'Next week ›'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `Breakfast week — ${fmtDay(data.weekStart)} to ${fmtDay(data.weekEnd)}`,
      subtitle: `${cur.servedDays} service days · ${fmtNum(cur.guests, 0)} guests`,
      note: data.partial.isPartial
        ? `${data.partial.note}, so the comparison with last week is like for like.`
        : 'Compared against the previous week, day for day.',
    }),
    h('button.btn-sm', {
      // Carry the same elapsed-day alignment this view used, so a week still
      // in progress does not arrive there measured against a full one.
      onclick: () => navigate('compare', {
        aFrom: data.compared.from, aTo: data.compared.to,
        bFrom: data.previousCompared.from, bTo: data.previousCompared.to,
      }),
      title: 'Compare this week against any other period',
    }, '⇄ Compare with…'),
    exportButton(api.exportUrl('daily', data.weekStart, data.weekEnd), 'Export week'),
  );

  const partialBanner = data.partial.isPartial
    ? h('div.alert.info', { style: { marginBottom: '1rem' } },
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', 'This week is still running'),
        h('div.alert-detail',
          `${data.partial.note}, so the comparison is like for like. A full week last week came to ${fmtMoney(data.previousFullWeek.cost, { compact: true })} across ${fmtNum(data.previousFullWeek.guests, 0)} guests.`),
      ))
    : null;

  const vsPrev = (text) => (data.hasComparison ? text : 'no comparable history yet');

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({
      label: 'Guests served',
      value: fmtNum(cur.guests, 0),
      sub: vsPrev(`${fmtNum(prev.guests, 0)} last week`),
      delta: data.deltas.guests,
      higherIsBetter: true,
    }),
    statTile({
      label: 'Food cost',
      value: fmtMoney(cur.cost, { compact: true }),
      sub: vsPrev(`${fmtMoney(prev.cost, { compact: true })} last week`),
      delta: data.deltas.cost,
    }),
    statTile({
      label: 'Cost per guest',
      value: fmtMoney(cur.costPerGuest),
      sub: vsPrev(`${fmtMoney(prev.costPerGuest)} last week`),
      delta: data.deltas.costPerGuest,
      accent: 'var(--c3)',
    }),
    statTile({
      label: 'Outsider income',
      value: fmtMoney(cur.revenue, { compact: true }),
      sub: `${fmtNum(cur.outside, 0)} paying guests (${fmtNum(cur.outsiderShare, 1)}% of covers)`,
      delta: data.deltas.revenue,
      higherIsBetter: true,
      accent: 'var(--good)',
    }),
  );

  const dailyCompare = card('This week against last week', { note: 'Same weekday, side by side', wide: true },
    barChart({
      groups: data.series.map((d) => ({
        label: d.weekday,
        values: [
          { name: 'This week', value: d.cost, color: 'var(--c1)' },
          { name: 'Last week', value: d.prevCost, color: 'var(--c4)', faded: true },
        ],
      })),
      format: (v) => fmtMoney(v),
      height: 240,
    }),
  );

  const cpgLine = card('Cost per guest through the week', { note: 'Dashed line is the week before' },
    lineChart({
      labels: data.series.map((d) => d.weekday),
      series: [
        { name: 'This week', values: data.series.map((d) => d.costPerGuest), color: 'var(--c3)', area: true },
        { name: 'Last week', values: data.series.map((d) => d.prevCostPerGuest), color: 'var(--c4)', dashed: true },
      ],
      format: (v) => fmtMoney(v),
      height: 240,
    }),
  );

  const profileCard = card('Weekday pattern', { note: 'Averages over the last 8 weeks' },
    barChart({
      groups: data.profile.map((p) => ({
        label: p.weekday,
        values: [{ name: 'Cost per guest', value: p.costPerGuest || 0, color: 'var(--c2)' }],
      })),
      format: (v) => fmtMoney(v),
      height: 220,
    }),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
      'Use this to set expectations rather than to judge a single morning — a heavier Sunday is a pattern, not a problem.'),
  );

  const moversCard = card('What moved', { note: 'Change in spend against last week', wide: true },
    h('div.grid.grid-2',
      h('div',
        h('div.stat-label', { style: { marginBottom: '.6rem' } }, 'Rising'),
        data.risers.length
          ? rankedBars({
            rows: data.risers.map((m) => ({ label: m.name, value: m.deltaCost })),
            format: (v) => `+${fmtMoney(v, { withSymbol: false })}`,
            colorFor: () => 'var(--bad)',
          })
          : h('p.muted', 'Nothing rose materially.'),
      ),
      h('div',
        h('div.stat-label', { style: { marginBottom: '.6rem' } }, 'Falling'),
        data.fallers.length
          ? rankedBars({
            rows: data.fallers.map((m) => ({ label: m.name, value: Math.abs(m.deltaCost) })),
            format: (v) => `−${fmtMoney(v, { withSymbol: false })}`,
            colorFor: () => 'var(--good)',
          })
          : h('p.muted', 'Nothing fell materially.'),
      ),
    ),
  );

  const categoryCard = card('Category spend', { note: 'Against the previous week', wide: true },
    table([
      { key: 'name', label: 'Category' },
      { key: 'cost', label: 'This week', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'prevCost', label: 'Last week', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'deltaPct', label: 'Change', align: 'right', format: pctCell },
      { key: 'share', label: 'Share', align: 'right', format: (v) => `${fmtNum(v, 1)}%` },
    ], data.categories, { empty: 'No usage recorded this week.' }),
  );

  const ingredientCard = card('Ingredient detail', { note: 'Per-guest rates make weeks with different occupancy comparable', wide: true },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
      { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'perGuest', label: 'Per guest', align: 'right', format: (v, r) => (v == null ? '—' : `${fmtNum(v, 3)} ${r.unit}`) },
      { key: 'deltaPerGuestPct', label: 'vs last week', align: 'right', format: pctCell },
      { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'costPerGuest', label: 'Cost/guest', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'daysUsed', label: 'Days used', align: 'right' },
      {
        key: 'volatility',
        label: 'Consistency',
        align: 'right',
        format: (v) => (v > 50
          ? h('span.pill.bad', 'erratic')
          : v > 30 ? h('span.pill.warn', 'variable') : h('span.pill.good', 'steady')),
      },
    ], data.ingredients.map((row) => ({
      ...row,
      deltaPerGuestPct: data.risers.concat(data.fallers).find((m) => m.ingredientId === row.ingredientId)?.deltaPerGuestPct ?? null,
    })), { empty: 'No usage recorded this week.' }),
  );

  const erraticCard = data.erratic.length
    ? card('Portioning to look at', { note: 'Per-guest usage swinging more than a third week to week' },
      table([
        { key: 'name', label: 'Ingredient' },
        { key: 'volatility', label: 'Swing', align: 'right', format: (v) => `${fmtNum(v, 0)}%` },
        { key: 'daysUsed', label: 'Days', align: 'right' },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      ], data.erratic),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
        'A wide swing usually means portioning is being eyeballed differently shift to shift, or the quantity is being estimated at the end of service rather than measured.'),
    )
    : null;

  const missing = data.coverage.missingDays;
  const coverageNote = missing.length
    ? card('Gaps in the record', { note: 'Days with no sheet' },
      h('div.btn-row', missing.map((d) => h('span.pill.warn', fmtDay(d)))),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'These days are excluded from every average above, so the comparisons stay honest.'))
    : null;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', `Week of ${fmtDay(data.weekStart)}`),
        h('div.sub', `${fmtDay(data.weekStart)} → ${fmtDay(data.weekEnd)} · ${cur.servedDays} service days${data.partial.isPartial ? ' so far' : ''}`),
      ),
    ),
    nav,
    partialBanner,
    tiles,
    h('div.grid.grid-2', dailyCompare, cpgLine),
    moversCard,
    h('div.grid.grid-2', profileCard, erraticCard || coverageNote),
    categoryCard,
    ingredientCard,
    erraticCard && coverageNote ? coverageNote : null,
  );
  return host;
}
