import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount, toast } from '../util.js';
import { card, exportButton, statTile, table } from './components.js';
import {
  co, dialogActions, field, fmtDate, fmtWhen, modal, partyOptions,
  personOptions, refreshCo, select, statusPill,
} from './co-common.js';
import { openCompose } from './co-compose.js';

/**
 * Engagements: the work a letter belongs to.
 *
 * Sorted by statutory deadline and nothing else. Every other ordering — client
 * name, date opened, partner — is a way of looking at a list; this one is the
 * order in which the firm gets into trouble.
 */
export async function renderCoCases(params) {
  const query = { status: params.status ?? 'open', party: params.party ?? '', type: params.type ?? '', mine: params.mine ?? '' };
  const [data, boot] = await Promise.all([api.coCases(query), co()]);
  const host = h('div');
  const reload = async () => mount(host, await renderCoCases(params));

  const now = new Date();
  const overdue = data.cases.filter((c) => c.statutory_due && new Date(c.statutory_due) < now).length;
  const soon = data.cases.filter((c) => {
    if (!c.statutory_due) return false;
    const days = (new Date(c.statutory_due) - now) / 86_400_000;
    return days >= 0 && days <= 30;
  }).length;

  const go = (patch) => navigate('co-cases', {
    ...Object.fromEntries(Object.entries({ ...query, ...patch }).filter(([, v]) => v)),
  });

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Engagements'),
        h('div.sub', 'Ordered by the deadline that carries a penalty'),
      ),
      h('div.btn-row',
        exportButton(api.coCasesExportUrl(), 'Export'),
        boot.permissions.includes('co_cases')
          ? h('button.btn-primary.btn-sm', { onclick: () => openCase(null, boot, reload) }, '+ Open an engagement')
          : null,
      ),
    ),

    h('div.grid.grid-4',
      statTile({ label: 'On the books', value: String(data.cases.length) }),
      statTile({
        label: 'Statutory deadline passed',
        value: String(overdue),
        accent: overdue ? 'var(--bad)' : null,
        sub: overdue ? 'these carry a penalty' : 'nothing has been missed',
      }),
      statTile({ label: 'Falling due in 30 days', value: String(soon) }),
      statTile({
        label: 'Open action points',
        value: String(data.cases.reduce((n, c) => n + (c.open_tasks ?? 0), 0)),
      }),
    ),

    card(null, { wide: true },
      h('div.toolbar',
        h('div.seg',
          ...[['open', 'Open'], ['active', 'Active'], ['review', 'In review'],
            ['completed', 'Completed'], ['all', 'All']].map(([value, label]) => h('button', {
            class: query.status === value ? 'active' : '',
            onclick: () => go({ status: value }),
          }, label)),
        ),
        select([{ value: '', label: 'Any client' }, ...boot.parties.map((p) => ({ value: p.id, label: p.name }))],
          { value: query.party, onchange: (v) => go({ party: v ?? '' }) }),
        select([{ value: '', label: 'Any kind' },
          ...['audit', 'tax', 'payroll', 'bookkeeping', 'advisory', 'secretarial', 'other']
            .map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))],
        { value: query.type, onchange: (v) => go({ type: v ?? '' }) }),
        h('label.inline-check',
          h('input', {
            type: 'checkbox',
            checked: query.mine === '1',
            onchange: (e) => go({ mine: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Mine'),
        ),
      )),

    card(null, { wide: true }, table([
      {
        key: 'ref',
        label: 'Reference',
        format: (ref, r) => h('a', { href: `#/co-case?id=${r.id}`, style: { fontWeight: '600' } }, ref),
      },
      {
        key: 'title',
        label: 'Engagement',
        format: (title, r) => h('div',
          h('div', title),
          h('small.muted', r.party_name ?? 'no client', r.period_label ? ` · ${r.period_label}` : ''),
        ),
      },
      { key: 'engagement_type', label: 'Kind', format: (v) => h('span.pill', v) },
      {
        key: 'statutory_due',
        label: 'Statutory',
        format: (due) => deadlineCell(due, now),
      },
      { key: 'target_due', label: 'Our target', format: (v) => (v ? h('span.muted', fmtDate(v)) : h('span.muted', '—')) },
      {
        key: 'partner_name',
        label: 'Partner / manager',
        format: (partner, r) => h('div',
          h('div', partner ?? h('span.muted', 'unassigned')),
          r.manager_name ? h('small.muted', r.manager_name) : null,
        ),
      },
      {
        key: 'open_tasks',
        label: 'Open',
        align: 'right',
        format: (tasks, r) => h('div',
          h('div', `${tasks ?? 0} points`),
          h('small.muted', `${r.letters ?? 0} letters`),
        ),
      },
      { key: 'status', label: 'Status', format: (v) => statusPill(v) },
    ], data.cases, {
      rowClass: (r) => (r.statutory_due && new Date(r.statutory_due) < now ? 'row-flag-high' : ''),
      empty: 'No engagements yet.',
    })),
  );

  return host;
}

/** How much runway is left, said as a number of days rather than a date. */
function deadlineCell(due, now) {
  if (!due) return h('span.muted', 'none set');
  const days = Math.round((new Date(due) - now) / 86_400_000);
  if (Number.isNaN(days)) return h('span.muted', String(due));
  if (days < 0) return h('span.pill.bad', `${Math.abs(days)} days past`);
  if (days <= 14) return h('span.pill.warn', `${days} days`);
  if (days <= 30) return h('span.pill.info', `${days} days`);
  return h('span', fmtDate(due));
}

/** One engagement: its letters, its action points, its meetings, its files. */
export async function renderCoCase(params) {
  const id = Number(params.id);
  if (!id) return h('div.card.empty', h('h3', 'No engagement chosen'), h('p', 'Open one from the list.'));

  const [data, boot] = await Promise.all([api.coCase(id), co()]);
  const kase = data.case;
  const host = h('div');
  const reload = async () => mount(host, await renderCoCase(params));
  const may = (p) => boot.permissions.includes(p);

  const openPoints = data.tasks.filter((t) => ['open', 'in_progress', 'blocked'].includes(t.status));
  const donePoints = data.tasks.filter((t) => t.status === 'done');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', kase.ref),
        h('div.sub', kase.title),
        h('div.btn-row', { style: { marginTop: '.4rem' } },
          h('span.pill', kase.engagement_type),
          statusPill(kase.status),
          kase.party_name ? h('span.pill.info', kase.party_name) : null,
        ),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('co-cases') }, '← Engagements'),
        may('co_register')
          ? h('button.btn-sm', { onclick: () => openCompose({ boot, type: 'outgoing', caseId: kase.id }) }, '+ Letter')
          : null,
        may('co_cases')
          ? h('button.btn-sm.btn-primary', { onclick: () => openCase(kase, boot, reload) }, 'Edit')
          : null,
      ),
    ),

    h('div.grid.grid-4',
      statTile({
        label: 'Statutory deadline',
        value: kase.statutory_due ? fmtDate(kase.statutory_due) : '—',
        sub: kase.statutory_due
          ? `${Math.round((new Date(kase.statutory_due) - new Date()) / 86_400_000)} days`
          : 'none recorded',
      }),
      statTile({ label: 'Our own target', value: kase.target_due ? fmtDate(kase.target_due) : '—' }),
      statTile({
        label: 'Action points',
        value: `${donePoints.length}/${data.tasks.length}`,
        sub: openPoints.length ? `${openPoints.length} still open` : 'all done',
      }),
      statTile({
        label: 'Hours',
        value: `${Number(data.tasks.reduce((n, t) => n + Number(t.hours ?? 0), 0)).toFixed(1)}`,
        sub: kase.budget_hours ? `of ${kase.budget_hours} budgeted` : 'no budget set',
      }),
    ),

    kase.note ? card('Note', { wide: true }, h('p', kase.note)) : null,

    card('Correspondence', { wide: true }, table([
      { key: 'ref', label: 'Reference', format: (ref, r) => h('a', { href: `#/co-letter?id=${r.id}` }, ref) },
      { key: 'subject', label: 'Subject' },
      { key: 'type', label: 'Kind', format: (v) => h('span.pill', v) },
      { key: 'status', label: 'Status', format: (v) => statusPill(v) },
      { key: 'created_at', label: 'Registered', format: (v) => h('span.muted', fmtDate(v)) },
    ], data.letters, { empty: 'No correspondence filed against this engagement yet.' })),

    card('Action points', { wide: true }, table([
      { key: 'title', label: 'What' },
      { key: 'assignee_name', label: 'Who', format: (v) => v ?? h('span.muted', 'unassigned') },
      { key: 'due_at', label: 'Due', format: (v) => (v ? fmtDate(v) : h('span.muted', '—')) },
      { key: 'status', label: 'Status', format: (v) => h('span.pill', v) },
      { key: 'hours', label: 'Hours', align: 'right', format: (v) => (Number(v) || 0).toFixed(1) },
    ], data.tasks, { empty: 'No action points on this engagement.' })),

    data.meetings.length
      ? card('Meetings', { wide: true }, table([
        { key: 'title', label: 'Meeting' },
        { key: 'starts_at', label: 'When', format: (v) => fmtWhen(v) },
        { key: 'status', label: '', format: (v) => h('span.pill', v) },
      ], data.meetings))
      : null,
  );

  return host;
}

function openCase(kase, boot, reload) {
  const title = h('input', { value: kase?.title ?? '', maxlength: 300 });
  const party = select(partyOptions(boot.parties, { blank: '— no client —' }), { value: kase?.party_id ?? '' });
  const type = select(
    ['audit', 'tax', 'payroll', 'bookkeeping', 'advisory', 'secretarial', 'other']
      .map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })),
    { value: kase?.engagement_type ?? 'audit' },
  );
  const periodLabel = h('input', { value: kase?.period_label ?? '', maxlength: 80, placeholder: 'e.g. Year ended 31 Dec 2026' });
  const periodEnd = h('input', { type: 'date', value: (kase?.period_end ?? '').slice(0, 10) });
  const statutoryDue = h('input', { type: 'date', value: (kase?.statutory_due ?? '').slice(0, 10) });
  const targetDue = h('input', { type: 'date', value: (kase?.target_due ?? '').slice(0, 10) });
  const partner = select(personOptions(boot.staff, { blank: '— unassigned —' }), { value: kase?.partner_user_id ?? '' });
  const manager = select(personOptions(boot.staff, { blank: '— unassigned —' }), { value: kase?.manager_user_id ?? '' });
  const budgetHours = h('input', { type: 'number', min: '0', step: '0.5', value: kase?.budget_hours ?? 0 });
  const fee = h('input', { type: 'number', min: '0', step: '0.01', value: kase?.fee ?? 0 });
  const note = h('textarea', { rows: 3, value: kase?.note ?? '' });
  const status = select(
    ['planned', 'active', 'review', 'on_hold', 'completed', 'archived']
      .map((s) => ({ value: s, label: s.replace('_', ' ') })),
    { value: kase?.status ?? 'planned' },
  );

  const dialog = modal(kase ? `Edit ${kase.ref}` : 'Open an engagement', { width: '720px' },
    field('Title', title),
    h('div.field-row', field('Client', party), field('Kind', type), field('Status', status)),
    h('div.field-row', field('Period', periodLabel), field('Period end', periodEnd)),
    h('div.field-row',
      field('Statutory deadline', statutoryDue, 'The one that carries a penalty'),
      field('Our own target', targetDue, 'Deliberately separate — missing yours costs a conversation'),
    ),
    h('div.field-row', field('Partner', partner), field('Manager', manager)),
    h('div.field-row', field('Budget hours', budgetHours), field('Fee', fee)),
    field('Note', note),
  );

  dialog.append(dialogActions(dialog, kase ? 'Save' : 'Open it', async () => {
    const body = {
      title: title.value.trim(),
      partyId: party.value || null,
      engagementType: type.value,
      periodLabel: periodLabel.value.trim(),
      periodEnd: periodEnd.value || null,
      statutoryDue: statutoryDue.value || null,
      targetDue: targetDue.value || null,
      partnerUserId: partner.value || null,
      managerUserId: manager.value || null,
      budgetHours: Number(budgetHours.value) || 0,
      fee: Number(fee.value) || 0,
      note: note.value.trim(),
      status: status.value,
    };
    if (!body.title) throw new Error('An engagement needs a title');
    if (kase) await api.coUpdateCase(kase.id, body);
    else await api.coCreateCase(body);
    refreshCo();
    toast('Saved', 'good');
    await reload();
  }));

  setTimeout(() => title.focus(), 0);
}
