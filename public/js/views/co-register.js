import { api } from '../api.js';
import { navigate } from '../app.js';
import { debounce, h, mount } from '../util.js';
import { card, exportButton, table } from './components.js';
import {
  TYPE_LABEL, co, confidentialityPill, dueCell, fmtDate, priorityPill,
  select, statusPill,
} from './co-common.js';
import { openCompose } from './co-compose.js';

/**
 * The register: everything the firm has sent or received.
 *
 * A register is only useful if you can find one letter in ten thousand, so the
 * filters are the screen. They compose, they live in the URL, and the URL is
 * what somebody pastes into an email when they want a colleague to look at the
 * same list.
 *
 * Restricted letters are simply absent for anybody without oversight. Not
 * greyed out, not "you may not see this" — absent. A row saying a file exists
 * is itself the disclosure, for exactly the letters that get marked restricted.
 */
export async function renderCoRegister(params) {
  const boot = await co();
  const query = {
    q: params.q ?? '',
    type: params.type ?? '',
    status: params.status ?? 'open',
    party: params.party ?? '',
    category: params.category ?? '',
    department: params.department ?? '',
    overdue: params.overdue ?? '',
    mine: params.mine ?? '',
    archived: params.archived ?? '',
  };

  const data = await api.coLetters({ ...query, limit: 200 });
  const host = h('div');

  const go = (patch) => navigate('co-register', {
    ...Object.fromEntries(Object.entries({ ...query, ...patch }).filter(([, v]) => v)),
  });

  const search = h('input', {
    type: 'search',
    value: query.q,
    placeholder: 'Reference, subject, client, their reference…',
    style: { minWidth: '260px' },
  });
  // Debounced rather than on Enter: somebody hunting for a reference types four
  // characters and looks up, and a list that only moves on Enter looks broken.
  search.addEventListener('input', debounce(() => go({ q: search.value }), 400));

  const statuses = h('div.seg',
    // 'all' rather than an empty string: `go` drops empty values so the URL
    // stays readable, and a tab whose value is dropped is a tab that silently
    // snaps back to Open the moment you press it.
    ...[['open', 'Open'], ['awaiting_approval', 'Awaiting approval'], ['closed', 'Closed'], ['all', 'All']]
      .map(([value, label]) => h('button', {
        class: query.status === value ? 'active' : '',
        onclick: () => go({ status: value }),
      }, label)),
  );

  const types = h('div.seg',
    ...[['', 'All'], ...Object.entries(TYPE_LABEL)].map(([value, label]) => h('button', {
      class: query.type === value ? 'active' : '',
      onclick: () => go({ type: value }),
    }, label)),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'The register'),
        h('div.sub', `${data.total} entr${data.total === 1 ? 'y' : 'ies'}`
          + (data.total > data.letters.length ? `, showing the newest ${data.letters.length}` : '')),
      ),
      h('div.btn-row',
        exportButton(api.coExportUrl(), 'Export'),
        boot.permissions.includes('co_register')
          ? h('button.btn-primary.btn-sm', { onclick: () => openCompose({ boot }) }, '+ Register')
          : null,
      ),
    ),

    card(null, { wide: true },
      h('div.toolbar', search, statuses, types),
      h('div.toolbar.filter-bar',
        select([{ value: '', label: 'Any client or party' },
          ...boot.parties.map((p) => ({ value: p.id, label: p.name }))],
        { value: query.party, onchange: (v) => go({ party: v ?? '' }) }),

        select([{ value: '', label: 'Any category' },
          ...boot.categories.map((c) => ({ value: c.id, label: c.name }))],
        { value: query.category, onchange: (v) => go({ category: v ?? '' }) }),

        select([{ value: '', label: 'Any department' },
          ...boot.departments.map((d) => ({ value: d.id, label: d.name }))],
        { value: query.department, onchange: (v) => go({ department: v ?? '' }) }),

        h('label.inline-check',
          h('input', {
            type: 'checkbox',
            checked: query.overdue === '1',
            onchange: (e) => go({ overdue: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Overdue only'),
        ),
        h('label.inline-check',
          h('input', {
            type: 'checkbox',
            checked: query.mine === '1',
            onchange: (e) => go({ mine: e.target.checked ? '1' : '' }),
          }),
          h('span', 'With me'),
        ),
        h('label.inline-check',
          h('input', {
            type: 'checkbox',
            checked: query.archived === '1',
            onchange: (e) => go({ archived: e.target.checked ? '1' : '' }),
          }),
          h('span', 'Archived'),
        ),
      ),
    ),

    card(null, { wide: true }, registerTable(data.letters)),
  );

  return host;
}

export function registerTable(letters) {
  return table([
    {
      key: 'ref',
      label: 'Reference',
      format: (ref, r) => h('a', { href: `#/co-letter?id=${r.id}`, style: { fontWeight: '600' } }, ref),
    },
    {
      key: 'subject',
      label: 'Subject',
      format: (subject, r) => h('div',
        h('div', subject),
        h('small.muted',
          TYPE_LABEL[r.type] ?? r.type,
          r.partyName ? ` · ${r.partyName}` : '',
          r.caseRef ? ` · ${r.caseRef}` : '',
        ),
      ),
    },
    {
      key: 'withNames',
      label: 'With',
      format: (names, r) => (names
        ? h('div', h('div', names), h('small.muted', `${r.openRoutes} open`))
        : h('span.muted', 'nobody')),
    },
    {
      key: 'status',
      label: 'Status',
      format: (status, r) => h('div.btn-row',
        statusPill(status),
        priorityPill(r.priority),
        confidentialityPill(r.confidentiality),
      ),
    },
    {
      key: 'dueAt',
      label: 'Due',
      format: (due, r) => dueCell(due, { settled: ['closed', 'cancelled'].includes(r.status) }),
    },
    { key: 'createdAt', label: 'Registered', format: (v) => h('span.muted', fmtDate(v)) },
  ], letters, {
    rowClass: (r) => (r.overdue ? 'row-flag-high' : ''),
    empty: 'Nothing matches those filters. Widen them, or register the first letter.',
  });
}
