import { api } from '../api.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, shiftDay, todayISO } from '../util.js';
import { card, emptyState, statTile, table } from './components.js';
import { minutes, statusPill, timeOf } from './store-common.js';

/**
 * The manager's view of the storeroom: what was asked for, what was issued
 * and what it cost, and the handful of things that need a look.
 *
 * Nobody approves an issue before it happens; this is where it is seen after.
 */
export async function renderStoreReport(params = {}) {
  const to = params.to || todayISO();
  const from = params.from || shiftDay(to, -6);
  const data = await api.storeReport(from, to);
  const host = h('div');
  const rerange = (f, t) => renderStoreReport({ from: f, to: t }).then((view) => mount(host, view));

  const top = data.byItem[0]?.value || 0;
  const levelClass = { high: 'high', warn: 'warn', info: 'info' };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Storeroom report'),
        h('div.sub', `What was asked for, issued and used · ${fmtDay(data.from)} – ${fmtDay(data.to)}`)),
    ),
    h('div.toolbar',
      h('input', { type: 'date', value: data.from, 'aria-label': 'From', onchange: (e) => rerange(e.target.value, data.to) }),
      h('span.muted', 'to'),
      h('input', { type: 'date', value: data.to, 'aria-label': 'To', onchange: (e) => rerange(data.from, e.target.value) }),
      h('button.btn-sm', { onclick: () => rerange(shiftDay(todayISO(), -6), todayISO()) }, 'Last 7 days'),
      h('button.btn-sm', { onclick: () => rerange(shiftDay(todayISO(), -29), todayISO()) }, 'Last 30 days'),
    ),

    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      statTile({
        label: 'Requests',
        value: fmtNum(data.counts.requests, 0),
        sub: [`${data.counts.full} in full`, data.counts.partly ? `${data.counts.partly} partly` : null,
          data.counts.declined ? `${data.counts.declined} declined` : null,
          data.counts.waiting ? `${data.counts.waiting} waiting` : null].filter(Boolean).join(' · '),
      }),
      statTile({
        label: 'Time to issue',
        value: minutes(data.minutes.typical),
        sub: data.minutes.longest != null ? `typical · longest ${minutes(data.minutes.longest)}` : 'nothing issued yet',
      }),
      statTile({ label: 'Issued', value: fmtMoney(data.value, { compact: true }), sub: 'at the last price paid' }),
      statTile({
        label: 'Needs a look',
        value: fmtNum(data.attention.length, 0),
        sub: data.attention.length ? 'see below' : 'nothing',
        accent: data.attention.length ? 'var(--bad)' : null,
      }),
    ),

    h('div.grid.grid-2',
      card('Needs your attention', {},
        data.attention.length
          ? h('div', data.attention.map((a) => h(`div.alert.${levelClass[a.level] || 'info'}`,
            h('div.alert-icon', a.level === 'high' ? '⛔' : a.level === 'warn' ? '⚠️' : 'ℹ️'),
            h('div', h('div.alert-title', a.title), h('div.alert-detail', a.detail)))))
          : h('p.muted', 'Nothing. Every request was issued, and everything issued was confirmed as it was sent.'),
        data.low.length
          ? h('div', { style: { marginTop: '.6rem' } },
            h('div.stat-label', { style: { marginBottom: '.3rem' } }, 'Running low in the storeroom'),
            h('div', { style: { fontSize: '.88rem' } }, data.low.map((i) => (i.stock <= 0
              ? `${i.name}: none left`
              : `${i.name}: ${fmtNum(i.stock, 2)} ${i.unit}`)).join(' · ')))
          : null,
      ),
      card('Issued, by value', { note: `${data.currency}, at the last price paid` },
        data.byItem.length
          ? h('div', { style: { display: 'grid', gap: '.5rem' } }, data.byItem.slice(0, 12).map((i) => h('div', {
            style: { display: 'grid', gridTemplateColumns: 'minmax(0, 9rem) minmax(0, 1fr) auto', gap: '.6rem', alignItems: 'center' },
          },
            h('div', { style: { lineHeight: 1.25 } },
              h('div', { style: { fontWeight: 600 } }, i.name),
              h('small.muted', `${fmtNum(i.qty, 2)} ${i.unit}${i.kind === 'supply' ? ' · supply' : ''}`)),
            h('div.bar-track', h('div.bar-fill', { style: { width: `${top ? Math.round((i.value / top) * 100) : 0}%` } })),
            h('b', { style: { fontVariantNumeric: 'tabular-nums' } }, fmtMoney(i.value, { withSymbol: false })))))
          : h('p.muted', 'Nothing issued in this period.'),
        data.byDepartment.length
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '1rem', marginTop: '.8rem', paddingTop: '.6rem', borderTop: '1px solid var(--border)', fontSize: '.88rem' } },
            data.byDepartment.map((d) => h('span', h('span.muted', `${d.name}${d.name === data.kitchen ? ' (breakfast)' : ''} `),
              h('b', fmtMoney(d.value, { withSymbol: false })))))
          : null,
      ),
    ),

    card('All requests', { wide: true, note: 'Newest first' },
      data.requests.length
        ? table([
          { key: 'ref', label: 'Request', format: (v) => h('b', v) },
          { key: 'createdAt', label: 'Asked', format: (v) => timeOf(v) },
          { key: 'department', label: 'From', format: (v, r) => `${v} · ${r.requestedBy}` },
          { key: 'lines', label: 'Items', align: 'right', format: (v) => v.length },
          { key: 'status', label: 'Status', format: (_, r) => statusPill(r) },
          { key: 'issuedBy', label: 'Issued by', format: (v) => v || h('span.muted', '—') },
          { key: 'minutesToIssue', label: 'Time to issue', align: 'right', format: (v) => minutes(v) },
          { key: 'value', label: 'Value', align: 'right', format: (v) => (v == null ? h('span.muted', '—') : fmtMoney(v, { withSymbol: false })) },
        ], data.requests, { sortable: true })
        : emptyState('No requests in this period', 'Requests the departments send appear here.'),
    ),
  );
  return host;
}
