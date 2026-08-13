import { api } from '../api.js';
import { h, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * Periodic stock counts.
 *
 * A schedule is a standing arrangement — "count the parts store every 30 days,
 * and ask Kofi and Ama". When the day arrives the system opens a task and tells
 * them by email and in the bell; recording a count closes it.
 *
 * The people asked are stored as a list rather than a role, because who counts
 * is a rota decision, not a permissions one.
 */

const PERIODS = [
  { days: 7, label: 'Every week' },
  { days: 14, label: 'Every two weeks' },
  { days: 30, label: 'Every month' },
  { days: 90, label: 'Every quarter' },
  { days: 180, label: 'Twice a year' },
  { days: 365, label: 'Once a year' },
];

function periodLabel(days) {
  return PERIODS.find((p) => p.days === days)?.label ?? `Every ${days} days`;
}

function periodSelect(selected) {
  return h('select', PERIODS.map((p) => h('option', {
    value: String(p.days), selected: p.days === selected,
  }, p.label)));
}

/** Tick boxes for who gets asked. */
function assigneePicker(people, chosenIds) {
  const chosen = new Set(chosenIds ?? []);

  if (!people?.length) {
    return {
      node: h('p.muted', { style: { fontSize: '.82rem' } },
        'Nobody to ask yet — add people under Users & data.'),
      get value() { return []; },
    };
  }

  const node = h('div', {
    style: { display: 'flex', flexWrap: 'wrap', gap: '.45rem .9rem' },
  }, people.map((person) => {
    const box = h('input', {
      type: 'checkbox',
      checked: chosen.has(person.id),
      style: { width: 'auto', margin: 0 },
      onchange: () => (box.checked ? chosen.add(person.id) : chosen.delete(person.id)),
    });
    return h('label', {
      style: { display: 'flex', gap: '.4rem', alignItems: 'center', cursor: 'pointer' },
    }, box, h('span', person.name));
  }));

  return { node, get value() { return [...chosen]; } };
}

/** The two cards, for the maintenance setup screen. */
export function schedulesCard(data, reload) {
  return h('div', scheduleCard(data, reload), taskCard(data, reload));
}

function scheduleCard(data, reload) {
  const name = h('input', { type: 'text', placeholder: 'e.g. Monthly parts count', maxlength: 120 });
  const every = periodSelect(30);
  const first = h('input', { type: 'date', value: data.today });
  const note = h('input', { type: 'text', placeholder: 'Anything the counter should know', maxlength: 200 });
  const picker = assigneePicker(data.people, []);

  const add = async (event) => {
    if (!name.value.trim()) { toast('Give the count a name', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.mxCreateStocktake({
        name: name.value.trim(),
        everyDays: Number(every.value),
        nextDue: first.value || undefined,
        note: note.value.trim() || null,
        assignees: picker.value,
      });
      toast('Schedule added', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const askNow = async (event, schedule) => {
    event.target.disabled = true;
    try {
      const result = await api.mxRunStocktake(schedule.id);
      if (result.opened) toast('Asked. Everybody listed has been notified.', 'good');
      else if (result.existing === 'done') toast('This store was already counted today.', 'warn');
      else toast('That count has already been asked for today.', 'warn');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const stop = async (event, schedule) => {
    if (!confirm(`Remove the "${schedule.name}" schedule? Counts already recorded are kept.`)) return;
    event.target.disabled = true;
    try {
      await api.mxDeleteStocktake(schedule.id);
      toast('Schedule removed', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const columns = [
    {
      key: 'name',
      label: 'Count',
      format: (value, row) => h('div',
        h('strong', value),
        row.note ? h('div.muted', { style: { fontSize: '.78rem' } }, row.note) : null,
        row.active ? null : h('span.pill', { style: { marginTop: '.2rem' } }, 'stopped'),
      ),
    },
    { key: 'everyDays', label: 'How often', format: (value) => periodLabel(value) },
    {
      key: 'nextDue',
      label: 'Next due',
      format: (value, row) => h('span', value,
        row.overdue ? h('span.pill.bad', { style: { marginLeft: '.4rem' } }, 'due') : null),
    },
    { key: 'lastDone', label: 'Last done', format: (value) => value || h('span.muted', 'never') },
    {
      key: 'assignees',
      label: 'Who is asked',
      format: (value) => (value?.length
        ? value.map((a) => a.name).join(', ')
        : h('span.muted', 'anyone who can count')),
    },
    {
      key: 'id',
      label: '',
      format: (value, row) => h('div', { style: { display: 'flex', gap: '.3rem', flexWrap: 'wrap' } },
        h('button.btn-sm.btn-ghost', {
          title: 'Ask for this count now, without waiting for the date',
          onclick: (event) => askNow(event, row),
        }, 'Ask now'),
        h('button.btn-sm.btn-ghost', { onclick: () => editSchedule(row, data, reload) }, 'Edit'),
        h('button.btn-sm.btn-ghost', { onclick: (event) => stop(event, row) }, 'Remove'),
      ),
    },
  ];

  const running = (data.schedules ?? []).filter((s) => s.active).length;

  return card('Scheduled stock counts', {
    wide: true,
    note: running ? `${running} running` : 'none set up',
  },
    h('p.muted', { style: { marginTop: 0 } },
      'When one of these comes round, everybody listed gets an email and a notification '
      + 'in the bell. Recording a count closes it — nobody has to tick anything off.'),

    h('div.field-row', { style: { marginTop: '.8rem' } },
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'How often'), every),
      h('label.field', h('span', 'First count on'), first),
      h('label.field', h('span', 'Note (optional)'), note),
    ),
    h('div', { style: { marginTop: '.6rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Ask these people'),
      picker.node,
    ),
    h('button.btn-primary', { style: { marginTop: '.7rem' }, onclick: add }, 'Add this schedule'),

    h('div', { style: { marginTop: '1.1rem' } },
      table(columns, data.schedules ?? [], {
        rowClass: (row) => (row.overdue ? 'row-flag-high' : ''),
        empty: 'No scheduled counts yet. Without one, counting happens when somebody remembers.',
      }),
    ),
  );
}

function editSchedule(schedule, data, reload) {
  const name = h('input', { type: 'text', value: schedule.name, maxlength: 120 });
  const every = periodSelect(schedule.everyDays);
  const next = h('input', { type: 'date', value: schedule.nextDue });
  const note = h('input', { type: 'text', value: schedule.note ?? '', maxlength: 200 });
  const active = h('select',
    h('option', { value: '1', selected: schedule.active }, 'Running'),
    h('option', { value: '0', selected: !schedule.active }, 'Stopped'),
  );
  const picker = assigneePicker(data.people, schedule.assignees.map((a) => a.id));

  const problem = h('div.form-error.hidden');

  const save = async (event) => {
    if (!name.value.trim()) {
      problem.textContent = 'Give the count a name.';
      problem.classList.remove('hidden');
      return;
    }
    event.target.disabled = true;
    try {
      await api.mxUpdateStocktake(schedule.id, {
        name: name.value.trim(),
        everyDays: Number(every.value),
        nextDue: next.value,
        note: note.value.trim() || null,
        active: active.value === '1',
        assignees: picker.value,
      });
      toast('Saved', 'good');
      dialog.close();
      reload();
    } catch (err) {
      problem.textContent = err.message;
      problem.classList.remove('hidden');
      event.target.disabled = false;
    }
  };

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '560px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', `Edit “${schedule.name}”`),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'How often'), every),
      h('label.field', h('span', 'Next due'), next),
      h('label.field', h('span', 'Status'), active),
    ),
    h('label.field', h('span', 'Note (optional)'), note),
    h('div', { style: { marginTop: '.6rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Ask these people'),
      picker.node,
    ),
    problem,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, 'Save changes'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

function taskCard(data, reload) {
  const tasks = data.tasks ?? [];
  const open = tasks.filter((t) => t.status === 'open');

  const cancel = async (event, task) => {
    if (!confirm('Cancel this count? It will be asked for again on the next due date.')) return;
    event.target.disabled = true;
    try {
      await api.mxCancelStocktakeTask(task.id);
      toast('Cancelled', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const columns = [
    { key: 'name', label: 'Count' },
    {
      key: 'dueDay',
      label: 'Due',
      format: (value, row) => h('span', value,
        row.status === 'open' && value < data.today
          ? h('span.pill.bad', { style: { marginLeft: '.4rem' } }, 'late') : null),
    },
    {
      key: 'status',
      label: 'State',
      format: (value) => {
        if (value === 'done') return h('span.pill.good', 'counted');
        if (value === 'cancelled') return h('span.pill', 'cancelled');
        return h('span.pill.warn', 'waiting');
      },
    },
    {
      key: 'completedBy',
      label: 'Done by',
      format: (value, row) => (value
        ? `${value} · ${row.itemsCounted} ${row.itemsCounted === 1 ? 'item' : 'items'}`
        : h('span.muted', '—')),
    },
    {
      key: 'id',
      label: '',
      format: (value, row) => (row.status === 'open'
        ? h('button.btn-sm.btn-ghost', { onclick: (event) => cancel(event, row) }, 'Cancel')
        : ''),
    },
  ];

  return card('Counts asked for', {
    wide: true,
    note: open.length ? `${open.length} still waiting` : 'nothing outstanding',
  },
    table(columns, tasks, { empty: 'Nothing has been asked for yet.' }),
  );
}
