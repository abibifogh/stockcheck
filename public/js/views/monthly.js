import { api } from '../api.js';
import { navigate, replaceParams } from '../app.js';
import { fmtDay, fmtDayShort, fmtMoney, fmtNum, h, mount, shiftMonth } from '../util.js';
import { barChart, donutChart, lineChart, rankedBars } from '../charts.js';
import { card, exportButton, pctCell, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * Month view — the owner's report. Costs, the economics of letting outsiders
 * buy in, what the store did, and where the month is heading.
 */
export async function renderMonthly(params) {
  const data = await api.monthly(params.month);
  const host = h('div');

  const reload = async (month) => {
    replaceParams('monthly', { month });
    mount(host, await renderMonthly({ month }));
  };

  const cur = data.current;
  const prev = data.previous;
  const econ = data.economics;
  const inv = data.inventory;

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftMonth(data.month, -1)) }, '‹ Previous month'),
    h('input', {
      type: 'month', value: data.month,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', { onclick: () => reload(shiftMonth(data.month, 1)) }, 'Next month ›'),
    h('div', { style: { flex: 1 } }),
    printButton({
      title: `Breakfast report — ${data.label}`,
      subtitle: `${fmtDay(data.from)} to ${fmtDay(data.to)} · ${cur.servedDays} service days · `
        + `${fmtNum(cur.guests, 0)} guests`,
      note: data.partial.isPartial
        ? `Month to date. ${data.partial.note}.`
        : 'A complete month, compared against the one before it.',
    }),
    exportButton(api.exportUrl('daily', data.from, data.to), 'Daily CSV'),
    exportButton(api.exportUrl('usage', data.from, data.to), 'Usage CSV'),
  );

  // With no history in the previous month there is nothing to compare against,
  // and saying so is more useful than printing a confident zero.
  const vsPrev = (text) => (data.hasComparison ? text : 'no comparable history yet');

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({
      label: 'Guests served',
      value: fmtNum(cur.guests, 0),
      sub: `${fmtNum(cur.servedDays, 0)} service days · ${fmtNum(cur.avgGuestsPerDay, 1)}/day`,
      delta: data.deltas.guests,
      higherIsBetter: true,
    }),
    statTile({
      label: 'Food cost',
      value: fmtMoney(cur.cost, { compact: true }),
      sub: vsPrev(`${fmtMoney(prev.cost, { compact: true })} in ${prev.month}`),
      delta: data.deltas.cost,
    }),
    statTile({
      label: 'Cost per guest',
      value: fmtMoney(cur.costPerGuest),
      sub: data.trend.spreadCostPerGuest
        ? `typical range ${fmtMoney(data.trend.spreadCostPerGuest.p10, { withSymbol: false })}–${fmtMoney(data.trend.spreadCostPerGuest.p90, { withSymbol: false })}`
        : '—',
      delta: data.deltas.costPerGuest,
      accent: 'var(--c3)',
    }),
    statTile({
      label: 'Outsider income',
      value: fmtMoney(cur.revenue, { compact: true }),
      sub: `${fmtNum(cur.outside, 0)} paying guests`,
      delta: data.deltas.revenue,
      higherIsBetter: true,
      accent: 'var(--good)',
    }),
  );

  const partialBanner = data.partial.isPartial
    ? h('div.alert.info', { style: { marginBottom: '1rem' } },
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', 'Month to date'),
        h('div.alert-detail',
          `${data.partial.elapsedDays} of ${data.partial.totalDays} days recorded. ${data.partial.note}. The full previous month came to ${fmtMoney(data.previousFullMonth.cost, { compact: true })}.`),
      ))
    : null;

  const projectionCard = data.projection
    ? card('Where the month is heading', { note: `${data.projection.elapsedDays} of ${data.projection.totalDays} days recorded` },
      h('div.grid.grid-3',
        statTile({ label: 'Projected food cost', value: fmtMoney(data.projection.projectedCost, { compact: true }) }),
        statTile({ label: 'Projected guests', value: fmtNum(data.projection.projectedGuests, 0) }),
        statTile({ label: 'Projected outsider income', value: fmtMoney(data.projection.projectedRevenue, { compact: true }), accent: 'var(--good)' }),
      ),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'A straight-line run rate from the days recorded so far. It assumes the rest of the month looks like the part already served.'))
    : null;

  // The question behind the outsider policy: does the fee cover what they eat?
  const feeVerdict = econ.breakEvenFee == null
    ? null
    : econ.avgFee >= econ.breakEvenFee
      ? h('span.pill.good', `Fee covers food cost with ${fmtMoney(econ.avgFee - econ.breakEvenFee)} to spare per guest`)
      : h('span.pill.bad', `Fee is ${fmtMoney(econ.breakEvenFee - econ.avgFee)} short of food cost per guest`);

  const outsiderCard = card('Outside guests', { note: 'Does the walk-in fee pay for itself?' },
    h('div.grid.grid-2',
      statTile({ label: 'Average fee charged', value: fmtMoney(econ.avgFee) }),
      statTile({ label: 'Food cost per guest', value: fmtMoney(econ.breakEvenFee), accent: 'var(--c3)' }),
    ),
    h('div.grid.grid-2', { style: { marginTop: '.6rem' } },
      statTile({ label: 'Revenue collected', value: fmtMoney(econ.outsiderRevenue, { compact: true }), accent: 'var(--good)' }),
      statTile({
        label: 'Contribution after food',
        value: fmtMoney(econ.outsiderContribution, { compact: true }),
        accent: econ.outsiderContribution >= 0 ? 'var(--good)' : 'var(--bad)',
      }),
    ),
    h('div', { style: { marginTop: '.7rem' } }, feeVerdict),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Contribution counts food only. Labour, gas and overheads are already being paid for the in-house service, which is what makes selling the spare covers worthwhile — but the fee still has to clear the plate cost.'),
  );

  const inventoryCard = card('Store movement', { note: 'Purchases against consumption' },
    h('div.grid.grid-2',
      statTile({ label: 'Purchased', value: fmtMoney(inv.purchaseValue, { compact: true }), sub: `${inv.purchaseCount} deliveries` }),
      statTile({ label: 'Consumed', value: fmtMoney(inv.usageValue, { compact: true }), sub: 'at weighted average cost' }),
    ),
    h('div.grid.grid-2', { style: { marginTop: '.6rem' } },
      statTile({
        label: inv.stockMovement >= 0 ? 'Stock built up' : 'Stock drawn down',
        value: fmtMoney(Math.abs(inv.stockMovement), { compact: true }),
        accent: inv.stockMovement >= 0 ? 'var(--c1)' : 'var(--warn)',
      }),
      statTile({ label: 'Closing store value', value: fmtMoney(inv.closingStockValue, { compact: true }) }),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Buying more than you consumed ties up cash in the store; consuming more than you bought means you are eating into earlier purchases. Neither is wrong on its own — a large gap month after month is what to watch.'),
  );

  const served = data.series.filter((d) => d.recorded);
  const dailyLine = card('Daily cost per guest', { note: 'Every service day this month', wide: true },
    lineChart({
      labels: served.map((d) => fmtDayShort(d.day)),
      series: [
        { name: 'Cost per guest', values: served.map((d) => d.costPerGuest), color: 'var(--c3)', area: true },
      ],
      format: (v) => fmtMoney(v),
      height: 250,
    }),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.5rem', marginBottom: 0 } },
      `Trend: ${data.trend.direction} (${data.trend.costPerGuestPerDay > 0 ? '+' : ''}${fmtMoney(data.trend.costPerGuestPerDay)} per service day). Median ${fmtMoney(data.trend.medianCostPerGuest)}.`),
  );

  const weekCard = card('Week by week', {},
    barChart({
      groups: data.weeks.map((w) => ({
        label: w.label,
        values: [{ name: 'Cost per guest', value: w.costPerGuest || 0, color: 'var(--c2)' }],
      })),
      format: (v) => fmtMoney(v),
      height: 220,
    }),
    table([
      { key: 'label', label: 'Week' },
      { key: 'guests', label: 'Guests', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'costPerGuest', label: 'Per guest', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
    ], data.weeks),
  );

  const catCard = card('Category mix', {},
    donutChart({
      slices: data.categories.map((c, i) => ({ label: c.name, value: c.cost, color: `var(--c${(i % 8) + 1})` })),
      format: (v) => fmtMoney(v),
      centerValue: fmtMoney(cur.cost, { compact: true, withSymbol: false }),
      centerLabel: 'total',
    }),
    rankedBars({
      rows: data.categories.map((c) => ({ label: c.name, value: c.cost })),
      format: (v) => fmtMoney(v, { compact: true, withSymbol: false }),
    }),
  );

  const topCard = card('Biggest cost drivers', { note: 'Top 12 ingredients by spend' },
    rankedBars({
      rows: data.ingredients.slice(0, 12).map((r) => ({ label: r.name, value: r.cost })),
      format: (v) => fmtMoney(v, { compact: true, withSymbol: false }),
    }),
  );

  const ingredientCard = card('Every ingredient', { note: 'Per-guest change against last month is the like-for-like measure', wide: true },
    table([
      { key: 'name', label: 'Ingredient', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
      { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
      { key: 'perGuest', label: 'Per guest', align: 'right', format: (v, r) => (v == null ? '—' : `${fmtNum(v, 3)} ${r.unit}`) },
      { key: 'deltaPerGuestPct', label: 'vs last month', align: 'right', format: pctCell },
      { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      { key: 'share', label: 'Share', align: 'right', format: (v) => `${fmtNum(v, 1)}%` },
      { key: 'daysUsed', label: 'Days used', align: 'right' },
      {
        key: 'volatility',
        label: 'Consistency',
        align: 'right',
        format: (v) => (v > 50 ? h('span.pill.bad', 'erratic') : v > 30 ? h('span.pill.warn', 'variable') : h('span.pill.good', 'steady')),
      },
    ], data.ingredients, { empty: 'No usage recorded this month.' }),
  );

  const dayCols = [
    { key: 'day', label: 'Date', format: (v) => h('a', { href: `#/daily?day=${v}`, onclick: (e) => { e.preventDefault(); navigate('daily', { day: v }); } }, fmtDay(v)) },
    { key: 'guests', label: 'Guests', align: 'right', format: (v) => fmtNum(v, 0) },
    { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
    { key: 'costPerGuest', label: 'Per guest', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
  ];

  const extremesCard = card('Best and worst days', { note: 'By cost per guest' },
    h('div.grid.grid-2',
      h('div', h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Leanest'), table(dayCols, data.best)),
      h('div', h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Heaviest'), table(dayCols, data.worst)),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
      'Very low days are worth opening too — they are sometimes a genuinely lean service, and sometimes a sheet that was only half filled in.'),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.label),
        h('div.sub', `${fmtDay(data.from)} → ${fmtDay(data.to)} · ${cur.servedDays} service days`),
      ),
    ),
    nav,
    partialBanner,
    tiles,
    projectionCard,
    dailyLine,
    h('div.grid.grid-2', outsiderCard, inventoryCard),
    h('div.grid.grid-2', weekCard, catCard),
    h('div.grid.grid-2', topCard, extremesCard),
    ingredientCard,
  );
  return host;
}
