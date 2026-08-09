import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, fmtDayShort, fmtMoney, fmtNum, h } from '../util.js';
import { lineChart, barChart } from '../charts.js';
import { alertList, card, emptyState, statTile } from './components.js';
import { printButton } from '../print.js';

/** The landing screen: where we stand today, and what needs a decision. */
export async function renderOverview() {
  const data = await api.overview();
  const k = data.headline;

  if (!data.trend.length) {
    return emptyState(
      'No breakfast days recorded yet',
      'Once the kitchen submits its first day sheet, the analytics will appear here.',
    );
  }

  const trendDays = data.trend;
  const cpgSpark = trendDays.map((d) => d.costPerGuest);
  const guestSpark = trendDays.map((d) => d.guests);

  const tiles = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({
      label: `Latest day · ${fmtDayShort(data.latestDay)}`,
      value: fmtNum(k.guests, 0),
      sub: 'guests served',
      spark: guestSpark,
      accent: 'var(--c1)',
    }),
    statTile({
      label: 'Cost per guest',
      value: fmtMoney(k.costPerGuest),
      sub: 'latest day',
      spark: cpgSpark,
      accent: 'var(--c3)',
    }),
    statTile({
      label: 'This week',
      value: fmtMoney(k.weekCost, { compact: true }),
      sub: `${fmtNum(k.weekGuests, 0)} guests · ${fmtMoney(k.weekCostPerGuest)}/guest`,
      delta: k.weekCostDeltaPct,
    }),
    statTile({
      label: 'Month to date',
      value: fmtMoney(k.monthCost, { compact: true }),
      sub: `${fmtNum(k.monthGuests, 0)} guests · ${fmtMoney(k.monthCostPerGuest)}/guest`,
    }),
  );

  const secondary = h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
    statTile({
      label: 'Outsider revenue (month)',
      value: fmtMoney(k.monthRevenue, { compact: true }),
      sub: 'paid breakfast guests',
      accent: 'var(--good)',
    }),
    statTile({
      label: 'Stock on hand',
      value: fmtMoney(k.stockValue, { compact: true }),
      sub: 'book value of the store',
    }),
    statTile({
      label: 'Needs reordering',
      value: fmtNum(k.reorderCount, 0),
      sub: k.reorderCount ? 'items below par or running out' : 'everything above par',
      accent: k.reorderCount ? 'var(--warn)' : 'var(--good)',
    }),
    statTile({
      label: 'Today',
      value: data.todayRecorded ? 'Recorded' : 'Not yet',
      sub: data.todayRecorded ? 'the kitchen has saved today' : 'no day sheet for today yet',
      accent: data.todayRecorded ? 'var(--good)' : 'var(--warn)',
    }),
  );

  const trendCard = card('Cost per guest against covers', {
    note: 'Last 21 service days · cost per guest left, guests right',
    wide: true,
  },
    lineChart({
      labels: trendDays.map((d) => fmtDayShort(d.day)),
      series: [
        { name: 'Cost per guest', values: trendDays.map((d) => d.costPerGuest), area: true, color: 'var(--c3)' },
        { name: 'Guests', values: trendDays.map((d) => d.guests), color: 'var(--c1)', dashed: true, axis: 'right' },
      ],
      format: (v) => fmtMoney(v),
      rightFormat: (v) => `${fmtNum(v, 0)} guests`,
      height: 230,
    }),
  );

  const guestsCard = card('Guests per day', { note: 'In-house and outside guests' },
    barChart({
      groups: data.weekSeries.map((d) => ({
        label: d.weekday,
        values: [
          { name: 'In-house', value: d.inhouse, color: 'var(--c1)' },
          { name: 'Outside', value: d.outside, color: 'var(--c2)' },
        ],
      })),
      stacked: true,
      format: (v) => `${fmtNum(v, 0)} guests`,
      height: 220,
    }),
  );

  const costCard = card('Daily food cost this week', {},
    barChart({
      groups: data.weekSeries.map((d) => ({
        label: d.weekday,
        values: [
          { name: 'This week', value: d.cost, color: 'var(--c3)' },
          { name: 'Last week', value: d.prevCost, color: 'var(--c4)', faded: true },
        ],
      })),
      format: (v) => fmtMoney(v),
      height: 220,
    }),
  );

  const alerts = card('Needs your attention', { note: `As at ${fmtDay(data.latestDay)}`, wide: true },
    alertList(data.alerts, { empty: 'Usage is tracking normally and stock is above par.' }),
    h('div.btn-row', { style: { marginTop: '.8rem' } },
      h('button.btn-sm', { onclick: () => navigate('daily', { day: data.latestDay }) }, 'Open day detail'),
      h('button.btn-sm', { onclick: () => navigate('stock') }, 'Review stock'),
    ),
  );

  return h('div',
    h('div.page-head',
      h('div',
        h('h1', data.propertyName),
        h('div.sub', `Latest recorded service: ${fmtDay(data.latestDay)}`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Breakfast overview',
          subtitle: `Position as at ${fmtDay(data.latestDay)}`,
          note: 'A snapshot of where the operation stands, with the last three weeks of cost per guest.',
        }),
        h('button.btn-sm', { onclick: () => navigate('compare') }, '⇄ Compare periods'),
        h('button.btn-sm', { onclick: () => navigate('entry') }, 'Open entry sheet'),
        h('button.btn-sm.btn-primary', { onclick: () => navigate('monthly') }, 'Monthly report'),
      ),
    ),
    tiles,
    secondary,
    alerts,
    trendCard,
    h('div.grid.grid-2', guestsCard, costCard),
  );
}
