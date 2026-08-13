import { api } from '../api.js';
import { navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtDayShort, fmtNum, h, mount, shiftDay, todayISO,
} from '../util.js';
import { lineChart, rankedBars } from '../charts.js';
import { alertList, card, exportButton, statTile, table } from './components.js';
import { printButton } from '../print.js';

/**
 * What the bed check found.
 *
 * Every panel here is arranged around one number — occupied beds with no name
 * tag — because that is the thing the property is actually trying to drive to
 * zero. Occupancy, coverage and the rest are here to stop that number being
 * read wrongly: forty untagged beds out of four hundred checks is a different
 * morning from forty out of fifty, and a spotless week in which nobody walked
 * the second floor is not a spotless week.
 */

const SEVERITY = {
  untagged: { label: 'No name tag', cls: 'sev-untagged' },
  unexpected: { label: 'Occupied, rostered free', cls: 'sev-unexpected' },
  empty_booked: { label: 'Empty, rostered occupied', cls: 'sev-empty' },
  unchecked: { label: 'Not checked', cls: 'sev-unchecked' },
  clear: { label: 'All as it should be', cls: 'sev-clear' },
};

export function severityPill(severity) {
  const s = SEVERITY[severity] ?? SEVERITY.clear;
  const kind = severity === 'untagged' ? 'bad'
    : severity === 'unexpected' ? 'warn'
      : severity === 'empty_booked' ? 'info'
        : severity === 'unchecked' ? '' : 'good';
  return h(`span.pill${kind ? `.${kind}` : ''}`, s.label);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function renderHkOverview() {
  const data = await api.hkOverview();
  const host = h('div');
  const head = data.headline;

  const pct = (v) => (v == null ? '—' : `${fmtNum(v, 1)}%`);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Housekeeping'),
        h('div.sub', `Where the dorms stand · ${fmtDay(data.today, { withYear: true })}`
          + ` · ${data.roundsSubmittedToday ?? 0}/${data.roundsPerDay ?? 3} checks in`),
      ),
      h('div.btn-row',
        printButton({ title: 'Dorm bed check — where things stand', subtitle: fmtDay(data.today, { withYear: true }) }),
        h('button.btn-sm', { onclick: () => navigate('hk-report') }, 'Full report'),
        h('button.btn-primary.btn-sm', { onclick: () => navigate('hk-check') }, 'Do the check'),
      ),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'No name tag',
        value: fmtNum(head.untagged30, 0),
        sub: 'found in the last 30 days',
        delta: head.monthDelta,
        accent: head.untagged30 ? 'var(--bad)' : 'var(--good)',
      }),
      statTile({
        label: 'Tag compliance',
        value: pct(head.tagRate30),
        sub: 'of occupied beds carried a tag',
        accent: 'var(--c2)',
      }),
      statTile({
        label: 'Occupied unexpectedly',
        value: fmtNum(head.unexpected30, 0),
        sub: 'the roster said the bed was free',
        accent: head.unexpected30 ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Beds covered',
        value: pct(head.coverage30),
        sub: `${head.roundsThisMonth} rounds submitted this month`,
        accent: 'var(--c4)',
      }),
    ),

    todayCard(data),

    card('Needs your attention', { wide: true, note: 'From the last 30 days' },
      alertList(data.alerts, { empty: 'Every occupied bed checked was labelled, and nothing was found where it should not be.' })),

    h('div.grid.grid-2',
      card('The last 30 days', { note: 'Findings per day' },
        lineChart({
          labels: data.series.map((d) => fmtDayShort(d.day)),
          series: [
            { name: 'No name tag', values: data.series.map((d) => d.untagged), color: 'var(--bad)', area: true },
            { name: 'Unexpected', values: data.series.map((d) => d.unexpected), color: 'var(--warn)' },
          ],
          format: (v) => fmtNum(v, 0),
          height: 200,
        })),
      card('Beds that keep coming up', { note: 'Found untagged more than once in 30 days' },
        data.repeats.length
          ? rankedBars({
            rows: data.repeats.map((b) => ({ label: `${b.room} · ${b.label}`, value: b.untagged })),
            format: (v) => `${fmtNum(v, 0)}×`,
            colorFor: () => 'var(--bad)',
          })
          : h('p.muted', 'No bed has been found untagged more than once. That is the number you want.'),
      ),
    ),

    card('Recent rounds', { wide: true, note: 'Click a day to read the whole check' },
      roundsTable(data.recentRounds)),
  );

  return host;
}

/** The day's three checks, and who has and has not done theirs. */
function roundsStrip(rounds) {
  return h('div.hk-rounds-strip', (rounds ?? []).map((r) => h('div.hk-round-card', {
    class: `hk-round-card ${r.submitted ? 'done' : r.started ? 'pending' : ''}`,
  },
    h('h4', r.label),
    h('div.who', r.by),
    h('div.figures',
      r.submitted
        ? h('span', `✓ submitted by ${r.submittedBy ?? 'someone'}`)
        : r.started
          ? h('span', `${r.checked} of ${r.expected ?? '—'} beds, not submitted yet`)
          : h('span.muted', 'not started'),
    ),
    r.untagged
      ? h('div.figures', h('strong', { style: { color: 'var(--bad)' } }, `${r.untagged} without a name tag`))
      : null,
  )));
}

/**
 * Today: the three checks, then the rooms, then what is still outstanding.
 *
 * A manager arriving at nine wants one answer — is there anything I have to
 * deal with before the guests come down — and with three rounds in a day the
 * honest answer is what the last one to look at each bed left behind, not the
 * sum of everything anybody ever found.
 */
function todayCard(data) {
  const t = data.todayTotals;

  const chips = data.rooms.map((room) => h('button.hk-chip', {
    class: `hk-chip ${SEVERITY[room.severity]?.cls ?? 'sev-clear'}`,
    title: `${room.name}: ${room.checked} of ${room.beds} beds checked`
      + `${room.untagged ? `, ${room.untagged} without a name tag` : ''}`
      + `${room.unexpected ? `, ${room.unexpected} unexpected` : ''}`,
    onclick: () => navigate('hk-room', { id: room.roomId }),
  }, room.name, h('small', `${room.checked}/${room.beds}`)));

  const res = data.todayResolution;

  return card(
    data.todaySubmitted ? "Today's three checks" : 'Today so far',
    {
      wide: true,
      note: data.lastCheckedDay && data.daysSinceCheck > 0
        ? `Nothing recorded today — the last check was ${fmtDay(data.lastCheckedDay)}`
        : `${data.roundsSubmittedToday ?? 0} of ${data.roundsPerDay ?? 3} checks submitted`,
    },
    roundsStrip(data.todayRounds),
    res?.fixed
      ? h('p.muted', { style: { fontSize: '.85rem', margin: '.8rem 0 0' } },
        `${res.fixed} ${res.fixed === 1 ? 'finding was' : 'findings were'} put right between checks today`
        + `${res.unresolved ? `, and ${res.unresolved} ${res.unresolved === 1 ? 'is' : 'are'} still outstanding.` : '.'}`)
      : null,
    h('div', { style: { marginTop: '.9rem' } },
      h('div.hk-chips', chips.length ? chips : h('p.muted', 'No dorm rooms have been set up yet.'))),
    data.todayFindings.length
      ? h('div.hk-findings', data.todayFindings.map((f) => h('div.hk-finding',
        severityPill(f.severity),
        h('strong', `${f.room} · ${f.bed}`),
        f.slotLabel ? h('span.muted', `as at the ${f.slotLabel.toLowerCase()} check`) : null,
        f.note ? h('span.muted', `“${f.note}”`) : null,
        f.checkedBy ? h('span.muted', `· ${f.checkedBy}`) : null,
      )))
      : h('p.muted', { style: { marginBottom: 0 } },
        t.checked
          ? 'Nothing is outstanding — every finding today was dealt with.'
          : 'No check has been recorded yet today.'),
  );
}

function roundsTable(rounds) {
  const view = table([
    { key: 'day', label: 'Day', format: (v) => fmtDay(v, { withYear: true }) },
    {
      key: 'checked',
      label: 'Checked',
      align: 'right',
      format: (v, r) => h('span', `${fmtNum(v, 0)}`, h('span.muted', ` / ${fmtNum(r.expected, 0)}`)),
    },
    {
      key: 'untagged',
      label: 'No name tag',
      align: 'right',
      format: (v) => (v ? h('strong', { style: { color: 'var(--bad)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
    },
    {
      key: 'unexpected',
      label: 'Unexpected',
      align: 'right',
      format: (v) => (v ? h('strong', { style: { color: 'var(--warn)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
    },
    { key: 'submittedBy', label: 'Submitted by', format: (v) => (v ? h('span.muted', v) : h('span.pill.warn', 'not submitted')) },
  ], rounds, { empty: 'No rounds recorded yet.' });

  view.querySelectorAll('tbody tr').forEach((row, index) => {
    const round = rounds[index];
    if (!round) return;
    row.style.cursor = 'pointer';
    row.title = `Read the whole check for ${round.day}`;
    row.addEventListener('click', () => navigate('hk-report', { from: round.day, to: round.day }));
  });

  return view;
}

// ---------------------------------------------------------------------------
// The full report
// ---------------------------------------------------------------------------

export async function renderHkReport(params = {}) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -29);

  const host = h('div');
  const data = await api.hkReport(from, to);

  const reload = (next) => {
    replaceParams('hk-report', next);
    renderHkReport(next).then((view) => mount(host, view));
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

  const t = data.current;
  const pct = (v) => (v == null ? '—' : `${fmtNum(v, 1)}%`);
  const points = (v) => (v == null ? null : `${v > 0 ? '+' : ''}${fmtNum(v, 1)} points`);

  const roomRows = data.rooms;
  const roomTable = table([
    {
      key: 'name',
      label: 'Room',
      format: (v, r) => h('div',
        h('div', v, r.neverChecked ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'never checked') : null),
        h('small.muted', `${r.bedCount} ${r.bedCount === 1 ? 'bed' : 'beds'}${r.block ? ` · ${r.block}` : ''}`),
      ),
    },
    {
      key: 'untagged',
      label: 'No name tag',
      align: 'right',
      format: (v) => (v ? h('strong', { style: { color: 'var(--bad)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
    },
    {
      key: 'unexpected',
      label: 'Unexpected',
      align: 'right',
      format: (v) => (v ? h('strong', { style: { color: 'var(--warn)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
    },
    { key: 'emptyBooked', label: 'Empty but booked', align: 'right', format: (v) => (v ? fmtNum(v, 0) : h('span.muted', '0')) },
    { key: 'occupancy', label: 'Occupancy', align: 'right', format: (v) => pct(v) },
    { key: 'tagRate', label: 'Tag rate', align: 'right', format: (v) => pct(v) },
    { key: 'coverage', label: 'Coverage', align: 'right', format: (v) => pct(v) },
    { key: 'lastChecked', label: 'Last checked', format: (v) => (v ? h('span.muted', fmtDay(v)) : h('span.muted', '—')) },
  ], roomRows, {
    empty: 'No rooms have been set up yet.',
    rowClass: (r) => (r.untagged ? 'row-bad' : ''),
  });

  roomTable.querySelectorAll('tbody tr').forEach((row, index) => {
    const room = roomRows[index];
    if (!room?.roomId) return;
    row.style.cursor = 'pointer';
    row.title = `See every check ever made in ${room.name}`;
    row.addEventListener('click', () => navigate('hk-room', { id: room.roomId, from, to }));
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Bed check report'),
        h('div.sub', `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })} · ${data.days} days`),
      ),
      h('div.btn-row',
        printButton({
          title: 'Dorm bed check report',
          subtitle: `${fmtDay(from, { withYear: true })} to ${fmtDay(to, { withYear: true })}`,
          note: `Compared against ${fmtDay(data.previous.from)} to ${fmtDay(data.previous.to)}.`,
        }),
        exportButton(api.hkExportUrl(from, to), 'Export CSV'),
      ),
    ),

    picker,

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Occupied, no name tag',
        value: fmtNum(t.untagged, 0),
        sub: `was ${fmtNum(data.previous.untagged, 0)} the period before`,
        delta: data.deltas.untagged,
        accent: t.untagged ? 'var(--bad)' : 'var(--good)',
      }),
      statTile({
        label: 'Tag compliance',
        value: pct(t.tagRate),
        sub: points(data.deltas.tagRate) ?? 'nothing to compare against',
        accent: 'var(--c2)',
      }),
      statTile({
        label: 'Occupied unexpectedly',
        value: fmtNum(t.unexpected, 0),
        sub: `${fmtNum(t.emptyBooked, 0)} booked beds found empty`,
        delta: data.deltas.unexpected,
        accent: t.unexpected ? 'var(--warn)' : undefined,
      }),
      statTile({
        label: 'Beds checked',
        value: fmtNum(t.checked, 0),
        sub: `${pct(t.coverage)} of ${fmtNum(data.bedCount, 0)} beds × ${data.days} days`,
        accent: 'var(--c4)',
      }),
    ),

    data.alerts.length
      ? card('What needs a decision', { wide: true }, alertList(data.alerts))
      : null,

    card('The three checks', {
      wide: true,
      note: `${data.roundsSubmitted} of ${data.roundsExpected} submitted in this period`,
    },
      table([
        { key: 'label', label: 'Check', format: (v, r) => h('div', h('div', v), h('small.muted', r.by)) },
        {
          key: 'submitted',
          label: 'Done',
          align: 'right',
          format: (v, r) => h('span', `${v}`, h('span.muted', ` / ${data.days}`),
            v < data.days ? h('span.pill.warn', { style: { marginLeft: '.4rem' } }, `${data.days - v} missed`) : null),
        },
        { key: 'checked', label: 'Beds checked', align: 'right', format: (v) => fmtNum(v, 0) },
        {
          key: 'untagged',
          label: 'No name tag',
          align: 'right',
          format: (v) => (v ? h('strong', { style: { color: 'var(--bad)' } }, fmtNum(v, 0)) : h('span.muted', '0')),
        },
        { key: 'unexpected', label: 'Unexpected', align: 'right', format: (v) => (v ? fmtNum(v, 0) : h('span.muted', '0')) },
        { key: 'tagRate', label: 'Tag rate', align: 'right', format: (v) => pct(v) },
        {
          key: 'people',
          label: 'Walked by',
          format: (v) => (v?.length ? h('span.muted', v.map((p) => p.name).join(', ')) : h('span.muted', '—')),
        },
      ], data.bySlot, { empty: 'No checks recorded in this period.' }),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'Each check is its own report, submitted and emailed on its own. A round that keeps '
        + 'being missed leaves the hours it covers unwatched, whatever the other two found.'),
    ),

    card('Found and fixed', {
      wide: true,
      note: 'Whether a finding survived to the end of its day',
    },
      h('div.grid.grid-4',
        statTile({
          label: 'Findings',
          value: fmtNum(data.resolution.found, 0),
          sub: 'beds found wrong at least once',
        }),
        statTile({
          label: 'Put right same day',
          value: fmtNum(data.resolution.fixed, 0),
          sub: 'a later check found them fixed',
          accent: 'var(--good)',
        }),
        statTile({
          label: 'Still wrong at close',
          value: fmtNum(data.resolution.unresolved, 0),
          sub: `${fmtNum(data.resolution.neverRechecked, 0)} found by the day's last check`,
          accent: data.resolution.unresolved ? 'var(--bad)' : undefined,
        }),
        statTile({
          label: 'Fixed within the day',
          value: pct(data.resolution.fixRate),
          sub: 'of everything found',
          accent: 'var(--c2)',
        }),
      ),
      data.resolution.lingering.length
        ? h('div', { style: { marginTop: '1rem' } },
          h('div.stat-label', { style: { marginBottom: '.5rem' } }, 'Left unresolved'),
          table([
            { key: 'day', label: 'Day', format: (v) => fmtDay(v) },
            { key: 'room', label: 'Room' },
            { key: 'bed', label: 'Bed' },
            { key: 'firstSeen', label: 'First found', format: (v) => h('span.muted', v) },
            { key: 'lastSeen', label: 'Last seen', format: (v) => h('span.muted', v) },
            {
              key: 'rechecked',
              label: '',
              format: (v) => (v ? h('span.pill.bad', 'nobody acted') : h('span.pill', 'no later check')),
            },
          ], data.resolution.lingering, { empty: '' }))
        : h('p.muted', { style: { marginTop: '.8rem', marginBottom: 0 } },
          'Everything found in this period was put right before the day was out.'),
    ),

    card('Every room, every day', {
      wide: true,
      note: 'One square per room per day, coloured by the worst thing found',
    },
      heatmapGrid(data.heatmap, { from, to }),
      heatmapKey(),
      h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
        'Grey means nobody answered for that room that day. A row of grey squares is not a '
        + 'clean room — it is a room nobody opened, and it is worth as much of your attention '
        + 'as a red one.'),
    ),

    card('Day by day', { wide: true, note: 'Findings against beds checked' },
      lineChart({
        labels: data.series.map((d) => fmtDayShort(d.day)),
        series: [
          { name: 'No name tag', values: data.series.map((d) => d.untagged), color: 'var(--bad)', area: true },
          { name: 'Occupied unexpectedly', values: data.series.map((d) => d.unexpected), color: 'var(--warn)' },
          { name: 'Beds checked', values: data.series.map((d) => d.checked), color: 'var(--c4)', axis: 'right', dashed: true },
        ],
        format: (v) => fmtNum(v, 0),
        rightFormat: (v) => fmtNum(v, 0),
        height: 230,
      })),

    card('Room by room', { wide: true, note: 'Click a row for everything ever found in that room' },
      roomTable),

    h('div.grid.grid-2',
      card('Beds found untagged more than once', { note: 'The same bed, repeatedly' },
        data.repeats.length
          ? table([
            { key: 'room', label: 'Room', format: (v, r) => h('div', h('div', v), h('small.muted', r.label)) },
            { key: 'untagged', label: 'Times', align: 'right' },
            { key: 'checks', label: 'Of checks', align: 'right' },
            { key: 'lastUntagged', label: 'Last', format: (v) => (v ? fmtDay(v) : '—') },
          ], data.repeats, { empty: '' })
          : h('p.muted', 'No bed was found untagged more than once in this period.'),
      ),
      card('Who walked the rounds', { note: 'And what they found' },
        table([
          { key: 'name', label: 'Person' },
          { key: 'checks', label: 'Beds', align: 'right' },
          { key: 'days', label: 'Days', align: 'right' },
          { key: 'untaggedFound', label: 'Untagged found', align: 'right' },
        ], data.people, { empty: 'Nobody has recorded a check in this period.' }),
      ),
    ),

    data.notes.length
      ? card('What housekeeping wrote down', {
        wide: true,
        note: 'The observations left against individual beds',
      },
        h('div.hk-notes', data.notes.slice(0, 60).map((n) => h('div.hk-note-row',
          h('span.muted', fmtDay(n.day)),
          h('strong', `${n.room} · ${n.bed}`),
          n.severity !== 'clear' ? severityPill(n.severity) : null,
          h('span', n.note),
          n.by ? h('span.muted', `— ${n.by}`) : null,
        ))))
      : null,
  );

  return host;
}

/**
 * The heatmap: rooms down the side, days across the top.
 *
 * Built as a plain grid of divs rather than a chart, because the useful
 * interaction is hovering one square to find out what happened, and because it
 * has to survive a period of ninety days without becoming unreadable — the
 * squares shrink, the pattern stays.
 */
export function heatmapGrid(heatmap, { from, to } = {}) {
  if (!heatmap.rows.length) return h('p.muted', 'No rooms have been set up yet.');

  const days = heatmap.days;
  // Enough labels to anchor a date to, and no more: any closer together and
  // they collide, whether the period is a week or a quarter.
  const step = Math.max(1, Math.ceil(days.length / 12));
  // Set on each row rather than inherited through a custom property, because a
  // property set through element.style is not the same thing as one declared in
  // a stylesheet and would silently leave every square stacked in a column.
  const columns = { gridTemplateColumns: `repeat(${days.length}, minmax(6px, 1fr))` };

  return h('div.hk-heat-wrap',
    h('div.hk-heat',
      h('div.hk-heat-corner'),
      h('div.hk-heat-days', { style: columns }, days.map((day, i) => h('div.hk-heat-day',
        i % step === 0 ? h('span', fmtDayShort(day)) : null))),

      ...heatmap.rows.flatMap((row) => [
        h('div.hk-heat-room', { title: row.block || '' },
          h('button.hk-heat-room-btn', {
            onclick: () => navigate('hk-room', { id: row.roomId, ...(from ? { from } : {}), ...(to ? { to } : {}) }),
          }, row.name)),
        h('div.hk-heat-cells', { style: columns }, row.cells.map((cell) => h('div.hk-heat-cell', {
          class: `hk-heat-cell ${SEVERITY[cell.severity]?.cls ?? 'sev-clear'}`,
          title: `${row.name} · ${fmtDay(cell.day, { withYear: true })}\n`
            + (cell.checked
              ? `${cell.checked} of ${cell.beds} beds checked`
                + (cell.untagged ? ` · ${cell.untagged} without a name tag` : '')
                + (cell.issues && !cell.untagged ? ` · ${cell.issues} to look at` : '')
              : 'not checked'),
        }))),
      ]),
    ),
  );
}

function heatmapKey() {
  const swatch = (severity, label) => h('span',
    h('i', { class: `hk-key ${SEVERITY[severity].cls}` }), label);

  return h('div.legend',
    swatch('clear', 'All as it should be'),
    swatch('untagged', 'A bed with no name tag'),
    swatch('unexpected', 'Occupied when rostered free'),
    swatch('empty_booked', 'Empty when rostered occupied'),
    swatch('unchecked', 'Not checked'),
  );
}
