import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount, toast } from '../util.js';
import { card, statTile, table } from './components.js';
import {
  act, caseOptions, co, dialogActions, dueCell, field, localInput, modal,
  personOptions, priorityPill, select, toStamp,
} from './co-common.js';

/**
 * Action points.
 *
 * Everything somebody agreed to do: raised by hand, produced by a letter, or —
 * most of them — written straight out of a meeting's minutes. Minutes with no
 * action points are a document nobody opens again, so the meeting screen makes
 * them here and this is where they are then chased.
 */
export async function renderCoTasks(params) {
  const query = {
    status: params.status ?? 'open',
    mine: params.mine ?? '',
    case: params.case ?? '',
    overdue: params.overdue ?? '',
  };
  const [data, boot] = await Promise.all([api.coTasks(query), co()]);
  const host = h('div');
  const reload = async () => mount(host, await renderCoTasks(params));

  const now = new Date();
  const open = data.tasks.filter((t) => ['open', 'in_progress', 'blocked'].includes(t.status));
  const overdue = open.filter((t) => t.due_at && new Date(t.due_at) < now);
  const done = data.tasks.filter((t) => t.status === 'done');

  const go = (patch) => navigate('co-tasks', {
    ...Object.fromEntries(Object.entries({ ...query, ...patch }).filter(([, v]) => v)),
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Action points'),
        h('div.sub', 'What people agreed to do, and whether they have'),
      ),
      boot.permissions.includes('co_tasks')
        ? h('button.btn-primary.btn-sm', { onclick: () => openTask(null, boot, reload) }, '+ Raise one')
        : null,
    ),

    h('div.grid.grid-4',
      statTile({ label: 'Open', value: String(open.length) }),
      statTile({
        label: 'Overdue',
        value: String(overdue.length),
        accent: overdue.length ? 'var(--bad)' : null,
      }),
      statTile({ label: 'Completed', value: String(done.length) }),
      statTile({
        label: 'Progress',
        value: open.length + done.length
          ? `${Math.round((done.length / (open.length + done.length)) * 100)}%`
          : '—',
        sub: 'of everything raised',
      }),
    ),

    card(null, { wide: true },
      h('div.toolbar',
        h('div.seg',
          ...[['open', 'Open'], ['done', 'Done'], ['all', 'All']].map(([value, label]) => h('button', {
            class: query.status === value ? 'active' : '',
            onclick: () => go({ status: value }),
          }, label)),
        ),
        select(caseOptions(boot.cases, { blank: 'Any engagement' }),
          { value: query.case, onchange: (v) => go({ case: v ?? '' }) }),
        h('label.inline-check',
          h('input', {
            type: 'checkbox', checked: query.mine === '1',
            onchange: (e) => go({ mine: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Mine only'),
        ),
        h('label.inline-check',
          h('input', {
            type: 'checkbox', checked: query.overdue === '1',
            onchange: (e) => go({ overdue: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Overdue only'),
        ),
      )),

    card(null, { wide: true }, table([
      {
        key: 'title',
        label: 'What',
        format: (title, r) => h('div',
          h('div', title),
          h('small.muted',
            r.case_ref ? `${r.case_ref} · ` : '',
            r.letter_ref ? `${r.letter_ref} · ` : '',
            r.meeting_title ? `from ${r.meeting_title}` : `raised by ${r.created_by ?? 'somebody'}`,
          ),
        ),
      },
      { key: 'assignee_name', label: 'Who', format: (v) => v ?? h('span.muted', 'unassigned') },
      { key: 'priority', label: '', format: (v) => priorityPill(v) ?? '' },
      {
        key: 'due_at',
        label: 'Due',
        format: (v, r) => dueCell(v, { settled: ['done', 'cancelled'].includes(r.status) }),
      },
      {
        key: 'status',
        label: 'Status',
        format: (status, r) => select(
          [['open', 'Open'], ['in_progress', 'In progress'], ['blocked', 'Blocked'],
            ['done', 'Done'], ['cancelled', 'Cancelled']].map(([value, label]) => ({ value, label })),
          {
            value: status,
            onchange: (value) => act(api.coUpdateTask(r.id, { status: value }), 'Updated', reload),
          },
        ),
      },
      {
        key: 'hours',
        label: 'Hours',
        align: 'right',
        format: (hours, r) => {
          const input = h('input', {
            type: 'number', min: '0', step: '0.25', value: hours ?? 0,
            style: { width: '5.5rem', textAlign: 'right' },
          });
          input.addEventListener('change', () => {
            act(api.coUpdateTask(r.id, { hours: Number(input.value) || 0 }), null, null).catch(() => {});
          });
          return input;
        },
      },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => h('button.btn-sm', { onclick: () => openTask(r, boot, reload) }, 'Edit'),
      },
    ], data.tasks, {
      rowClass: (r) => (r.due_at && new Date(r.due_at) < now
        && ['open', 'in_progress', 'blocked'].includes(r.status) ? 'row-flag-high' : ''),
      empty: 'Nothing here. Either everything is done or nobody has written anything down.',
    })),
  );

  return host;
}

export function openTask(task, boot, reload, { caseId = null, letterId = null, meetingId = null } = {}) {
  const title = h('input', { value: task?.title ?? '', maxlength: 300, placeholder: 'What has to happen' });
  const detail = h('textarea', { rows: 3, value: task?.detail ?? '' });
  const assignee = select(personOptions(boot.staff, { blank: '— unassigned —' }),
    { value: task?.assignee_user_id ?? '' });
  const kase = select(caseOptions(boot.cases), { value: task?.case_id ?? caseId ?? '' });
  const due = h('input', { type: 'datetime-local', value: localInput(task?.due_at) });
  const priority = select(
    [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]
      .map(([value, label]) => ({ value, label })),
    { value: task?.priority ?? 'normal' },
  );

  const dialog = modal(task ? 'Edit action point' : 'Raise an action point', {},
    field('What', title),
    field('Detail', detail),
    h('div.field-row', field('Who', assignee), field('Priority', priority)),
    h('div.field-row', field('Engagement', kase), field('Due', due)),
  );

  dialog.append(dialogActions(dialog, task ? 'Save' : 'Raise it', async () => {
    const body = {
      title: title.value.trim(),
      detail: detail.value.trim(),
      assigneeUserId: assignee.value || null,
      caseId: kase.value || null,
      dueAt: toStamp(due.value),
      priority: priority.value,
      ...(task ? {} : { letterId: letterId ?? undefined, meetingId: meetingId ?? undefined }),
    };
    if (!body.title) throw new Error('Say what has to happen');
    if (task) await api.coUpdateTask(task.id, body);
    else await api.coCreateTask(body);
    toast('Saved', 'good');
    if (reload) await reload();
  }));

  setTimeout(() => title.focus(), 0);
}

