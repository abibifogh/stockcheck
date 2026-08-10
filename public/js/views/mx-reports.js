import { api } from '../api.js';
import { navigate, replaceParams, routeParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtMoney, fmtNum, fmtQty, h, mount, shiftDay, todayISO,
} from '../util.js';
import { barChart, donutChart, lineChart, rankedBars } from '../charts.js';
import { alertList, card, exportButton, pctCell, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * What the maintenance store is costing, and where.
 *
 * The kitchen reports ask "what did a guest cost". These ask "what did a place
 * cost", which is the only question a hotel owner can act on: you cannot stop
 * bulbs failing, but you can find out that one wing eats four times its share
 * of them and go and look at the wiring.
 */
export async function renderMxOverview() {
  const data = await api.mxOverview();
  const host = h('div');

  const money = (v) => fmtMoney(v, { compact: true });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Maintenance store'),
        h('div.sub', `Where things stand · ${fmtDay(data.today, { withYear: true })}`),
      ),
      h('div.btn-row',
        printButton({ title: 'Maintenance — where things stand', subtitle: fmtDay(data.today, { withYear: true }) }),
        h('button.btn-sm', { onclick: () => navigate('mx-report') }, 'Full report'),
        h('button.btn-primary.btn-sm', { onclick: () => navigate('mx-issue') }, 'Issue parts'),
      ),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'This month',
        value: money(data.headline.monthCost),
        sub: `${fmtNum(data.headline.monthIssues, 0)} issues across ${fmtNum(data.headline.monthAreas, 0)} places`,
        delta: data.headline.monthDelta,
      }),
      statTile({
        label: 'Parts on the shelf',
        value: money(data.headline.stockValue),
        sub: 'book value of the store',
        accent: 'var(--c2)',
      }),
      statTile({
        label: 'Needs restocking',
        value: fmtNum(data.headline.reorderCount, 0),
        sub: data.headline.reorderValue
          ? `about ${money(data.headline.reorderValue)} to bring back to level`
          : 'nothing below its level',
        accent: data.headline.reorderCount ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Not moved in 90 days',
        value: money(data.headline.idleValue),
        sub: 'money sitting still on the shelf',
        accent: 'var(--text-dim)',
      }),
    ),

    card('Needs your attention', { wide: true, note: `As at ${fmtDay(data.today)}` },
      alertList(data.alerts, { empty: 'Nothing is out of line. The store is behaving.' })),

    h('div.grid.grid-2',
      card('Where the money went this month', { note: 'Top places by cost' },
        data.topAreas.length
          ? rankedBars({
            rows: data.topAreas.map((a) => ({ label: a.name, value: a.cost })),
            format: (v) => fmtMoney(v, { withSymbol: false }),
            colorFor: (row) => (data.topAreas.find((a) => a.name === row.label)?.heavy
              ? 'var(--bad)' : 'var(--c1)'),
          })
          : h('p.muted', 'Nothing issued yet this month.'),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'A bar in red is consuming far more than the others. Click through on the full report '
          + 'to see what keeps going in there.'),
      ),
      card('What was used most', { note: 'Top parts by cost this month' },
        data.topItems.length
          ? rankedBars({
            rows: data.topItems.map((i) => ({ label: i.name, value: i.cost })),
            format: (v) => fmtMoney(v, { withSymbol: false }),
          })
          : h('p.muted', 'Nothing issued yet this month.'),
      ),
    ),

    card('The last 30 days', { wide: true, note: 'What left the store each day' },
      lineChart({
        labels: data.series.map((d) => fmtDayShort(d.day)),
        series: [{ name: 'Cost issued', values: data.series.map((d) => d.cost), color: 'var(--c1)', area: true }],
        format: (v) => fmtMoney(v),
        height: 200,
      })),

    card('Just issued', { wide: true, note: 'The most recent releases from the store' },
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
        { key: 'item', label: 'Part' },
        { key: 'qty', label: 'Qty', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'area', label: 'Where' },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'by', label: 'By', format: (v) => h('span.muted', v || '—') },
        { key: 'jobRef', label: 'Job', format: (v) => (v ? h('span.muted', v) : '—') },
      ], data.recent, { empty: 'Nothing issued yet.' })),
  );

  return host;
}

// ---------------------------------------------------------------------------
// The full report
// ---------------------------------------------------------------------------

export async function renderMxReport(params = {}) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -29);

  const host = h('div');
  const data = await api.mxReport(from, to);

  const reload = (next) => {
    replaceParams('mx-report', next);
    renderMxReport(next).then((view) => mount(host, view));
  };

  const fromInput = h('input', { type: 'date', value: from });
  const toInput = h('input', { type: 'date', value: to });

  const preset = (label, days) => h('button.btn-sm', {
    onclick: () => reload({ from: shiftDay(todayISO(), -(days - 1)), to: todayISO() }),
  }, label);

  const picker = card('Which period?', { note: 'Compared against the same length of time immediately before' },
    h('div.btn-row', { style: { marginBottom: '.8rem' } },
      preset('Last 7 days', 7),
      preset('Last 30 days', 30),
      preset('Last 90 days', 90),
      h('button.btn-sm', {
        onclick: () => {
          const month = todayISO().slice(0, 7);
          reload({ from: `${month}-01`, to: todayISO() });
        },
      }, 'This month'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'From'), fromInput),
      h('label.field', h('span', 'To'), toInput),
      h('div.field', h('span', ' '), h('button.btn-primary', {
        onclick: () => {
          if (fromInput.value > toInput.value) return;
          reload({ from: fromInput.value, to: toInput.value });
        },
      }, 'Show')),
    ),
  );

  const areaRows = data.areas.rows;

  // Built up front so the click-through can be wired to these rows only —
  // querying the whole page would make every other table clickable too, and
  // send people to the wrong room.
  const areaTable = table([
    {
      key: 'name',
      label: 'Where',
      format: (v, r) => h('div',
        h('div', v, r.heavy ? h('span.pill.bad', { style: { marginLeft: '.4rem' } }, 'heavy') : null),
        h('small.muted', r.kind === 'room' ? (r.block || 'Room') : (r.block || 'Area')),
      ),
    },
    { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
    { key: 'issues', label: 'Issues', align: 'right' },
    { key: 'visits', label: 'Days', align: 'right' },
    {
      key: 'vsTypicalPct',
      label: 'vs typical place',
      align: 'right',
      format: (v) => (v == null ? '—' : pctCell(v)),
    },
    {
      key: 'topItems',
      label: 'Mostly',
      format: (v) => (v?.length
        ? h('span.muted', v.slice(0, 2).map((t) => t.name).join(', '))
        : '—'),
    },
    { key: 'lastIssue', label: 'Last', format: (v) => (v ? h('span.muted', fmtDay(v)) : '—') },
  ], areaRows, {
    empty: 'Nothing was issued in this period.',
    rowClass: (r) => (r.heavy ? 'row-bad' : ''),
  });

  areaTable.querySelectorAll('tbody tr').forEach((row, index) => {
    const area = areaRows[index];
    if (!area?.areaId) return;
    row.style.cursor = 'pointer';
    row.title = `See everything ever issued to ${area.name}`;
    row.addEventListener('click', () => navigate('mx-area', { id: area.areaId }));
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Maintenance report'),
        h('div.sub', `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })} · ${data.days} days`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Maintenance report',
          subtitle: `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })}`,
          note: `Compared against ${fmtDay(data.previous.from)} to ${fmtDay(data.previous.to)}.`,
        }),
        h('button.btn-sm', { onclick: () => navigate('mx-compare', { aFrom: from, aTo: to }) }, '⇄ Compare with…'),
      ),
    ),

    picker,

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Parts issued',
        value: fmtMoney(data.current.cost, { compact: true }),
        sub: `was ${fmtMoney(data.previous.cost, { compact: true })}`,
        delta: data.deltas.cost,
      }),
      statTile({
        label: 'Separate issues',
        value: fmtNum(data.current.issues, 0),
        sub: `${fmtNum(data.current.activeDays, 0)} days with work`,
        delta: data.deltas.issues,
      }),
      statTile({
        label: 'Places touched',
        value: fmtNum(data.current.areasTouched, 0),
        sub: 'rooms and areas that took parts',
        delta: data.deltas.areasTouched,
      }),
      statTile({
        label: 'Average per place',
        value: fmtMoney(data.current.costPerArea),
        sub: 'across the places that took parts',
        delta: data.deltas.costPerArea,
        accent: 'var(--c3)',
      }),
    ),

    data.alerts.length
      ? card('What needs a decision', { wide: true }, alertList(data.alerts))
      : null,

    card('Day by day', { wide: true, note: 'What left the store' },
      lineChart({
        labels: data.series.map((d) => fmtDayShort(d.day)),
        series: [{ name: 'Cost issued', values: data.series.map((d) => d.cost), color: 'var(--c1)', area: true }],
        format: (v) => fmtMoney(v),
        height: 220,
      })),

    card('Every room and area', {
      wide: true,
      note: 'Click a row to see everything that has ever gone into that place',
    },
      areaTable,
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        `A typical place cost ${fmtMoney(data.areas.typicalCost)} in this period. `
        + '“vs typical place” compares each one against that, so a big number means that room is '
        + 'taking far more than its share.'),
    ),

    h('div.grid.grid-2',
      card('By category', { note: 'Share of the money' },
        data.items.categories.length
          ? donutChart({
            slices: data.items.categories.map((c, i) => ({
              label: c.name, value: c.cost, color: `var(--c${(i % 8) + 1})`,
            })),
            format: (v) => fmtMoney(v, { withSymbol: false }),
            centerLabel: 'Total',
            centerValue: fmtMoney(data.items.total, { compact: true }),
          })
          : h('p.muted', 'Nothing issued in this period.'),
      ),
      card('Store movement', { note: 'Bought against issued' },
        h('div.grid.grid-2',
          statTile({ label: 'Bought', value: fmtMoney(data.inventory.purchaseValue, { compact: true }), sub: `${data.inventory.purchaseCount} deliveries` }),
          statTile({ label: 'Issued', value: fmtMoney(data.inventory.issuedValue, { compact: true }), sub: 'left the shelf' }),
        ),
        h('p.muted', { style: { fontSize: '.85rem', marginTop: '.8rem', marginBottom: 0 } },
          data.inventory.movement > 0
            ? `The store grew by ${fmtMoney(data.inventory.movement)} — you bought more than you used. `
              + 'Fine occasionally; month after month it is cash sitting on a shelf.'
            : `The store shrank by ${fmtMoney(Math.abs(data.inventory.movement))} — you used more than `
              + 'you bought, running down what was already there.'),
      ),
    ),

    card('What changed against the period before', { wide: true },
      h('div.grid.grid-2',
        h('div',
          h('div.stat-label', { style: { marginBottom: '.6rem' } }, 'Used more'),
          data.risers.length
            ? rankedBars({
              rows: data.risers.map((m) => ({ label: m.name, value: m.deltaCost })),
              format: (v) => `+${fmtMoney(v, { withSymbol: false })}`,
              colorFor: () => 'var(--bad)',
            })
            : h('p.muted', 'Nothing rose.'),
        ),
        h('div',
          h('div.stat-label', { style: { marginBottom: '.6rem' } }, 'Used less'),
          data.fallers.length
            ? rankedBars({
              rows: data.fallers.map((m) => ({ label: m.name, value: Math.abs(m.deltaCost) })),
              format: (v) => `−${fmtMoney(v, { withSymbol: false })}`,
              colorFor: () => 'var(--good)',
            })
            : h('p.muted', 'Nothing fell.'),
        ),
      )),

    card('Every part used', { wide: true },
      table([
        { key: 'name', label: 'Part', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
        { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'areas', label: 'Places', align: 'right' },
        {
          key: 'perArea',
          label: 'Per place',
          align: 'right',
          format: (v, r) => (v == null ? '—' : fmtQty(v, r.unit)),
        },
      ], data.items.rows, { empty: 'Nothing issued in this period.' })),
  );

  return host;
}
