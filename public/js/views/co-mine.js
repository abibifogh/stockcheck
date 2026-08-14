import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import { mySignatureCard } from './co-envelope.js';
import {
  ACTION_LABEL, TYPE_LABEL, act, co, dialogActions, dueCell, field,
  modal, personOptions, priorityPill, select,
} from './co-common.js';

/**
 * My desk: everything waiting on this person, in the order it will bite them.
 *
 * The first screen anybody opens and, for most of the firm, the only one. So it
 * answers one question — what do I have to do — and answers it above the fold,
 * sorted by deadline, with the action buttons on the row rather than behind a
 * click into the letter.
 *
 * Four lists, in descending order of "is this mine":
 *   with me         routes addressed to me by name
 *   unclaimed       routes sent to my department or to anyone who can approve
 *   covering for    somebody away whose work I am seeing while they are out
 *   action points   tasks assigned to me, from meetings or raised by hand
 */
export async function renderCoMine() {
  const [data, boot, signature] = await Promise.all([
    api.coMine(),
    co(),
    api.coMySignature().catch(() => ({})),
  ]);
  const host = h('div');
  const reload = async () => mount(host, await renderCoMine());

  const overdue = data.routes.filter((r) => r.due_at && new Date(r.due_at) < new Date()).length;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My desk'),
        h('div.sub', data.routes.length
          ? `${data.routes.length} item${data.routes.length === 1 ? '' : 's'} with you`
            + (overdue ? `, ${overdue} past its deadline` : '')
          : 'Nothing is waiting on you'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('co-register') }, 'The register'),
      ),
    ),

    card('With me', { wide: true, note: 'Sent to you by name' },
      data.routes.length
        ? routeTable(data.routes, reload, boot, { mine: true })
        : h('div.empty', h('p', 'Nothing is with you. Either the firm is quiet or you are on top of it.'))),

    data.claimable.length
      ? card('Nobody has picked these up', {
        wide: true,
        note: 'Sent to your department, or to anyone who can approve. Acting on one makes it yours.',
      }, routeTable(data.claimable, reload, boot, { claimable: true }))
      : null,

    data.covering.length
      ? card('While they are away', {
        wide: true,
        note: 'You are covering for these people. The work stays theirs — you can see it and act on it.',
      }, routeTable(data.covering, reload, boot, { covering: true }))
      : null,

    card('My action points', {
      wide: true,
      actions: h('button.btn-sm', { onclick: () => navigate('co-tasks') }, 'All action points'),
    }, data.tasks.length
      ? table([
        { key: 'title', label: 'What', format: (v, r) => h('div', h('div', v), r.detail ? h('small.muted', r.detail) : null) },
        { key: 'priority', label: '', format: (v) => priorityPill(v) ?? '' },
        { key: 'due_at', label: 'Due', format: (v) => dueCell(v) },
        {
          key: 'id',
          label: '',
          align: 'right',
          format: (id) => h('button.btn-sm.btn-primary', {
            onclick: () => act(api.coUpdateTask(id, { status: 'done' }), 'Done', reload),
          }, 'Done'),
        },
      ], data.tasks)
      : h('div.empty', h('p', 'No action points assigned to you.'))),

    // Yours rather than the firm's, and nobody would ever go looking for it
    // under Practice setup.
    mySignatureCard(signature, reload),
  );

  return host;
}

function routeTable(routes, reload, boot, { mine = false, claimable = false, covering = false }) {
  return table([
    {
      key: 'ref',
      label: 'Reference',
      format: (ref, r) => h('a', {
        href: `#/co-letter?id=${r.letter_id}`,
        style: { fontWeight: '600' },
      }, ref),
    },
    {
      key: 'subject',
      label: 'Subject',
      format: (subject, r) => h('div',
        h('div', subject),
        h('small.muted',
          `${TYPE_LABEL[r.type] ?? r.type}`,
          r.party_name ? ` · ${r.party_name}` : '',
          covering && r.owner_name ? ` · ${r.owner_name}'s` : '',
        ),
      ),
    },
    {
      key: 'action',
      label: 'Asked for',
      format: (action, r) => h('div',
        h('div', ACTION_LABEL[action] ?? action),
        r.instruction ? h('small.muted', r.instruction) : null,
      ),
    },
    { key: 'priority', label: '', format: (v) => priorityPill(v) ?? '' },
    { key: 'due_at', label: 'Due', format: (v) => dueCell(v) },
    {
      key: 'id',
      label: '',
      align: 'right',
      format: (id, r) => h('div.btn-row', { style: { justifyContent: 'flex-end' } },
        // Acknowledging is the cheap, honest signal: "I have seen this and it
        // is mine." It stops the escalation clock being the only thing that
        // ever tells a sender anything.
        mine && r.status === 'pending'
          ? h('button.btn-sm', {
            onclick: () => act(api.coActOnRoute(id, { act: 'acknowledge' }), 'Acknowledged', reload),
          }, 'Seen')
          : null,
        claimable
          ? h('button.btn-sm', {
            onclick: () => act(api.coActOnRoute(id, { act: 'acknowledge' }), 'It is yours now', reload),
          }, 'Take it')
          : null,
        h('button.btn-sm.btn-primary', {
          onclick: () => openComplete(r, reload, boot),
        }, r.action === 'approve' || r.action === 'sign' ? 'Decide' : 'Complete'),
      ),
    },
  ], routes, {
    rowClass: (r) => (r.due_at && new Date(r.due_at) < new Date() ? 'row-flag-high' : ''),
    empty: 'Nothing here.',
  });
}

/**
 * The one dialog that closes a route.
 *
 * An approval must say which way it went and a rejection must say why —
 * enforced on the server as well, because a rejection with no reason is a
 * letter that comes back with nothing anybody can act on.
 */
function openComplete(route, reload, boot) {
  const decides = route.action === 'approve' || route.action === 'sign';
  const comment = h('textarea', {
    rows: 4,
    placeholder: decides
      ? 'What you decided, and why. Required if you reject.'
      : 'What you did about it. Optional, but this is what the file will say.',
  });

  let decision = 'approved';
  const choice = h('div.seg',
    ...[['approved', 'Approve'], ['rejected', 'Reject']].map(([value, label]) => {
      const button = h('button', {
        class: value === 'approved' ? 'active' : '',
        onclick: () => {
          decision = value;
          [...choice.children].forEach((c) => c.classList.toggle('active', c === button));
        },
      }, label);
      return button;
    }),
  );

  const dialog = modal(
    `${route.ref} — ${ACTION_LABEL[route.action] ?? route.action}`,
    {},
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } }, route.subject),
    route.instruction
      ? h('div.alert.info', h('span.alert-icon', 'ℹ️'),
        h('div', h('div.alert-title', 'What you were asked'), h('div.alert-detail', route.instruction)))
      : null,
    decides ? field('Decision', choice) : null,
    field(decides ? 'Reason' : 'Note for the file', comment),

    route.action === 'sign'
      ? h('p.muted', { style: { fontSize: '.82rem' } },
        'Deciding here records your approval. To place your signature on the document itself, '
        + 'open the letter and use Sign — that seals the text and attachments as they stand.')
      : null,
  );

  const actions = dialogActions(dialog, decides ? 'Record decision' : 'Complete', async () => {
    await api.coActOnRoute(route.id, {
      act: 'complete',
      decision: decides ? decision : undefined,
      comment: comment.value.trim() || undefined,
    });
    toast('Recorded', 'good');
    await reload();
  });

  // The other two things somebody does when a letter lands on them: send it
  // back to whoever routed it, or pass it to the person it should have gone to.
  // Both belong on the same dialog, because at the moment of reading it nobody
  // knows yet which of the three they are about to do.
  actions.querySelector('.btn-row').prepend(
    h('button.btn-sm', {
      style: { marginRight: 'auto' },
      onclick: () => { dialog.close(); openForward(route, reload, boot); },
    }, 'Pass it on'),
    h('button.btn-sm', {
      onclick: async () => {
        if (!comment.value.trim()) {
          toast('Say why you are sending it back', 'bad');
          return;
        }
        await act(api.coActOnRoute(route.id, { act: 'return', comment: comment.value.trim() }),
          'Sent back', reload);
        dialog.close();
      },
    }, 'Send back'),
  );

  dialog.append(actions);
}

function openForward(route, reload, boot) {
  const person = select(personOptions(boot.staff), {});
  const department = select(
    [{ value: '', label: '— or a department —' }, ...boot.departments.map((d) => ({ value: d.id, label: d.name }))],
    {},
  );
  const asked = select(
    Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
    { value: 'action' },
  );
  const note = h('textarea', { rows: 3, placeholder: 'What you want them to do with it' });

  const dialog = modal(`Pass on ${route.ref}`, {},
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } }, route.subject),
    field('To', person),
    field('', department),
    field('Asking them for', asked),
    field('Note', note),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'This stays with you as well until you complete it. Passing something on is not the same as '
      + 'being finished with it, and a letter that could be discharged by forwarding would go round '
      + 'the firm until everybody thought somebody else had it.'),
  );

  dialog.append(dialogActions(dialog, 'Pass it on', async () => {
    await api.coActOnRoute(route.id, {
      act: 'forward',
      toUserId: person.value || undefined,
      toDepartmentId: department.value || undefined,
      action: asked.value,
      comment: note.value.trim() || undefined,
    });
    toast('Passed on', 'good');
    await reload();
  }));
}
