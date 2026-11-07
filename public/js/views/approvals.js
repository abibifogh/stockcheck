import { api } from '../api.js';
import { can, navigate } from '../app.js';
import { fmtDay, fmtMoney, fmtNum, h, mount, toast } from '../util.js';
import { card, emptyState, pageTabs, table } from './components.js';
import { timeOf } from './store-common.js';

/**
 * Things waiting for somebody to say yes or no.
 *
 * Two kinds, each in its own tab: what a department has asked the storeroom
 * for (a manager approves it before it is issued), and corrections to days
 * already submitted (a cook who corrects a day does not overwrite it — the
 * proposal lands here, showing exactly what would change).
 */
export async function renderApprovals(params) {
  const host = h('div');
  const reload = async () => mount(host, await renderApprovals(params));
  const [store, revisions] = await Promise.all([
    can('store_approve') ? api.storeRequests('approve').catch(() => null) : null,
    can('approvals') ? api.revisions(params.status || 'pending') : null,
  ]);

  // Choosing a status in the corrections tab reloads the page with ?status=,
  // and should land back on that tab.
  if (params.status) {
    try { sessionStorage.setItem('bf.tab.approvals', 'days'); } catch { /* private mode */ }
  }

  const tabs = [
    store ? {
      id: 'store',
      label: 'Storeroom requests',
      count: store.waiting.length || null,
      render: () => storeApprovals(store, reload),
    } : null,
    revisions ? {
      id: 'days',
      label: 'Day corrections',
      count: (params.status || 'pending') === 'pending' ? (revisions.revisions.length || null) : null,
      render: () => dayCorrections(revisions, params.status || 'pending', reload),
    } : null,
  ].filter(Boolean);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Approvals'),
        h('div.sub', 'What is waiting for a yes or a no'),
      ),
    ),
    tabs.length > 1 ? pageTabs('approvals', tabs) : (tabs[0] ? await tabs[0].render() : null),
  );
  return host;
}

// ---------------------------------------------------- storeroom requests --

/**
 * What departments have asked the storeroom for, most urgent first. Each shows
 * what is on the shelf beside what was asked, which is most of the decision.
 */
async function storeApprovals(store, reload) {
  if (!store.approval) {
    return card(null, {},
      h('p.muted', { style: { margin: 0 } },
        'Requests go straight to the storeroom here. To have a manager approve them first, switch '
        + 'approvals on under Setup → Storeroom.'));
  }
  if (!store.waiting.length) {
    return emptyState('Nothing waiting', 'New requests appear here, and on your phone if alerts are on.');
  }

  const stock = await api.storeStock().catch(() => null);
  const onShelf = new Map((stock?.items ?? []).map((i) => [i.id, i]));

  const act = async (event, work, done) => {
    const buttons = event.target.closest('.btn-row')?.querySelectorAll('button') ?? [event.target];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      await work();
      toast(done, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      buttons.forEach((b) => { b.disabled = false; });
    }
  };

  const approveAll = store.waiting.length > 1
    ? h('div.btn-row', { style: { justifyContent: 'flex-end', marginBottom: '.8rem' } },
      h('button.btn-primary', {
        onclick: (event) => {
          if (!window.confirm(`Approve all ${store.waiting.length} requests?`)) return;
          act(event, async () => {
            for (const r of store.waiting) await api.approveStoreRequest(r.id); // eslint-disable-line no-await-in-loop
          }, `${store.waiting.length} requests approved`);
        },
      }, `Approve all ${store.waiting.length}`))
    : null;

  return h('div',
    approveAll,
    h('div', { style: { display: 'grid', gap: '.8rem' } }, store.waiting.map((r) => {
      const urgent = r.needed === 'now';
      return card(`${r.department}`, {
        note: [r.ref, r.requestedBy, timeOf(r.createdAt), r.follows ? `rest of ${r.follows}` : null].filter(Boolean).join(' · '),
        actions: h(`span.pill${urgent ? '.bad' : ''}`, `Needed ${r.neededText.toLowerCase()}`),
      },
        table([
          { key: 'name', label: 'Item' },
          { key: 'asked', label: 'Asked for', align: 'right', format: (v, l) => h('b', `${fmtNum(v, 2)} ${l.unit}`) },
          stock ? {
            key: 'ingredientId',
            label: 'In the storeroom',
            align: 'right',
            format: (id, l) => {
              const item = onShelf.get(id);
              if (!item) return h('span.muted', '—');
              const short = item.stock < l.asked;
              return h(short ? 'span.pill.warn' : 'span', `${fmtNum(item.stock, 2)} ${l.unit}`);
            },
          } : null,
          stock ? {
            key: 'id',
            label: 'Worth',
            align: 'right',
            cls: 'phone-hide',
            format: (_, l) => {
              const cost = onShelf.get(l.ingredientId)?.unitCost;
              return cost == null ? h('span.muted', '—') : fmtMoney(cost * l.asked, { withSymbol: false });
            },
          } : null,
        ].filter(Boolean), r.lines),
        r.note ? h('p.muted', { style: { fontStyle: 'italic', fontSize: '.88rem', margin: '.6rem 0 0' } }, `“${r.note}”`) : null,
        h('div.btn-row', { style: { justifyContent: 'flex-end', marginTop: '.9rem' } },
          h('button.btn-danger', {
            onclick: (event) => {
              const reason = window.prompt(`Decline ${r.ref}? Say why, for ${r.requestedBy}:`, '');
              if (reason === null) return;
              if (!reason.trim()) { toast('Give a reason, so they know what to do instead', 'bad'); return; }
              act(event, () => api.declineStoreRequest(r.id, { note: reason.trim() }), `${r.ref} declined`);
            },
          }, 'Decline'),
          h('button.btn-primary', {
            onclick: (event) => act(event, () => api.approveStoreRequest(r.id), `${r.ref} approved: the storeroom has it`),
          }, 'Approve')),
      );
    })),
  );
}

// ------------------------------------------------------- day corrections --

function dayCorrections(data, status, reload) {
  const tabs = h('div.seg', { style: { marginBottom: '1rem' } },
    ...['pending', 'approved', 'rejected', 'all'].map((key) => h('button', {
      class: key === status ? 'active' : '',
      onclick: () => navigate('approvals', { status: key }),
    }, key === 'pending' ? 'Waiting' : key[0].toUpperCase() + key.slice(1))));

  const cards = data.revisions.length
    ? data.revisions.map((rev) => revisionCard(rev, reload))
    : [h('div.card.empty',
      h('h3', status === 'pending' ? 'Nothing waiting' : 'Nothing here'),
      h('p', status === 'pending'
        ? 'Every submitted day is as the kitchen recorded it.'
        : 'No change requests with that status.'))];

  return h('div', tabs, ...cards);
}

const STATUS_PILL = {
  pending: ['warn', 'Waiting'],
  approved: ['good', 'Accepted'],
  rejected: ['bad', 'Rejected'],
  superseded: ['', 'Replaced by a newer one'],
};

function revisionCard(rev, reload) {
  const [cls, label] = STATUS_PILL[rev.status] ?? ['', rev.status];

  const reopening = rev.status === 'rejected';

  const decide = async (approve, event) => {
    const verb = approve ? 'Accept' : 'Reject';
    const note = window.prompt(
      `${verb} the changes to ${fmtDay(rev.day)}?\n\n`
      + (reopening && approve
        ? `This was rejected${rev.reviewedBy ? ` by ${rev.reviewedBy}` : ''}. Accepting it now applies it.\n`
        : '')
      + (approve
        ? 'The recorded figures will be replaced with the proposed ones.'
        : 'The recorded figures will stay exactly as they are.')
      + (reopening && approve && rev.stale
        ? '\n\nThe day has changed since this was proposed. The comparison below is '
          + 'against what was recorded then, not now.'
        : '')
      + '\n\nAdd a note (optional):',
      '',
    );
    if (note === null) return;

    event.target.disabled = true;
    try {
      await api.reviewRevision(rev.id, { approve, note });
      toast(approve ? 'Changes accepted' : 'Changes rejected', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const fmtValue = (value, unit) => {
    if (value == null) return h('span.muted', 'not recorded');
    if (typeof value === 'string') return value || h('span.muted', '—');
    return `${fmtNum(value, 2)}${unit ? ` ${unit}` : ''}`;
  };

  return card(fmtDay(rev.day, { withYear: true }), {
    note: `Proposed by ${rev.submittedBy ?? 'unknown'} on ${String(rev.submittedAt).slice(0, 16).replace('T', ' ')}`,
    wide: true,
    actions: h('div.btn-row',
      h(`span.pill${cls ? `.${cls}` : ''}`, label),
      // A rejection is a decision for now, not a verdict for ever. Where a newer
      // proposal is waiting on the same day, that one is the live question and
      // this one offers nothing.
      rev.status === 'pending' ? h('button.btn-sm.btn-danger', { onclick: (e) => decide(false, e) }, 'Reject') : null,
      rev.status === 'pending' || (reopening && !rev.supersededByOpen)
        ? h('button.btn-sm.btn-primary', { onclick: (e) => decide(true, e) },
          reopening ? 'Accept after all' : 'Accept')
        : null,
    ),
  },
    headline(rev.summary),

    rev.changes.length
      ? table([
        {
          key: 'label',
          label: 'What changes',
          cls: 'wrap',
          format: (v, r) => h('div',
            h('div', v,
              // An item appearing or disappearing is a different claim from a
              // figure moving, and the numbers alone do not say which it is.
              r.change === 'added' ? h('span.pill.good', { style: { marginLeft: '.4rem' } }, 'added') : null,
              r.change === 'removed' ? h('span.pill.bad', { style: { marginLeft: '.4rem' } }, 'removed') : null),
            h('small.muted', r.kind === 'usage' ? 'quantity used' : r.kind === 'guests' ? 'headcount' : 'note'),
          ),
        },
        { key: 'before', label: 'Recorded now', align: 'right', format: (v, r) => fmtValue(v, r.unit) },
        { key: 'after', label: 'Proposed', align: 'right', format: (v, r) => h('b', fmtValue(v, r.unit)) },
        {
          key: 'delta',
          label: 'Difference',
          align: 'right',
          format: (v) => (v == null
            ? h('span.muted', '—')
            : h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`, `${v > 0 ? '+' : ''}${fmtNum(v, 2)}`)),
        },
        {
          key: 'costDelta',
          label: 'Cost effect',
          align: 'right',
          format: (v) => (v == null
            ? h('span.muted', '—')
            : h(`span.delta.${v > 0 ? 'up' : v < 0 ? 'down' : 'flat'}`,
              `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtMoney(Math.abs(v), { withSymbol: false })}`)),
        },
      ], rev.changes, { sortable: true })
      : h('p.muted', 'Nothing actually differs from what is already recorded.'),

    rev.reviewNote
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem' } },
        `Note from ${rev.reviewedBy ?? 'the reviewer'}: ${rev.reviewNote}`)
      : null,

    rev.status === 'pending'
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        'Until this is accepted, every report still uses the figures in the “Recorded now” column.')
      : null,

    reopening && rev.supersededByOpen
      ? h('div.alert.info', { style: { marginTop: '.7rem' } },
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'A newer change for this day is waiting'),
          h('div.alert-detail',
            'Answer that one instead. Accepting both would apply two sheets to one day, in an '
            + 'order nobody chose.'),
        ))
      : null,

    reopening && rev.stale && !rev.supersededByOpen
      ? h('div.alert.warn', { style: { marginTop: '.7rem' } },
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'The day has changed since this was proposed'),
          h('div.alert-detail',
            'The “Recorded now” column shows what was there when this was written, not what is '
            + 'there today. Accepting replaces the day with the proposed figures either way — '
            + 'check the day itself first if the difference matters.'),
        ))
      : null,

    reopening && !rev.stale && !rev.supersededByOpen
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        'This was rejected, and can still be accepted. The day has not moved since it was '
        + 'proposed, so the comparison above is current.')
      : null,
  );
}

/**
 * The one line an approver reads before deciding.
 *
 * A table of before-and-after says what moved and leaves the reviewer to add
 * it up. Whether accepting this makes the day cost more or less, and whether
 * anything appeared or disappeared, are the two facts the decision turns on —
 * so they are stated rather than derivable.
 */
function headline(summary) {
  if (!summary) return null;

  const bits = [];
  if (summary.changed) bits.push(`${summary.changed} ${summary.changed === 1 ? 'figure' : 'figures'} changed`);
  if (summary.added) bits.push(`${summary.added} added`);
  if (summary.removed) bits.push(`${summary.removed} removed`);
  if (summary.guestDelta) {
    bits.push(`${summary.guestDelta > 0 ? '+' : '−'}${Math.abs(summary.guestDelta)} guests`);
  }
  if (summary.noteChanged) bits.push('note reworded');
  if (!bits.length) return null;

  const cost = summary.costDelta;
  const money = cost == null || cost === 0
    ? null
    : `${cost > 0 ? 'Raises' : 'Lowers'} the day by ${fmtMoney(Math.abs(cost))}`;

  return h(`div.alert.${cost > 0 ? 'warn' : 'info'}`, { style: { marginBottom: '.8rem' } },
    h('span.alert-icon', cost > 0 ? '↑' : cost < 0 ? '↓' : '≡'),
    h('div',
      h('div.alert-title', money ?? 'No effect on what the day cost'),
      h('div.alert-detail', bits.join(' · '),
        cost != null
          ? h('span.muted', { style: { display: 'block', marginTop: '.2rem', fontSize: '.82rem' } },
            'Cost worked out at the last price paid for each item, so treat it as a guide to the '
            + 'size of the change rather than as the figure the reports will show.')
          : null),
    ),
  );
}
