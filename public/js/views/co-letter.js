import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import {
  ACTION_LABEL, STATUS_LABEL, TYPE_LABEL, act, co, confidentialityPill,
  dialogActions, dueCell, field, fmtDate, fmtWhen, inHours, modal,
  personOptions, priorityPill, select, statusPill, toStamp,
} from './co-common.js';
import { openCompose } from './co-compose.js';

/**
 * One letter, and everything that has happened to it.
 *
 * The page reads top to bottom in the order somebody actually needs it: what it
 * is, who has it now, what it says, what is attached, who signed it, and — last
 * — the full trail, which matters enormously and is consulted rarely.
 */
export async function renderCoLetter(params) {
  const id = Number(params.id);
  if (!id) return h('div.card.empty', h('h3', 'No letter chosen'), h('p', 'Open one from the register.'));

  const [data, boot] = await Promise.all([api.coLetter(id), co()]);
  const letter = data.letter;
  const host = h('div');
  const reload = async () => mount(host, await renderCoLetter(params));
  const may = (p) => boot.permissions.includes(p);

  const settled = ['closed', 'cancelled'].includes(letter.status);
  const openRoutes = data.routes.filter((r) => ['pending', 'acknowledged'].includes(r.status));
  const blocking = openRoutes.filter((r) => ['approve', 'sign'].includes(r.action));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', letter.ref),
        h('div.sub', letter.subject),
        h('div.btn-row', { style: { marginTop: '.4rem' } },
          h('span.pill', TYPE_LABEL[letter.type] ?? letter.type),
          statusPill(letter.status),
          priorityPill(letter.priority),
          confidentialityPill(letter.confidentiality),
          letter.sealed ? h('span.pill.good', '🔏 Sealed') : null,
          letter.archived ? h('span.pill', 'Archived') : null,
        ),
      ),
      h('div.btn-row',
        h('button.btn-sm', { onclick: () => navigate('co-register') }, '← Register'),
        may('co_register') && letter.canEdit
          ? h('button.btn-sm', { onclick: () => openEdit(letter, boot, reload) }, 'Edit')
          : null,
        may('co_route') && !settled
          ? h('button.btn-sm.btn-primary', { onclick: () => openRoute(letter, boot, reload) }, 'Send to…')
          : null,
      ),
    ),

    blocking.length && !settled
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', `Waiting on ${blocking.length} ${blocking.length === 1 ? 'decision' : 'decisions'}`),
          h('div.alert-detail',
            `${blocking.map((r) => `${r.to_name} (${ACTION_LABEL[r.action].toLowerCase()})`).join(', ')}. `
            + 'This cannot be marked as sent until those are cleared.'),
        ))
      : null,

    data.signatures.length && !data.signaturesValid
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'This document does not match what was signed'),
          h('div.alert-detail',
            'Either the text or an attachment has changed since a signature was placed on it. '
            + 'Open Verify below for the detail.'),
        ))
      : null,

    h('div.grid.grid-2',
      detailsCard(letter, data),
      routesCard(data, letter, boot, reload, may),
    ),

    card('The letter', { wide: true },
      letter.body
        ? h('pre', {
          style: {
            whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0,
            lineHeight: '1.6', fontSize: '.94rem',
          },
        }, letter.body)
        : h('p.muted', 'No text recorded — the letter itself is probably an attachment below.')),

    attachmentsCard(letter, data, reload, may),
    signaturesCard(letter, data, reload, may),

    data.links.length
      ? card('Related correspondence', { wide: true }, table([
        { key: 'ref', label: 'Reference', format: (ref, r) => h('a', { href: `#/co-letter?id=${r.id}` }, ref) },
        { key: 'subject', label: 'Subject' },
        {
          key: 'kind',
          label: 'How',
          format: (kind) => ({
            reply_to: 'This is a reply to it', follow_up: 'Replied to by it', related: 'Related',
          }[kind] ?? kind),
        },
        { key: 'status', label: 'Status', format: (s) => statusPill(s) },
      ], data.links))
      : null,

    trailCard(data, letter, may),
    statusCard(letter, settled, blocking, reload, may),
  );

  return host;
}

// ---------------------------------------------------------------------------

function detailsCard(letter, data) {
  const row = (label, value) => (value == null || value === ''
    ? null
    : h('div', { style: { display: 'flex', gap: '.6rem', padding: '.3rem 0' } },
      h('span.muted', { style: { minWidth: '150px', fontSize: '.85rem' } }, label),
      h('span', value),
    ));

  return card('Details', {},
    row('Client / party', data.party
      ? h('span', data.party.name, data.party.tin ? h('small.muted', ` · TIN ${data.party.tin}`) : null)
      : null),
    row('Engagement', data.case ? h('a', { href: `#/co-case?id=${data.case.id}` }, `${data.case.ref} · ${data.case.title}`) : null),
    row('Category', data.category?.name),
    row('Department', data.department?.name),
    row('Their reference', letter.their_ref),
    row('Date on the letter', letter.letter_date ? fmtDate(letter.letter_date) : null),
    row('Received', letter.received_at ? fmtWhen(letter.received_at) : null),
    row('Sent', letter.dispatched_at ? fmtWhen(letter.dispatched_at) : null),
    row('Channel', letter.channel),
    row('Deadline', dueCell(letter.due_at, { settled: ['closed', 'cancelled'].includes(letter.status) })),
    row('Registered', `${fmtWhen(letter.created_at)} by ${letter.created_by_name ?? 'unknown'}`),
    row('Closed', letter.closed_at ? `${fmtWhen(letter.closed_at)} by ${letter.closed_by ?? 'unknown'}` : null),
    row('Workflow', data.workflow
      ? h('span', data.workflow.workflow_name,
        h('small.muted', ` · step ${data.workflow.step_seq}, ${data.workflow.status}`))
      : null),
    letter.recipients?.length
      ? row('Addressed to', letter.recipients
        .map((r) => `${r.party_name ?? r.name ?? r.email}${r.kind !== 'to' ? ` (${r.kind})` : ''}`)
        .join(', '))
      : null,
    row('Retention', data.category?.retention_years ? `${data.category.retention_years} years` : null),
  );
}

function routesCard(data, letter, boot, reload, may) {
  return card('Who has it', {
    note: data.routes.length ? null : 'Nobody yet',
  }, data.routes.length
    ? table([
      {
        key: 'to_name',
        label: 'With',
        format: (name, r) => h('div',
          h('div', r.to_user_name ?? name ?? 'Unassigned'),
          h('small.muted', ACTION_LABEL[r.action] ?? r.action,
            r.from_name ? ` · from ${r.from_name}` : ''),
        ),
      },
      {
        key: 'status',
        label: '',
        format: (status, r) => h('div',
          h(`span.pill${ROUTE_PILL[status] ? `.${ROUTE_PILL[status]}` : ''}`,
            ROUTE_LABEL[status] ?? status),
          r.decision ? h('div', h('small.muted', r.decision)) : null,
          r.escalated_at ? h('div', h('small.muted', `escalated ${fmtWhen(r.escalated_at)}`)) : null,
        ),
      },
      {
        key: 'due_at',
        label: 'Due',
        format: (due, r) => dueCell(due, { settled: !['pending', 'acknowledged'].includes(r.status) }),
      },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => (['pending', 'acknowledged'].includes(r.status) && may('co_route')
          ? h('button.btn-sm.btn-ghost', {
            title: 'Withdraw this — it should not have been sent',
            onclick: () => act(api.coCancelRoute(id), 'Withdrawn', reload),
          }, '✕')
          : ''),
      },
    ], data.routes, {
      empty: 'Not sent to anybody yet.',
    })
    : h('div.empty',
      h('p', 'This has not been sent to anybody.'),
      may('co_route')
        ? h('button.btn-sm.btn-primary', { onclick: () => openRoute(letter, boot, reload) }, 'Send it to somebody')
        : null),
  );
}

const ROUTE_PILL = {
  pending: 'warn', acknowledged: 'info', completed: 'good',
  returned: 'bad', cancelled: '', forwarded: 'info',
};
const ROUTE_LABEL = {
  pending: 'Waiting', acknowledged: 'Seen', completed: 'Done',
  returned: 'Sent back', cancelled: 'Withdrawn', forwarded: 'Passed on',
};

function attachmentsCard(letter, data, reload, may) {
  const input = h('input', {
    type: 'file',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append('file', file);
      form.append('letterId', String(letter.id));
      await act(api.coUploadAttachment(form), `${file.name} attached`, reload).catch(() => {});
      e.target.value = '';
    },
  });

  return card('Attachments', {
    wide: true,
    note: letter.sealed ? 'Sealed — attachments are part of what was signed' : null,
    actions: may('co_register') && !letter.sealed
      ? h('div.btn-row',
        input,
        h('button.btn-sm', { onclick: () => input.click() }, '+ Attach a file'))
      : null,
  }, data.attachments.length
    ? table([
      {
        key: 'name',
        label: 'File',
        format: (name, r) => h('a', {
          href: api.coAttachmentUrl(r.id),
          target: '_blank',
          rel: 'noopener',
        }, name),
      },
      { key: 'mime', label: 'Kind', format: (v) => h('span.muted', v ?? '—') },
      { key: 'size', label: 'Size', align: 'right', format: (v) => fmtBytes(v) },
      {
        key: 'sha256',
        label: 'Fingerprint',
        format: (v) => (v
          ? h('code.mono', { title: v, style: { fontSize: '.75rem' } }, v.slice(0, 12))
          : h('span.muted', '—')),
      },
      { key: 'uploaded_by', label: 'By', format: (v, r) => h('div', h('div', v ?? '—'), h('small.muted', fmtWhen(r.at))) },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => (may('co_register') && !letter.sealed
          ? h('button.btn-sm.btn-ghost', {
            title: 'Remove this file',
            onclick: () => {
              if (!window.confirm(`Remove ${r.name}? The file itself is deleted. The letter records that it was removed, and by whom.`)) return;
              act(api.coDeleteAttachment(id), 'Removed', reload);
            },
          }, '✕')
          : ''),
      },
    ], data.attachments)
    : h('div.empty', h('p', 'Nothing attached.')));
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function signaturesCard(letter, data, reload, may) {
  return card('Signatures', {
    wide: true,
    actions: may('co_approve') && !['closed', 'cancelled'].includes(letter.status)
      ? h('button.btn-sm.btn-primary', { onclick: () => openSign(letter, reload) }, '✍ Sign')
      : null,
  },
    data.signatures.length
      ? h('div',
        table([
          {
            key: 'name',
            label: 'Signed by',
            format: (name, r) => h('div',
              h('div', h('b', name)),
              r.title ? h('small.muted', r.title) : null,
              r.image ? h('div', h('img', { src: r.image, alt: '', style: { maxHeight: '48px', marginTop: '.3rem' } })) : null,
            ),
          },
          { key: 'method', label: 'How', format: (v) => (v === 'drawn' ? 'Drawn' : 'Typed') },
          { key: 'at', label: 'When', format: (v) => fmtWhen(v) },
          {
            key: 'sealValid',
            label: 'Seal',
            format: (ok) => (ok ? h('span.pill.good', 'Intact') : h('span.pill.bad', 'Broken')),
          },
          {
            key: 'documentUnchanged',
            label: 'Document',
            format: (ok) => (ok
              ? h('span.pill.good', 'Unchanged since')
              : h('span.pill.bad', 'Changed since signing')),
          },
        ], data.signatures),
        h('p.muted', { style: { fontSize: '.82rem', marginTop: '.6rem', marginBottom: 0 } },
          'A seal is a keyed digest of the document held against a secret that lives in the server, not '
          + 'the database. “Intact” means nobody has forged or edited the signature. “Unchanged since” '
          + 'means the text and attachments still match what was actually signed.'))
      : h('div.empty',
        h('p', 'Not signed.'),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'Signing seals the subject, the text and every attachment as they stand. '
          + 'After that the letter cannot be edited — a follow-up is registered instead.')));
}

function trailCard(data, letter, may) {
  const verify = h('button.btn-sm', {
    onclick: async (e) => {
      e.target.disabled = true;
      try {
        const result = await api.coVerify(letter.id);
        openVerify(result);
      } catch (err) {
        toast(err.message, 'bad');
      }
      e.target.disabled = false;
    },
  }, 'Verify this record');

  return card('The trail', {
    wide: true,
    note: `${data.events.length} entr${data.events.length === 1 ? 'y' : 'ies'}, newest first`,
    actions: may('co_oversight') || may('co_reports') ? verify : null,
  }, table([
    { key: 'at', label: 'When', format: (v) => h('span.nowrap', fmtWhen(v)) },
    { key: 'actor', label: 'Who' },
    { key: 'action', label: 'What', format: (v) => h('code.mono', { style: { fontSize: '.8rem' } }, v) },
    {
      key: 'detail',
      label: 'Detail',
      format: (detail) => (detail
        ? h('small.muted', Object.entries(detail)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' · '))
        : ''),
    },
  ], data.events, { empty: 'Nothing recorded yet.' }));
}

function statusCard(letter, settled, blocking, reload, may) {
  if (!may('co_register')) return null;

  const button = (status, label, danger = false) => h(`button.btn-sm${danger ? '.btn-danger' : ''}`, {
    disabled: letter.status === status,
    onclick: () => {
      if (status === 'cancelled'
        && !window.confirm('Cancel this? It keeps its reference number and stays in the register — a cancelled entry is part of the record, not a gap in it.')) return;
      act(api.coSetStatus(letter.id, { status }), `Marked ${STATUS_LABEL[status].toLowerCase()}`, reload);
    },
  }, label);

  return card('Move it along', {
    wide: true,
    note: settled ? 'This is finished. Reopen it if it turns out not to be.' : null,
  },
    h('div.btn-row',
      letter.type === 'outgoing' && !settled ? button('dispatched', 'Mark as sent') : null,
      !settled ? button('closed', 'Close it') : null,
      settled ? button('in_progress', 'Reopen') : null,
      !settled ? button('cancelled', 'Cancel', true) : null,
      settled
        ? h('button.btn-sm', {
          onclick: () => act(api.coArchiveLetter(letter.id, !letter.archived),
            letter.archived ? 'Back in the register' : 'Archived', reload),
        }, letter.archived ? 'Un-archive' : 'Archive')
        : null,
      h('button.btn-sm', {
        style: { marginLeft: 'auto' },
        onclick: () => openCompose({ type: 'outgoing', caseId: letter.case_id, replyTo: letter.id }),
      }, 'Register a reply'),
    ),
    blocking.length && !settled
      ? h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Marking this as sent is refused while an approval or signature is outstanding. '
        + 'That is the whole reason those routes exist.')
      : null,
  );
}

// ---------------------------------------------------------------- dialogs --

function openRoute(letter, boot, reload) {
  const person = select(personOptions(boot.staff, { blank: '— a person —' }), {});
  const department = select(
    [{ value: '', label: '— or a department —' },
      ...boot.departments.map((d) => ({ value: d.id, label: d.name }))],
    {},
  );
  const permission = select(
    [{ value: '', label: '— or anyone who can… —' },
      { value: 'co_approve', label: 'Anyone who can approve' },
      { value: 'co_oversight', label: 'Any partner' }],
    {},
  );
  const asked = select(
    Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
    { value: 'action' },
  );
  const instruction = h('textarea', { rows: 3, placeholder: 'What you want them to do with it' });
  const due = h('input', { type: 'datetime-local', value: inHours(boot.settings.defaultDueHours) });

  const dialog = modal(`Send ${letter.ref} to…`, {},
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } }, letter.subject),
    field('A named person', person),
    field('A department', department, 'Whoever picks it up first has their name put against it'),
    field('Anyone holding a permission', permission),
    field('Asking them for', asked),
    field('Instruction', instruction),
    field('By when', due),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Approval and signature block dispatch: this letter cannot be marked as sent while either is open.'),
  );

  dialog.append(dialogActions(dialog, 'Send it', async () => {
    if (!person.value && !department.value && !permission.value) {
      throw new Error('Choose one of the three: a person, a department, or anyone with a permission');
    }
    await api.coRoute(letter.id, {
      toUserId: person.value || undefined,
      toDepartmentId: !person.value ? (department.value || undefined) : undefined,
      toPermission: !person.value && !department.value ? (permission.value || undefined) : undefined,
      action: asked.value,
      instruction: instruction.value.trim() || undefined,
      dueAt: toStamp(due.value) || undefined,
    });
    toast('Sent', 'good');
    await reload();
  }));
}

function openEdit(letter, boot, reload) {
  const subject = h('input', { value: letter.subject, maxlength: 300 });
  const body = h('textarea', { rows: 14, value: letter.body ?? '' });
  const summary = h('input', { value: letter.summary ?? '', maxlength: 200 });
  const theirRef = h('input', { value: letter.their_ref ?? '', maxlength: 100 });
  const letterDate = h('input', { type: 'date', value: (letter.letter_date ?? '').slice(0, 10) });
  const priority = select(
    [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]
      .map(([value, label]) => ({ value, label })),
    { value: letter.priority },
  );
  const category = select(
    [{ value: '', label: '— none —' }, ...boot.categories.map((c) => ({ value: c.id, label: c.name }))],
    { value: letter.category_id ?? '' },
  );
  const kase = select(
    [{ value: '', label: '— not linked —' },
      ...boot.cases.map((c) => ({ value: c.id, label: `${c.ref} · ${c.title}` }))],
    { value: letter.case_id ?? '' },
  );
  const confidentiality = select(
    [['normal', 'Normal'], ['confidential', 'Confidential'],
      ...(boot.permissions.includes('co_oversight') ? [['restricted', 'Restricted — partners only']] : [])]
      .map(([value, label]) => ({ value, label })),
    { value: letter.confidentiality },
  );

  const dialog = modal(`Edit ${letter.ref}`, { width: '760px' },
    field('Subject', subject),
    field('The letter', body),
    field('One-line summary', summary),
    h('div.field-row',
      field('Their reference', theirRef),
      field('Date on the letter', letterDate),
      field('Priority', priority),
    ),
    h('div.field-row',
      field('Category', category),
      field('Engagement', kase),
      field('Confidentiality', confidentiality),
    ),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Every change is written into the trail with your name against it. '
      + 'Once the document is signed it can no longer be edited at all.'),
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    await api.coUpdateLetter(letter.id, {
      subject: subject.value.trim(),
      body: body.value,
      summary: summary.value.trim(),
      theirRef: theirRef.value.trim(),
      letterDate: letterDate.value || null,
      priority: priority.value,
      categoryId: category.value || null,
      caseId: kase.value || null,
      confidentiality: confidentiality.value,
    });
    toast('Saved', 'good');
    await reload();
  }));
}

/**
 * Signing.
 *
 * Two ways, and both are the same assertion: a typed name, or one drawn with a
 * finger on a phone. The drawn one is not more secure — the security is the
 * seal, computed from the account that placed it and a secret in the server —
 * but it is what a partner expects to see on a letter, and a system people
 * refuse to use is not secure either.
 */
function openSign(letter, reload) {
  const name = h('input', { placeholder: 'Your name as it should appear', maxlength: 200 });
  const title = h('input', { placeholder: 'e.g. FCCA, Partner', maxlength: 120 });

  const canvas = h('canvas', {
    width: 480,
    height: 150,
    style: {
      border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)',
      width: '100%', maxWidth: '480px', touchAction: 'none', background: '#fff',
    },
  });
  const context = canvas.getContext('2d');
  context.lineWidth = 2.4;
  context.lineCap = 'round';
  context.strokeStyle = '#101418';
  let drawing = false;
  let drawn = false;

  const at = (event) => {
    const box = canvas.getBoundingClientRect();
    return [
      (event.clientX - box.left) * (canvas.width / box.width),
      (event.clientY - box.top) * (canvas.height / box.height),
    ];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true; drawn = true;
    canvas.setPointerCapture(e.pointerId);
    context.beginPath();
    context.moveTo(...at(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    context.lineTo(...at(e));
    context.stroke();
  });
  canvas.addEventListener('pointerup', () => { drawing = false; });

  let method = 'typed';
  const drawnBlock = h('div', { style: { display: 'none' } },
    canvas,
    h('div.btn-row', { style: { marginTop: '.4rem' } },
      h('button.btn-sm', {
        onclick: () => { context.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
      }, 'Clear'),
    ),
  );

  const methodSeg = h('div.seg',
    ...[['typed', 'Type it'], ['drawn', 'Draw it']].map(([value, label]) => {
      const button = h('button', {
        class: value === 'typed' ? 'active' : '',
        onclick: () => {
          method = value;
          [...methodSeg.children].forEach((c) => c.classList.toggle('active', c === button));
          drawnBlock.style.display = value === 'drawn' ? '' : 'none';
        },
      }, label);
      return button;
    }),
  );

  const dialog = modal(`Sign ${letter.ref}`, {},
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } }, letter.subject),
    h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'Signing seals this document'),
        h('div.alert-detail',
          'The subject, the text and every attached file are fixed at this moment. '
          + 'Nobody — including you — can edit them afterwards. Register a follow-up letter instead.'),
      )),
    field('How', methodSeg),
    field('Name', name),
    field('Title', title),
    drawnBlock,
  );

  dialog.append(dialogActions(dialog, 'Sign and seal', async () => {
    if (!name.value.trim()) throw new Error('Type your name — that is the assertion being recorded');
    if (method === 'drawn' && !drawn) throw new Error('Draw your signature in the box, or switch to typing it');

    await api.coSign(letter.id, {
      name: name.value.trim(),
      title: title.value.trim() || undefined,
      method,
      image: method === 'drawn' ? canvas.toDataURL('image/png') : undefined,
    });
    toast('Signed and sealed', 'good');
    await reload();
  }));

  setTimeout(() => name.focus(), 0);
}

/**
 * The verification result.
 *
 * Two independent questions with two independent answers, because they fail for
 * different reasons and a single "valid / invalid" would tell a reader nothing
 * about which one to go and investigate.
 */
function openVerify(result) {
  const trailOk = result.trail.ok;

  modal(`Verify ${result.ref}`, {},
    h('div.alert' + (trailOk ? '.good' : '.high'),
      h('span.alert-icon', trailOk ? '✓' : '⛔'),
      h('div',
        h('div.alert-title', trailOk
          ? `The trail is intact — ${result.trail.checked} entries`
          : 'The trail has been tampered with'),
        h('div.alert-detail', trailOk
          ? 'Every entry hashes to the value the next one committed to, all the way back to the first.'
          : `${result.trail.message} First break at entry ${result.trail.failedAt}, recorded ${fmtWhen(result.trail.at)}.`),
      )),

    result.signatures.length
      ? h('div.alert' + (result.sealsValid && !result.documentMoved ? '.good' : '.high'),
        h('span.alert-icon', result.sealsValid && !result.documentMoved ? '✓' : '⛔'),
        h('div',
          h('div.alert-title', result.sealsValid && !result.documentMoved
            ? `${result.signatures.length} signature${result.signatures.length === 1 ? '' : 's'}, all valid`
            : 'A signature does not check out'),
          h('div.alert-detail', !result.sealsValid
            ? 'A seal does not match. The signature record itself has been altered.'
            : result.documentMoved
              ? 'The seals are genuine, but the document has changed since it was signed.'
              : 'Each seal matches the document as it now stands.'),
        ))
      : h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'Not signed'),
          h('div.alert-detail', 'There are no signatures on this document to check.'))),

    h('p.muted', { style: { fontSize: '.82rem' } },
      `Checked ${fmtWhen(result.checkedAt)}. This proves the record has not been edited behind the `
      + 'application — a row changed in a database console breaks the chain here. It is not proof '
      + 'against somebody who can rewrite every row at once.'),
  );
}
