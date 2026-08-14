import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import {
  caseOptions, co, dialogActions, field, fmtWhen, inHours, localInput, modal,
  personOptions, refreshCo, select, toStamp,
} from './co-common.js';

/**
 * Meetings, and the minutes that turn them into work.
 *
 * A recurring meeting is stored once, as the rule, and the diary holds only the
 * next occurrence. The hourly sweep adds the one after it as each passes. That
 * is deliberately different from generating a year in advance: a series whose
 * time changes would leave fifty wrong rows behind it, and a diary showing only
 * what is genuinely next is the one people trust.
 */
export async function renderCoMeetings(params) {
  const upcoming = params.view !== 'past';
  const data = await api.coMeetings(upcoming ? { upcoming: true } : {});
  const boot = await co();
  const host = h('div');
  const reload = async () => mount(host, await renderCoMeetings(params));

  const meetings = upcoming
    ? [...data.meetings].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    : data.meetings;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Meetings'),
        h('div.sub', upcoming ? 'What is coming up' : 'What has been held'),
      ),
      h('div.btn-row',
        h('div.seg',
          ...[['', 'Upcoming'], ['past', 'All']].map(([value, label]) => h('button', {
            class: (params.view ?? '') === value ? 'active' : '',
            onclick: () => navigate('co-meetings', value ? { view: value } : {}),
          }, label)),
        ),
        h('button.btn-primary.btn-sm', { onclick: () => openMeeting(null, boot, reload) }, '+ Schedule'),
      ),
    ),

    card(null, { wide: true }, table([
      {
        key: 'title',
        label: 'Meeting',
        format: (title, r) => h('div',
          h('div', h('b', title)),
          h('small.muted',
            r.location ? `${r.location} · ` : '',
            r.case_ref ? `${r.case_ref} · ` : '',
            `${r.attendee_count ?? 0} invited`,
            r.series_id ? ' · part of a series' : '',
          ),
        ),
      },
      { key: 'starts_at', label: 'When', format: (v) => h('span.nowrap', fmtWhen(v)) },
      { key: 'duration_mins', label: 'For', format: (v) => `${v} min` },
      { key: 'organiser_name', label: 'Called by', format: (v) => v ?? h('span.muted', '—') },
      {
        key: 'action_points',
        label: 'Action points',
        align: 'right',
        format: (n) => (n ? h('a', { href: '#/co-tasks' }, String(n)) : h('span.muted', '—')),
      },
      {
        key: 'status',
        label: 'Status',
        format: (status, r) => h('div.btn-row',
          h(`span.pill${status === 'held' ? '.good' : status === 'cancelled' ? '.bad' : ''}`, status),
          r.minutes ? h('span.pill.info', 'minuted') : null,
        ),
      },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => h('div.btn-row', { style: { justifyContent: 'flex-end' } },
          h('button.btn-sm', { onclick: () => openMeeting(r, boot, reload) }, 'Edit'),
          h('button.btn-sm.btn-primary', { onclick: () => openMinutes(r, boot, reload) },
            r.minutes ? 'Minutes' : 'Record minutes'),
        ),
      },
    ], meetings, {
      empty: upcoming ? 'Nothing in the diary.' : 'No meetings recorded.',
    })),

    data.series.length
      ? card('Standing meetings', {
        wide: true,
        note: 'The rules behind the recurring entries above. The next occurrence is created as each one passes.',
      }, table([
        { key: 'title', label: 'Meeting' },
        { key: 'recurrence', label: 'Repeats', format: (v) => h('span.pill', v) },
        { key: 'starts_at', label: 'Started', format: (v) => fmtWhen(v) },
        { key: 'recurrence_until', label: 'Until', format: (v) => (v ? fmtWhen(v) : h('span.muted', 'no end')) },
        { key: 'occurrences', label: 'Held so far', align: 'right' },
        {
          key: 'id',
          label: '',
          align: 'right',
          format: (id, r) => h('button.btn-sm', {
            onclick: () => {
              if (!window.confirm(`Stop "${r.title}" repeating? Occurrences already in the diary stay where they are.`)) return;
              api.coUpdateMeeting(id, { status: 'cancelled' })
                .then(() => { toast('Series ended', 'good'); reload(); })
                .catch((err) => toast(err.message, 'bad'));
            },
          }, 'End series'),
        },
      ], data.series))
      : null,
  );

  return host;
}

function openMeeting(meeting, boot, reload) {
  const title = h('input', { value: meeting?.title ?? '', maxlength: 300 });
  const agenda = h('textarea', { rows: 6, value: meeting?.agenda ?? '', placeholder: 'One line per item' });
  const startsAt = h('input', { type: 'datetime-local', value: meeting ? localInput(meeting.starts_at) : inHours(24) });
  const duration = h('input', { type: 'number', min: '5', step: '5', value: meeting?.duration_mins ?? 60 });
  const location = h('input', { value: meeting?.location ?? '', maxlength: 200, placeholder: 'Boardroom, or a video link' });
  const kase = select(caseOptions(boot.cases), { value: meeting?.case_id ?? '' });
  const recurrence = select(
    [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'],
      ['fortnightly', 'Every two weeks'], ['monthly', 'Monthly'],
      ['quarterly', 'Quarterly'], ['yearly', 'Yearly']].map(([value, label]) => ({ value, label })),
    { value: 'none' },
  );
  const until = h('input', { type: 'date', value: (meeting?.recurrence_until ?? '').slice(0, 10) });

  // Attendees as checkboxes: every meeting here is internal to the firm plus
  // the occasional client, and a picker with a search box would be more
  // machinery than a practice of thirty people ever needs.
  const chosen = new Set();
  const attendeeList = h('div', { style: { display: 'grid', gap: '.3rem', maxHeight: '190px', overflowY: 'auto' } },
    ...boot.staff.map((person) => h('label.inline-check',
      h('input', {
        type: 'checkbox',
        onchange: (e) => (e.target.checked ? chosen.add(person.id) : chosen.delete(person.id)),
      }),
      h('span', person.name, person.title ? h('small.muted', ` · ${person.title}`) : null),
    )),
  );

  const dialog = modal(meeting ? 'Edit meeting' : 'Schedule a meeting', { width: '680px' },
    field('Title', title),
    h('div.field-row',
      field('Starts', startsAt),
      field('Minutes', duration),
      field('Where', location),
    ),
    field('Agenda', agenda),
    h('div.field-row', field('Engagement', kase), field('Repeat', recurrence), field('Repeat until', until)),
    meeting ? null : field('Who is invited', attendeeList),
  );

  dialog.append(dialogActions(dialog, meeting ? 'Save' : 'Schedule it', async () => {
    const body = {
      title: title.value.trim(),
      agenda: agenda.value.trim(),
      startsAt: toStamp(startsAt.value),
      durationMins: Number(duration.value) || 60,
      location: location.value.trim(),
      caseId: kase.value || null,
    };
    if (!body.title) throw new Error('A meeting needs a title');
    if (!body.startsAt) throw new Error('When does it start?');

    if (meeting) {
      await api.coUpdateMeeting(meeting.id, { ...body, recurrenceUntil: until.value || null });
    } else {
      await api.coCreateMeeting({
        ...body,
        recurrence: recurrence.value,
        recurrenceUntil: until.value || undefined,
        attendees: [...chosen].map((id) => ({ userId: id })),
      });
    }
    refreshCo();
    toast('Saved', 'good');
    await reload();
  }));

  setTimeout(() => title.focus(), 0);
}

/**
 * Minutes, and the action points that come out of them.
 *
 * The two are recorded together on purpose. "Ama to write to the Registrar by
 * Friday" typed into a minutes box is a sentence; typed into the rows below it
 * is a thing with a name, a date and a reminder attached.
 */
async function openMinutes(meeting, boot, reload) {
  const full = await api.coMeeting(meeting.id);
  const minutes = h('textarea', {
    rows: 14,
    value: full.meeting.minutes ?? '',
    placeholder: 'Present, apologies, what was discussed, what was decided.',
  });

  const rows = h('div', { style: { display: 'grid', gap: '.5rem' } });
  const addRow = (point = null) => {
    const what = h('input', { placeholder: 'What has to happen', value: point?.title ?? '', maxlength: 300 });
    const who = select(personOptions(boot.staff, { blank: '— unassigned —' }), { value: point?.assignee_user_id ?? '' });
    const when = h('input', { type: 'date', value: (point?.due_at ?? '').slice(0, 10) });
    const row = h('div', {
      style: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '.4rem', alignItems: 'center' },
      dataset: { row: '1' },
    },
      what, who, when,
      h('button.btn-sm.btn-ghost', { onclick: () => row.remove() }, '✕'),
    );
    row.fields = { what, who, when };
    rows.append(row);
  };
  addRow();
  addRow();

  const dialog = modal(`Minutes — ${meeting.title}`, { width: '780px' },
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } },
      `${fmtWhen(meeting.starts_at)}${meeting.location ? ` · ${meeting.location}` : ''}`),

    full.meeting.agenda
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div', h('div.alert-title', 'Agenda'),
          h('div.alert-detail', { style: { whiteSpace: 'pre-line' } }, full.meeting.agenda)))
      : null,

    full.attendees.length
      ? field('Invited', h('p.muted', { style: { margin: 0 } },
        full.attendees.map((a) => a.user_name ?? a.party_name ?? a.name).filter(Boolean).join(', ')))
      : null,

    field('Minutes', minutes),

    field('Action points', h('div',
      rows,
      h('button.btn-sm', { style: { marginTop: '.4rem' }, onclick: () => addRow() }, '+ Another'),
    ), 'Each one becomes a tracked action point with its own reminder'),

    full.tasks.length
      ? h('p.muted', { style: { fontSize: '.82rem' } },
        `${full.tasks.length} action point${full.tasks.length === 1 ? '' : 's'} already raised from this meeting. `
        + 'Rows added here are new ones — they do not replace those.')
      : null,
  );

  dialog.append(dialogActions(dialog, 'Save minutes', async () => {
    if (!minutes.value.trim()) throw new Error('Write something. Minutes are the point of the meeting having happened.');

    const actionPoints = [...rows.children]
      .map((row) => ({
        title: row.fields.what.value.trim(),
        assigneeUserId: row.fields.who.value || null,
        dueAt: row.fields.when.value ? `${row.fields.when.value}T17:00:00Z` : null,
      }))
      .filter((point) => point.title);

    const result = await api.coRecordMinutes(meeting.id, {
      minutes: minutes.value.trim(),
      actionPoints,
    });
    toast(result.actionPoints
      ? `Minuted, with ${result.actionPoints} action point${result.actionPoints === 1 ? '' : 's'}`
      : 'Minuted', 'good');
    await reload();
  }));
}

