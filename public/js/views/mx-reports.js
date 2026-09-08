import { api } from '../api.js';
import { navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtMoney, fmtNum, fmtQty, h, mount, shiftDay, todayISO,
} from '../util.js';
import { donutChart, lineChart, rankedBars } from '../charts.js';
import { alertList, card, pctCell, statTile, stepCard, table } from './components.js';
import { printButton } from '../print.js';

/**
 * What the maintenance store is costing, and where.
 *
 * The kitchen reports ask "what did a guest cost". These ask "what did a place
 * cost", which is the only question a hotel owner can act on: you cannot stop
 * bulbs failing, but you can find out that one wing eats four times its share
 * of them and go and look at the wiring.
 */
/**
 * The store: where it stands now, and what happened over a period.
 *
 * These were two screens, and the second was very nearly the first with more
 * rows. Both opened with four tiles, an alert list and a line chart of what
 * left the store; the overview then showed the top areas and top parts as
 * bars, which the report showed again underneath as full tables. Somebody
 * wanting the detail read the same findings twice, in two shapes, and had to
 * know that "Full report" was where the tables lived.
 *
 * So one screen, with the period at the top. What is true right now — what the
 * shelf is worth, what needs ordering, what has not moved — does not belong to
 * a period and sits above the picker. Everything below it moves with the dates.
 */
export async function renderMxStore(params = {}) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -29);

  const host = h('div');
  const [now, data, counts, adjustments] = await Promise.all([
    api.mxOverview(),
    api.mxReport(from, to),
    // Both may be refused for somebody who can read the reports but decides
    // nothing, which is fine — they simply see no approvals banner.
    api.mxPendingCounts().catch(() => ({ counts: [] })),
    api.mxPendingAdjustments().catch(() => ({ adjustments: [] })),
  ]);

  const reload = (next) => {
    replaceParams('mx-store', next);
    renderMxStore(next).then((view) => mount(host, view));
  };

  const money = (v) => fmtMoney(v, { compact: true });
  const fromInput = h('input', { type: 'date', value: from });
  const toInput = h('input', { type: 'date', value: to });

  const preset = (label, days) => h('button.btn-sm', {
    onclick: () => reload({ from: shiftDay(todayISO(), -(days - 1)), to: todayISO() }),
  }, label);

  const picker = card('Which period?', {
    wide: true,
    note: 'Compared against the same length of time immediately before',
  },
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

  // Both endpoints raise findings and some are the same finding. Shown twice
  // under two headings, an alert reads as two problems.
  const seen = new Set();
  const alerts = [...(now.alerts ?? []), ...(data.alerts ?? [])].filter((a) => {
    const key = `${a.level}|${a.title}|${a.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const areaRows = data.areas.rows;

  // Built up front so the click-through can be wired to these rows only —
  // querying the whole page would make every other table clickable too, and
  // send people to the wrong room.
  const areaTable = table([
    {
      key: 'name',
      label: 'Where',
      cls: 'wrap',
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
      cls: 'wrap',
      format: (v) => (v?.length
        ? h('span.muted', v.slice(0, 2).map((t) => t.name).join(', '))
        : '—'),
    },
    { key: 'lastIssue', label: 'Last', format: (v) => (v ? h('span.muted', fmtDay(v)) : '—') },
  ], areaRows, {
    empty: 'Nothing was issued in this period.',
    rowClass: (r) => (r.heavy ? 'row-bad' : ''),
    sortable: true,
    // Wired as the row is built rather than by walking the table afterwards.
    // The old way matched rows to data by position, which a sort quietly
    // invalidates — clicking "Room 214" would have opened whichever room
    // happened to be in that position before.
    onRowClick: (row, el) => {
      if (!row.areaId) return false;
      el.addEventListener('click', () => navigate('mx-area', { id: row.areaId }));
      return `See everything ever issued to ${row.name}`;
    },
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Maintenance store'),
        h('div.sub', `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })} · ${data.days} days`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Maintenance store',
          subtitle: `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })}`,
          note: `Compared against ${fmtDay(data.previous.from)} to ${fmtDay(data.previous.to)}.`,
        }),
        h('button.btn-sm', { onclick: () => navigate('mx-compare', { aFrom: from, aTo: to }) }, '⇄ Compare with…'),
        h('button.btn-primary.btn-sm', { onclick: () => navigate('mx-issue') }, 'Issue parts'),
      ),
    ),

    // Above the picker on purpose: none of it belongs to a period. What the
    // shelf is worth is what it is worth today, whatever dates are chosen.
    h('div.stat-label', { style: { marginBottom: '.4rem' } }, `Right now · ${fmtDay(now.today)}`),
    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Parts on the shelf',
        value: money(now.headline.stockValue),
        sub: 'book value of the store',
        accent: 'var(--c2)',
      }),
      statTile({
        label: 'Needs restocking',
        value: fmtNum(now.headline.reorderCount, 0),
        sub: now.headline.reorderValue
          ? `about ${money(now.headline.reorderValue)} to bring back to level`
          : 'nothing below its level',
        accent: now.headline.reorderCount ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Not moved in 90 days',
        value: money(now.headline.idleValue),
        sub: 'money sitting still on the shelf',
        accent: 'var(--text-dim)',
      }),
    ),

    // Above the findings, because it is the only thing on this screen that is
    // waiting on the reader personally. An analysis can be read tomorrow; a
    // request sitting unanswered is somebody blocked.
    waitingBanner(counts, adjustments),

    card('Needs your attention', { wide: true },
      alertList(alerts, { empty: 'Nothing is out of line. The store is behaving.' })),

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

    card('Day by day', { wide: true, note: 'What left the store' },
      lineChart({
        labels: data.series.map((d) => fmtDayShort(d.day)),
        series: [{ name: 'Cost issued', values: data.series.map((d) => d.cost), color: 'var(--c1)', area: true }],
        format: (v) => fmtMoney(v),
        height: 220,
      })),

    // The full table, rather than the top-five bars this screen used to show
    // above it. The bars were the first five rows of this, drawn differently.
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
        { key: 'name', label: 'Part', cls: 'wrap', format: (v, r) => h('div', h('div', v), h('small.muted', r.categoryName)) },
        { key: 'qty', label: 'Quantity', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'areas', label: 'Places', align: 'right' },
        {
          key: 'perArea',
          label: 'Per place',
          align: 'right',
          format: (v, r) => (v == null ? '—' : fmtQty(v, r.unit)),
        },
      ], data.items.rows, { sortable: true, empty: 'Nothing issued in this period.' })),

    // Folded: it is what you look at to check a specific entry went in, not
    // something you read down the page every time.
    stepCard('Just issued', {
      open: false,
      note: 'The most recent releases from the store',
      summary: `${(now.recent ?? []).length} entries`,
    },
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
        { key: 'item', label: 'Part', cls: 'wrap' },
        { key: 'qty', label: 'Qty', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'area', label: 'Where', cls: 'wrap' },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'by', label: 'By', format: (v) => h('span.muted', v || '—') },
        { key: 'jobRef', label: 'Job', format: (v) => (v ? h('span.muted', v) : '—') },
      ], now.recent ?? [], { sortable: true, empty: 'Nothing issued yet.' })).el,
  );

  return host;
}


/**
 * What is waiting on whoever is reading this.
 *
 * The bell carries it too, but a bell is read once and dismissed. A request to
 * remove an issue moves no stock until somebody decides, so it can sit for a
 * week without anything looking wrong anywhere — which is precisely how it
 * gets forgotten. This says so on the screen people open every day, and links
 * to the one that can act on it.
 */
function waitingBanner(counts, adjustments) {
  const nCounts = (counts?.counts ?? []).length;
  const nChanges = (adjustments?.adjustments ?? []).length;
  if (!nCounts && !nChanges) return null;

  const parts = [];
  if (nCounts) parts.push(`${nCounts} counted ${nCounts === 1 ? 'part' : 'parts'}`);
  if (nChanges) parts.push(`${nChanges} ${nChanges === 1 ? 'change' : 'changes'} to what was recorded`);

  return h('div.alert.warn', { style: { marginBottom: '1rem' } },
    h('span.alert-icon', '\u23f3'),
    h('div',
      h('div.alert-title', `${parts.join(' and ')} waiting for your decision`),
      h('div.alert-detail',
        'Nothing has moved on the shelf until you accept it. ',
        h('a', { href: '#/mx-stock' }, 'Review them now')),
    ),
  );
}
