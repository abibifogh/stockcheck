import { api } from '../api.js';
import { navigate, replaceParams } from '../app.js';
import { fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, todayISO } from '../util.js';
import { lineChart } from '../charts.js';
import { card, emptyState, statTile, table } from './components.js';
import { printButton } from '../print.js';
import { severityPill } from './hk-reports.js';
import { rosterTag } from './hk-roster.js';

/**
 * One dorm room, over time.
 *
 * Reached by clicking a room anywhere else in the system, because "what is
 * going on in Dorm C" is the question a manager asks by name, and answering it
 * by filtering a property-wide table is the kind of work nobody does twice.
 */
export async function renderHkRoom(params = {}) {
  const roomId = Number(params.id);
  if (!roomId) return emptyState('No room chosen', 'Open a room from the report or the overview.');

  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -29);

  const host = h('div');
  const data = await api.hkRoom(roomId, from, to);
  const t = data.totals;
  const pct = (v) => (v == null ? '—' : `${fmtNum(v, 1)}%`);

  const reload = (next) => {
    replaceParams('hk-room', { id: roomId, ...next });
    renderHkRoom({ id: roomId, ...next }).then((view) => mount(host, view));
  };

  const preset = (label, days) => h('button.btn-sm', {
    onclick: () => reload({ from: shiftDay(todayISO(), -(days - 1)), to: todayISO() }),
  }, label);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', data.room.name),
        h('div.sub',
          `${data.bedCount} ${data.bedCount === 1 ? 'bed' : 'beds'}`
          + `${data.room.block ? ` · ${data.room.block}` : ''}`
          + ` · ${fmtDay(from)} to ${fmtDay(to)}`),
      ),
      h('div.btn-row',
        printButton({
          title: `${data.room.name} — bed check`,
          subtitle: `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })}`,
        }),
        preset('Last 30 days', 30),
        preset('Last 90 days', 90),
        h('button.btn-sm', { onclick: () => navigate('hk-report', { from, to }) }, '← All rooms'),
      ),
    ),

    data.room.note ? h('div.alert.info', h('span.alert-icon', 'ℹ️'), h('div', h('div.alert-detail', data.room.note))) : null,

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'No name tag',
        value: fmtNum(t.untagged, 0),
        sub: 'occupied beds in this period',
        accent: t.untagged ? 'var(--bad)' : 'var(--good)',
      }),
      statTile({
        label: 'Tag compliance',
        value: pct(t.tagRate),
        sub: `${fmtNum(t.occupied, 0)} occupied of ${fmtNum(t.checked, 0)} checked`,
        accent: 'var(--c2)',
      }),
      statTile({
        label: 'Occupied unexpectedly',
        value: fmtNum(t.unexpected, 0),
        sub: `${fmtNum(t.emptyBooked, 0)} booked but found empty`,
        accent: t.unexpected ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Coverage',
        value: pct(t.coverage),
        sub: data.lastChecked ? `last checked ${fmtDay(data.lastChecked)}` : 'never checked',
        accent: 'var(--c4)',
      }),
    ),

    card('Bed by bed', { wide: true, note: 'How each bed in this room has behaved' },
      table([
        { key: 'label', label: 'Bed' },
        {
          key: 'lastCheck',
          label: 'Last seen as',
          format: (v) => (v
            ? h('span',
              v.state === 'occupied'
                ? (v.nameTag === 1 ? 'occupied, tagged' : 'occupied, no tag')
                : 'free',
              h('span.muted', ` · ${fmtDay(v.day)}`))
            : h('span.muted', 'never checked')),
        },
        { key: 'checked', label: 'Checks', align: 'right' },
        { key: 'occupied', label: 'Occupied', align: 'right' },
        {
          key: 'untagged',
          label: 'No name tag',
          align: 'right',
          format: (v) => (v ? h('strong', { style: { color: 'var(--bad)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
        },
        { key: 'tagRate', label: 'Tag rate', align: 'right', format: (v) => pct(v) },
        {
          key: 'expectedState',
          label: 'Roster now',
          format: (v, r) => h('span', rosterTag(v),
            r.expectedNote ? h('small.muted', ` ${r.expectedNote}`) : null),
        },
      ], data.beds, { empty: 'This room has no beds set up yet.' })),

    card('Day by day', { wide: true, note: 'Findings in this room' },
      lineChart({
        labels: data.series.map((d) => fmtDayShort(d.day)),
        series: [
          { name: 'No name tag', values: data.series.map((d) => d.untagged), color: 'var(--bad)', area: true },
          { name: 'Occupied', values: data.series.map((d) => d.occupied), color: 'var(--c4)', dashed: true },
        ],
        format: (v) => fmtNum(v, 0),
        height: 200,
      })),

    card('Every check', { wide: true, note: 'Newest first' },
      table([
        { key: 'day', label: 'Day', format: (v) => fmtDay(v, { withYear: true }) },
        { key: 'bed', label: 'Bed' },
        {
          key: 'state',
          label: 'Found',
          format: (v, r) => h('span', v === 'occupied'
            ? (r.nameTag === 1 ? 'occupied, tagged' : 'occupied, no tag')
            : 'free'),
        },
        {
          key: 'expected',
          label: 'Roster said',
          format: (v) => (v ? h('span.muted', v) : h('span.muted', 'not tracked')),
        },
        {
          key: 'severity',
          label: 'Finding',
          format: (v) => (v === 'clear' ? h('span.muted', '—') : severityPill(v)),
        },
        { key: 'note', label: 'Note', format: (v) => (v ? h('span', v) : h('span.muted', '—')) },
        { key: 'by', label: 'By', format: (v) => h('span.muted', v || '—') },
      ], data.history, { empty: 'Nothing has been recorded for this room in this period.' })),
  );

  return host;
}
