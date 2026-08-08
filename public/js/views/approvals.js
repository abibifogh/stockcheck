import { api } from '../api.js';
import { navigate } from '../app.js';
import { fmtDay, fmtNum, h, mount, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * Changes waiting to be accepted.
 *
 * A cook who corrects a day already submitted does not overwrite it — the
 * proposal lands here, showing exactly what would change, and somebody decides.
 */
export async function renderApprovals(params) {
  const status = params.status || 'pending';
  const data = await api.revisions(status);
  const host = h('div');
  const reload = async () => mount(host, await renderApprovals({ status }));

  const tabs = h('div.seg',
    ...['pending', 'approved', 'rejected', 'all'].map((key) => h('button', {
      class: key === status ? 'active' : '',
      onclick: () => navigate('approvals', { status: key }),
    }, key[0].toUpperCase() + key.slice(1))),
  );

  const cards = data.revisions.length
    ? data.revisions.map((rev) => revisionCard(rev, reload))
    : [h('div.card.empty',
      h('h3', status === 'pending' ? 'Nothing waiting' : 'Nothing here'),
      h('p', status === 'pending'
        ? 'Every submitted day is as the kitchen recorded it.'
        : 'No change requests with that status.'))];

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Approvals'),
        h('div.sub', 'Corrections to days that were already submitted'),
      ),
      tabs,
    ),
    ...cards,
  );
  return host;
}

const STATUS_PILL = {
  pending: ['warn', 'Waiting'],
  approved: ['good', 'Accepted'],
  rejected: ['bad', 'Rejected'],
  superseded: ['', 'Replaced by a newer one'],
};

function revisionCard(rev, reload) {
  const [cls, label] = STATUS_PILL[rev.status] ?? ['', rev.status];

  const decide = async (approve, event) => {
    const verb = approve ? 'Accept' : 'Reject';
    const note = window.prompt(
      `${verb} the changes to ${fmtDay(rev.day)}?\n\n`
      + (approve
        ? 'The recorded figures will be replaced with the proposed ones.'
        : 'The recorded figures will stay exactly as they are.')
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
      rev.status === 'pending' ? h('button.btn-sm.btn-danger', { onclick: (e) => decide(false, e) }, 'Reject') : null,
      rev.status === 'pending' ? h('button.btn-sm.btn-primary', { onclick: (e) => decide(true, e) }, 'Accept') : null,
    ),
  },
    rev.changes.length
      ? table([
        {
          key: 'label',
          label: 'What changes',
          format: (v, r) => h('div',
            h('div', v),
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
      ], rev.changes)
      : h('p.muted', 'Nothing actually differs from what is already recorded.'),

    rev.reviewNote
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem' } },
        `Note from ${rev.reviewedBy ?? 'the reviewer'}: ${rev.reviewNote}`)
      : null,

    rev.status === 'pending'
      ? h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
        'Until this is accepted, every report still uses the figures in the “Recorded now” column.')
      : null,
  );
}
