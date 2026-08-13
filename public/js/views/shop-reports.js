import { api } from '../api.js';
import { navigate, replaceParams, routeParams } from '../app.js';
import {
  attributeSummary, fmtDayShort, fmtMoney, fmtNum, fmtPct, h, mount, todayISO,
} from '../util.js';
import {
  alertList, card, emptyState, exportButton, statTile, table,
} from './components.js';
import { donutChart, lineChart, rankedBars } from '../charts.js';
import { printButton } from '../print.js';

/**
 * What the craft shop is actually making.
 *
 * Every figure here comes in pairs: what came in, and what it had cost. A
 * takings number on its own is the one that lets a shop sell hard all season
 * and still lose money, so revenue never appears without margin beside it.
 */

const marginColour = (pct) => {
  if (pct == null) return undefined;
  if (pct < 0) return 'var(--bad)';
  if (pct < 20) return 'var(--warn)';
  return 'var(--good)';
};

export async function renderShopOverview() {
  const data = await api.shopOverview();
  const host = h('div');

  const chart = data.daily.some((d) => d.revenue > 0)
    ? lineChart({
      labels: data.daily.map((d) => fmtDayShort(d.day)),
      series: [
        { name: 'Takings', values: data.daily.map((d) => d.revenue), color: 'var(--c1)' },
        { name: 'Margin', values: data.daily.map((d) => d.margin), color: 'var(--c2)' },
      ],
      format: (v) => fmtMoney(v, { compact: true }),
      yLabel: 'Takings and margin',
    })
    : null;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.shopName),
        h('div.sub', 'Takings, margin and what is moving'),
      ),
      h('div.btn-row',
        printButton({ title: `${data.shopName} — overview` }),
        h('button.btn-sm', { onclick: () => navigate('shop-report') }, 'Full report'),
      ),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Taken today',
        value: fmtMoney(data.today.revenue, { compact: true }),
        sub: `${data.today.saleCount} ${data.today.saleCount === 1 ? 'sale' : 'sales'} · `
          + `${fmtMoney(data.today.cash, { compact: true })} cash, ${fmtMoney(data.today.card, { compact: true })} card`,
      }),
      statTile({
        label: 'Last 7 days',
        value: fmtMoney(data.week.revenue, { compact: true }),
        sub: data.week.marginPct != null ? `${fmtNum(data.week.marginPct, 1)}% margin` : 'nothing sold',
        accent: marginColour(data.week.marginPct),
      }),
      statTile({
        label: 'This month',
        value: fmtMoney(data.month.revenue, { compact: true }),
        sub: `${fmtMoney(data.month.margin, { compact: true })} margin on `
          + `${data.month.saleCount} ${data.month.saleCount === 1 ? 'sale' : 'sales'}`,
      }),
      statTile({
        label: 'Stock on the shelf',
        value: fmtMoney(data.stockValue, { compact: true }),
        sub: `worth ${fmtMoney(data.retailValue, { compact: true })} at today's prices`,
      }),
    ),

    data.alerts.length
      ? card('Needs your attention', { wide: true }, alertList(data.alerts))
      : card('Needs your attention', { wide: true },
        h('div.empty', h('p', 'Nothing stands out. Margin, stock levels and pricing all look reasonable.'))),

    chart ? card('Takings, day by day', { wide: true, note: 'Last three weeks' }, chart) : null,

    h('div.grid.grid-2',
      card('Best sellers this month', { note: 'By what they brought in' },
        data.best.length
          ? rankedBars({
            rows: data.best.map((i) => ({ label: i.name, value: i.revenue })),
            format: (v) => fmtMoney(v, { compact: true }),
          })
          : h('div.empty', h('p', 'Nothing sold yet this month.'))),

      card('Money sitting still', { note: 'Not sold in three months' },
        h('div.grid', { style: { gap: '.6rem' } },
          statTile({
            label: 'Unsold stock',
            value: fmtMoney(data.idleValue, { compact: true }),
            sub: 'at what it cost you',
            accent: data.idleValue > 0 ? 'var(--warn)' : undefined,
          }),
          statTile({
            label: 'Needs restocking',
            value: fmtNum(data.reorderCount, 0),
            sub: 'products below their level',
            accent: data.reorderCount ? 'var(--warn)' : undefined,
          }),
          data.pendingCounts
            ? statTile({
              label: 'Counts waiting',
              value: fmtNum(data.pendingCounts, 0),
              sub: 'for an administrator to accept',
              accent: 'var(--accent)',
            })
            : null,
        )),
    ),
  );

  return host;
}

// ---------------------------------------------------------------------------
// The full report
// ---------------------------------------------------------------------------

export async function renderShopReport() {
  const params = routeParams();
  const today = todayISO();
  const to = params.to || today;
  const from = params.from || shiftDays(to, -29);

  const data = await api.shopReport(from, to);
  const host = h('div');

  const fromInput = h('input', { type: 'date', value: from, max: today });
  const toInput = h('input', { type: 'date', value: to, max: today });

  const apply = async () => {
    replaceParams('shop-report', { from: fromInput.value, to: toInput.value });
    mount(host, await renderShopReport());
  };

  const preset = (label, days) => h('button.btn-sm', {
    onclick: () => {
      fromInput.value = shiftDays(today, -(days - 1));
      toInput.value = today;
      apply();
    },
  }, label);

  const chart = data.daily.some((d) => d.revenue > 0)
    ? lineChart({
      labels: data.daily.map((d) => fmtDayShort(d.day)),
      series: [
        { name: 'Takings', values: data.daily.map((d) => d.revenue), color: 'var(--c1)' },
        { name: 'What it cost', values: data.daily.map((d) => d.cost), color: 'var(--c3)' },
      ],
      format: (v) => fmtMoney(v, { compact: true }),
    })
    : null;

  const split = (data.current.cash > 0 || data.current.card > 0)
    ? donutChart({
      slices: [
        { label: 'Cash', value: data.current.cash, color: 'var(--c2)' },
        { label: 'Card', value: data.current.card, color: 'var(--c1)' },
      ],
      format: (v) => fmtMoney(v),
      centerLabel: 'Taken',
      centerValue: fmtMoney(data.current.revenue, { compact: true }),
    })
    : null;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Craft shop report'),
        h('div.sub', `${from} to ${to} · ${data.days} ${data.days === 1 ? 'day' : 'days'}`),
      ),
      h('div.btn-row',
        printButton({ title: `${data.shopName} — report`, subtitle: `${from} to ${to}` }),
        exportButton(api.shopExportUrl(from, to), 'Export sales'),
      ),
    ),

    h('div.toolbar', { style: { marginBottom: '1rem' } },
      h('label.field', h('span', 'From'), fromInput),
      h('label.field', h('span', 'To'), toInput),
      h('button.btn-sm.btn-primary', { onclick: apply }, 'Show'),
      preset('7 days', 7), preset('30 days', 30), preset('90 days', 90),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Takings',
        value: fmtMoney(data.current.revenue, { compact: true }),
        sub: `was ${fmtMoney(data.previous.revenue, { compact: true })}`,
        delta: data.change.revenue.changePct,
        higherIsBetter: true,
      }),
      statTile({
        label: 'Margin',
        value: fmtMoney(data.current.margin, { compact: true }),
        sub: data.current.marginPct != null ? `${fmtNum(data.current.marginPct, 1)}% of takings` : '—',
        delta: data.change.margin.changePct,
        higherIsBetter: true,
        accent: marginColour(data.current.marginPct),
      }),
      statTile({
        label: 'Sales',
        value: fmtNum(data.current.saleCount, 0),
        sub: `${fmtNum(data.current.units, 0)} items over the counter`,
        delta: data.change.saleCount.changePct,
        higherIsBetter: true,
      }),
      statTile({
        label: 'Average sale',
        value: fmtMoney(data.current.averageSale),
        sub: `was ${fmtMoney(data.previous.averageSale)}`,
        delta: data.change.averageSale.changePct,
        higherIsBetter: true,
      }),
    ),

    data.alerts.length ? card('Worth knowing', { wide: true }, alertList(data.alerts)) : null,

    chart ? card('Day by day', { wide: true, note: 'Takings against what the stock cost' }, chart) : null,

    h('div.grid.grid-2',
      split
        ? card('Cash and card', { note: 'Only one of the two can be short at the end of the day' },
          h('div', { style: { display: 'grid', placeItems: 'center' } }, split),
          h('p.muted', { style: { fontSize: '.83rem', textAlign: 'center', marginTop: '.6rem' } },
            `${fmtMoney(data.current.cash)} in the drawer · ${fmtMoney(data.current.card)} on the machine`))
        : null,

      card('By category', { note: 'Where the takings come from' },
        data.categories.length
          ? table([
            { key: 'name', label: 'Category' },
            { key: 'revenue', label: 'Takings', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
            { key: 'marginPct', label: 'Margin', align: 'right', format: (v) => (v == null ? '—' : h('span', { style: { color: marginColour(v) } }, `${fmtNum(v, 0)}%`)) },
            { key: 'shareOfRevenue', label: 'Share', align: 'right', format: (v) => `${fmtNum(v, 0)}%` },
          ], data.categories)
          : h('div.empty', h('p', 'Nothing sold in this period.'))),
    ),

    card('Every product sold', {
      wide: true,
      note: `${data.items.length} ${data.items.length === 1 ? 'product' : 'products'}, best first`,
    },
      data.items.length
        ? table([
          {
            key: 'name',
            label: 'Product',
            format: (v, r) => h('div', h('div', v),
              h('small.muted', [r.categoryName, attributeSummary(r.attributes)].filter(Boolean).join(' · '))),
          },
          { key: 'qty', label: 'Sold', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
          { key: 'revenue', label: 'Takings', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'margin', label: 'Margin', align: 'right', format: (v) => h('strong', fmtMoney(v, { withSymbol: false })) },
          {
            key: 'marginPct',
            label: '%',
            align: 'right',
            format: (v) => (v == null ? '—' : h('span', { style: { color: marginColour(v) } }, `${fmtNum(v, 0)}%`)),
          },
        ], data.items, { rowClass: (r) => (r.margin < 0 ? 'row-flag-high' : '') })
        : emptyState('Nothing sold in this period',
          'Change the dates, or start ringing sales up on the till screen.'),
    ),

    data.unsold.length
      ? card('On the shelf, but not sold in this period', {
        wide: true,
        note: `${fmtMoney(data.unsold.reduce((n, r) => n + r.value, 0), { compact: true })} tied up`,
      },
        table([
          { key: 'name', label: 'Product' },
          { key: 'stock', label: 'On shelf', align: 'right', format: (v, r) => `${fmtNum(v, 2)} ${r.unit}` },
          { key: 'value', label: 'At cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'retailValue', label: 'At retail', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
          { key: 'lastCountDay', label: 'Last counted', format: (v) => v || h('span.muted', 'never') },
        ], data.unsold))
      : null,
  );

  return host;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export async function renderShopCompare() {
  const params = routeParams();
  const today = todayISO();

  const a = {
    from: params.aFrom || shiftDays(today, -59),
    to: params.aTo || shiftDays(today, -30),
  };
  const b = { from: params.bFrom || shiftDays(today, -29), to: params.bTo || today };

  const data = await api.shopCompare(a, b);
  const host = h('div');

  const inputs = {
    aFrom: h('input', { type: 'date', value: a.from, max: today }),
    aTo: h('input', { type: 'date', value: a.to, max: today }),
    bFrom: h('input', { type: 'date', value: b.from, max: today }),
    bTo: h('input', { type: 'date', value: b.to, max: today }),
  };

  const apply = async () => {
    replaceParams('shop-compare', Object.fromEntries(
      Object.entries(inputs).map(([k, el]) => [k, el.value]),
    ));
    mount(host, await renderShopCompare());
  };

  const row = (label, left, right, change, format) => ({
    label,
    a: format(left),
    b: format(right),
    change: h('span', { style: { color: change.change > 0 ? 'var(--good)' : change.change < 0 ? 'var(--bad)' : undefined } },
      `${change.change > 0 ? '+' : ''}${format(change.change)}`),
    pct: change.changePct == null ? '—' : fmtPct(change.changePct),
  });

  const rows = [
    row('Takings', data.a.revenue, data.b.revenue, data.change.revenue, (v) => fmtMoney(v, { withSymbol: false })),
    row('Margin', data.a.margin, data.b.margin, data.change.margin, (v) => fmtMoney(v, { withSymbol: false })),
    row('Sales', data.a.saleCount, data.b.saleCount, data.change.saleCount, (v) => fmtNum(v, 0)),
    row('Average sale', data.a.averageSale, data.b.averageSale, data.change.averageSale, (v) => fmtMoney(v, { withSymbol: false })),
    row('Items sold', data.a.units, data.b.units, data.change.units, (v) => fmtNum(v, 0)),
  ];

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Compare two periods'),
        h('div.sub', 'Any two stretches of days, side by side'),
      ),
      printButton({ title: 'Craft shop — comparison' }),
    ),

    h('div.toolbar', { style: { marginBottom: '1rem' } },
      h('label.field', h('span', 'Period A from'), inputs.aFrom),
      h('label.field', h('span', 'to'), inputs.aTo),
      h('label.field', h('span', 'Period B from'), inputs.bFrom),
      h('label.field', h('span', 'to'), inputs.bTo),
      h('button.btn-sm.btn-primary', { onclick: apply }, 'Compare'),
    ),

    card('Side by side', { wide: true },
      table([
        { key: 'label', label: '' },
        { key: 'a', label: `A · ${data.a.from} to ${data.a.to}`, align: 'right' },
        { key: 'b', label: `B · ${data.b.from} to ${data.b.to}`, align: 'right' },
        { key: 'change', label: 'Change', align: 'right' },
        { key: 'pct', label: '%', align: 'right' },
      ], rows)),

    card('What moved most', { wide: true, note: 'By change in takings' },
      data.items.length
        ? table([
          { key: 'name', label: 'Product' },
          { key: 'a', label: 'A', align: 'right', format: (v) => fmtMoney(v.revenue, { withSymbol: false }) },
          { key: 'b', label: 'B', align: 'right', format: (v) => fmtMoney(v.revenue, { withSymbol: false }) },
          {
            key: 'change',
            label: 'Change',
            align: 'right',
            format: (v) => h('strong', { style: { color: v > 0 ? 'var(--good)' : v < 0 ? 'var(--bad)' : undefined } },
              `${v > 0 ? '+' : ''}${fmtMoney(v, { withSymbol: false })}`),
          },
        ], data.items)
        : h('div.empty', h('p', 'Nothing sold in either period.'))),
  );

  return host;
}

function shiftDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
