import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, fmtQty, h, mount } from '../util.js';
import { card, emptyState, statTile, table } from './components.js';
import { barChart } from '../charts.js';
import { printButton } from '../print.js';

/**
 * One room's whole history.
 *
 * The report names the rooms that cost the most; this answers the obvious next
 * question, which is "why". A room that has taken four taps in six months is
 * not a room with bad luck — it is a room with a pipe problem nobody has looked
 * at, and the item list here makes that visible in one glance.
 */
export async function renderMxArea(params = {}) {
  const host = h('div');

  if (!params.id) {
    mount(host, emptyState('No room chosen', 'Open a room from the maintenance report.'));
    return host;
  }

  const data = await api.mxAreaDetail(params.id);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.area.name),
        h('div.sub', [
          data.area.kind === 'room' ? 'Room' : 'Area',
          data.area.block,
          data.firstIssue ? `first issue ${fmtDay(data.firstIssue, { withYear: true })}` : null,
        ].filter(Boolean).join(' · ')),
      ),
      h('div.btn-row',
        printButton({ title: `Maintenance — ${data.area.name}`, subtitle: 'Everything ever issued here' }),
        h('button.btn-sm', { onclick: () => navigate('mx-store') }, '← Back to the store'),
      ),
    ),

    h('div.grid.grid-3', { style: { marginBottom: '1rem' } },
      statTile({ label: 'Spent here in total', value: fmtMoney(data.totalCost, { compact: true }), sub: 'at what the parts cost' }),
      statTile({ label: 'Separate visits', value: fmtNum(data.visits, 0), sub: 'days on which something was issued' }),
      statTile({
        label: 'Last worked on',
        value: data.lastIssue ? fmtDay(data.lastIssue) : '—',
        sub: data.lastIssue ? fmtDay(data.lastIssue, { withYear: true }) : 'never',
      }),
    ),

    data.months.length > 1
      ? card('Month by month', { wide: true, note: 'What this place has cost over time' },
        barChart({
          groups: data.months.map((m) => ({
            label: m.month.slice(5),
            values: [{ name: 'Cost', value: m.cost, color: 'var(--c1)' }],
          })),
          format: (v) => fmtMoney(v),
          height: 200,
        }))
      : null,

    card('What has gone in here', {
      wide: true,
      note: 'Ranked by money, with how many separate occasions',
    },
      table([
        { key: 'name', label: 'Part' },
        { key: 'qty', label: 'Total quantity', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'occasions', label: 'Occasions', align: 'right' },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
      ], data.items, { empty: 'Nothing has been issued here yet.' }),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'A part with several occasions is the one to look at. Replacing the same thing repeatedly '
        + 'in the same place usually means the cause has not been dealt with.'),
    ),

    card('Every issue, newest first', { wide: true },
      table([
        { key: 'day', label: 'Date', format: (v) => fmtDay(v, { withYear: true }) },
        { key: 'item', label: 'Part' },
        { key: 'qty', label: 'Qty', align: 'right', format: (v, r) => fmtQty(v, r.unit) },
        { key: 'cost', label: 'Cost', align: 'right', format: (v) => fmtMoney(v, { withSymbol: false }) },
        { key: 'by', label: 'Issued by', format: (v) => h('span.muted', v || '—') },
        { key: 'jobRef', label: 'Job', format: (v) => (v ? h('span.muted', v) : '—') },
        { key: 'note', label: 'Note', format: (v) => (v ? h('span.muted', v) : '—') },
      ], data.issues, { empty: 'Nothing has been issued here yet.' })),
  );

  return host;
}
