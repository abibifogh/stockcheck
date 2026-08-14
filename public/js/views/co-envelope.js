import { api } from '../api.js';
import { h, toast } from '../util.js';
import { card, table } from './components.js';
import { act, dialogActions, field, fmtWhen, modal, select, signaturePad } from './co-common.js';

/**
 * Sending a document out for signature, and watching what happens to it.
 *
 * The panel on a letter answers three questions in the order somebody asks
 * them: has it come back, who are we waiting on, and can I have the link again.
 */

const RECIPIENT_PILL = {
  pending: ['', 'Waiting their turn'],
  invited: ['warn', 'Sent'],
  viewed: ['info', 'Opened'],
  signed: ['good', 'Signed'],
  declined: ['bad', 'Declined'],
  cancelled: ['', 'Withdrawn'],
};

const ENVELOPE_PILL = {
  draft: ['', 'Draft'],
  sent: ['warn', 'Out for signature'],
  completed: ['good', 'Fully signed'],
  declined: ['bad', 'Declined'],
  voided: ['bad', 'Withdrawn'],
  expired: ['bad', 'Expired'],
};

const ROLE_LABEL = { signer: 'Signs', approver: 'Approves', viewer: 'Copy only' };

export function envelopesCard(letter, envelopes, reload, may) {
  const settled = ['closed', 'cancelled'].includes(letter.status);
  const live = envelopes.find((e) => ['draft', 'sent'].includes(e.status));

  return card('Out for signature', {
    wide: true,
    note: live
      ? `${live.ref} is with ${live.waitingOn.join(', ') || 'nobody'}`
      : 'Send this to somebody outside the firm to sign. They need no account.',
    actions: may('co_approve') && !live && !settled
      ? h('button.btn-sm.btn-primary', {
        onclick: () => openSendEnvelope(letter, reload),
      }, '✉ Send for signature')
      : null,
  },
    envelopes.length
      ? h('div', envelopes.map((envelope) => envelopeBlock(envelope, letter, reload, may)))
      : h('div.empty',
        h('p', 'Nothing has been sent out for signature.'),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A client or a bank gets a link that is theirs alone. They open it, read the document, '
          + 'and sign — no account, no password. Sending freezes the text so that everybody signs '
          + 'the same thing.')),
  );
}

function envelopeBlock(envelope, letter, reload, may) {
  const [cls, label] = ENVELOPE_PILL[envelope.status] ?? ['', envelope.status];
  const isLive = ['draft', 'sent'].includes(envelope.status);

  return h('div', { style: { padding: '.8rem 0', borderTop: '1px solid var(--border)' } },
    h('div.btn-row',
      h('b', envelope.ref),
      h(`span.pill${cls ? `.${cls}` : ''}`, label),
      h('span.muted', { style: { fontSize: '.82rem' } },
        `${envelope.routing === 'parallel' ? 'all at once' : 'in order'}`
        + ` · sent ${fmtWhen(envelope.sent_at)} by ${envelope.created_by_name ?? 'somebody'}`
        + (envelope.expires_at && isLive ? ` · expires ${fmtWhen(envelope.expires_at)}` : '')),
      h('div', { style: { marginLeft: 'auto' } },
        h('button.btn-sm', {
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              openCertificate(await api.coCertificate(envelope.id));
            } catch (err) {
              toast(err.message, 'bad');
            }
            event.target.disabled = false;
          },
        }, 'Certificate'),
        isLive && may('co_approve')
          ? h('button.btn-sm.btn-danger', {
            onclick: () => openVoid(envelope, reload),
          }, 'Withdraw')
          : null,
      ),
    ),

    envelope.closed_reason
      ? h('p.muted', { style: { fontSize: '.85rem', margin: '.3rem 0' } }, envelope.closed_reason)
      : null,

    table([
      {
        key: 'name',
        label: 'Recipient',
        format: (name, r) => h('div',
          h('div', name, r.title ? h('small.muted', ` · ${r.title}`) : null),
          h('small.muted',
            r.email ?? 'no address',
            r.has_access_code ? ' · access code required' : '',
          ),
          // "Invited" and "actually told" are different states, and the gap
          // between them is where a signature quietly fails to happen.
          r.last_email_error
            ? h('div', h('small', { style: { color: 'var(--bad)' } }, `Email failed: ${r.last_email_error}`))
            : r.invite_sent_at
              ? h('div', h('small.muted', `emailed ${fmtWhen(r.invite_sent_at)}`))
              : (r.status === 'invited' && r.email
                ? h('div', h('small', { style: { color: 'var(--warn)' } }, 'not emailed — send them the link yourself'))
                : null),
        ),
      },
      { key: 'seq', label: '#', align: 'right' },
      { key: 'role', label: 'Asked to', format: (v) => ROLE_LABEL[v] ?? v },
      {
        key: 'status',
        label: '',
        format: (status, r) => {
          const [pill, text] = RECIPIENT_PILL[status] ?? ['', status];
          return h('div',
            h(`span.pill${pill ? `.${pill}` : ''}`, text),
            r.decline_reason ? h('div', h('small.muted', r.decline_reason)) : null,
          );
        },
      },
      {
        key: 'completed_at',
        label: 'When',
        format: (at, r) => h('div',
          at ? h('div', fmtWhen(at)) : h('span.muted', '—'),
          r.first_viewed_at && !at ? h('small.muted', `opened ${fmtWhen(r.first_viewed_at)}`) : null,
        ),
      },
      {
        key: 'signature_image',
        label: 'Signature',
        format: (image, r) => (image
          ? h('img', {
            src: image,
            alt: `${r.signed_name ?? r.name} signature`,
            style: { maxHeight: '40px', background: '#fff', padding: '2px', borderRadius: '4px' },
          })
          : r.signed_name
            ? h('span', { style: { fontFamily: 'cursive', fontSize: '1.05rem' } }, r.signed_name)
            : h('span.muted', '—')),
      },
      {
        key: 'id',
        label: '',
        align: 'right',
        format: (id, r) => (isLive && may('co_approve') && !['signed', 'declined'].includes(r.status)
          ? h('button.btn-sm', {
            title: 'Mint a fresh link. The old one stops working.',
            onclick: () => reissue(id, r, reload),
          }, 'New link')
          : ''),
      },
    ], envelope.recipients, { empty: 'No recipients.' }),
  );
}

async function reissue(recipientId, recipient, reload) {
  try {
    const result = await api.coReissueLink(recipientId);
    showLinks([result.link], {
      title: `A fresh link for ${recipient.name}`,
      note: 'The link they had before has stopped working.',
    });
    await reload();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function openSendEnvelope(letter, reload) {
  const subject = h('input', { value: letter.subject, maxlength: 300 });
  const message = h('textarea', {
    rows: 4,
    placeholder: 'A short covering note. This is the first thing they read.',
  });
  const routing = select(
    [{ value: 'sequential', label: 'One after another, in this order' },
      { value: 'parallel', label: 'Everybody at the same time' }],
    { value: 'sequential' },
  );
  const expiryDays = h('input', { type: 'number', min: '0', max: '3650', value: 30 });
  const reminderDays = h('input', { type: 'number', min: '0', max: '90', value: 3 });

  const rows = h('div', { style: { display: 'grid', gap: '.6rem' } });

  const addRecipient = () => {
    const name = h('input', { placeholder: 'Full name', maxlength: 200 });
    const email = h('input', { type: 'email', placeholder: 'Email address', maxlength: 200 });
    const role = select(
      [{ value: 'signer', label: 'Signs' },
        { value: 'approver', label: 'Approves' },
        { value: 'viewer', label: 'Copy only' }],
      { value: 'signer' },
    );
    const title = h('input', { placeholder: 'Position (optional)', maxlength: 120 });
    const accessCode = h('input', { placeholder: 'Access code (optional)', maxlength: 24 });

    const row = h('div', {
      style: {
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '.6rem',
      },
    },
      h('div.btn-row',
        h('b', { style: { fontSize: '.85rem' } }, `Recipient ${rows.children.length + 1}`),
        h('button.btn-sm.btn-ghost', {
          style: { marginLeft: 'auto' },
          onclick: () => { row.remove(); renumber(); },
        }, '✕'),
      ),
      h('div.field-row', field('Name', name), field('Email', email), field('Asked to', role)),
      h('div.field-row',
        field('Position', title),
        field('Access code', accessCode,
          'Give this to them separately — by telephone. A forwarded email is then not enough to sign.'),
      ),
    );
    row.fields = { name, email, role, title, accessCode };
    rows.append(row);
  };

  const renumber = () => {
    [...rows.children].forEach((row, i) => {
      row.querySelector('b').textContent = `Recipient ${i + 1}`;
    });
  };

  addRecipient();

  const dialog = modal(`Send ${letter.ref} for signature`, { width: '780px' },
    h('div.alert.info',
      h('span.alert-icon', 'ℹ️'),
      h('div',
        h('div.alert-title', 'Sending freezes this document'),
        h('div.alert-detail',
          'Its text and attachments cannot change while it is out. Everybody who signs signs the '
          + 'same thing, and the record can prove it afterwards.'),
      )),

    field('Subject', subject, 'What the recipient sees at the top of the page'),
    field('Covering note', message),

    field('Recipients', h('div',
      rows,
      h('button.btn-sm', { style: { marginTop: '.5rem' }, onclick: addRecipient }, '+ Another recipient'),
    )),

    h('div.field-row',
      field('Order', routing),
      field('Links expire after (days)', expiryDays, '0 for never — not recommended'),
      field('Chase every (days)', reminderDays, '0 never chases'),
    ),

    h('p.muted', { style: { fontSize: '.82rem' } },
      'The links appear once, on the next screen. Only their fingerprints are stored, so nothing '
      + 'here can show them to you again — a lost link is reissued, which kills the old one.'),
  );

  dialog.append(dialogActions(dialog, 'Send it', async () => {
    const recipients = [...rows.children].map((row) => ({
      name: row.fields.name.value.trim(),
      email: row.fields.email.value.trim() || undefined,
      role: row.fields.role.value,
      title: row.fields.title.value.trim() || undefined,
      accessCode: row.fields.accessCode.value.trim() || undefined,
    })).filter((r) => r.name);

    if (!recipients.length) throw new Error('Add at least one recipient');

    const result = await api.coSendEnvelope(letter.id, {
      subject: subject.value.trim(),
      message: message.value.trim() || undefined,
      routing: routing.value,
      expiryDays: Number(expiryDays.value),
      reminderDays: Number(reminderDays.value),
      recipients,
    });

    toast(`${result.envelope.ref} sent`, 'good');
    await reload();
    showLinks(result.links, {
      title: `${result.envelope.ref} — the links`,
      note: 'Send each person their own link. They appear here once and nowhere else.',
    });
  }));

  setTimeout(() => rows.querySelector('input')?.focus(), 0);
}

/**
 * The one moment the links exist outside the recipient's inbox.
 *
 * Shown rather than emailed silently, because a firm without email configured
 * still has to be able to send an engagement letter — and because the person
 * doing it should see exactly what is about to be sent on their behalf.
 */
function showLinks(links, { title, note }) {
  const origin = location.origin;

  const dialog = modal(title, { width: '720px' },
    h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'Copy these now'),
        h('div.alert-detail', note),
      )),

    h('div', { style: { display: 'grid', gap: '.7rem' } },
      links.map((link) => {
        const url = `${origin}${link.path}`;
        const box = h('input', {
          value: url,
          readonly: true,
          style: { fontFamily: 'var(--mono)', fontSize: '.78rem' },
          onclick: (event) => event.target.select(),
        });

        return h('div', {
          style: {
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '.6rem .7rem',
          },
        },
          h('div.btn-row',
            h('b', link.name),
            h('span.pill', ROLE_LABEL[link.role] ?? link.role),
            link.invited ? null : h('span.pill', 'waits their turn'),
            h('span.muted', { style: { fontSize: '.82rem' } }, link.email ?? 'no address'),
          ),
          box,
          h('div.btn-row', { style: { marginTop: '.35rem' } },
            h('button.btn-sm', {
              onclick: async (event) => {
                try {
                  await navigator.clipboard.writeText(url);
                  event.target.textContent = 'Copied';
                  setTimeout(() => { event.target.textContent = 'Copy link'; }, 1500);
                } catch {
                  box.select();
                  toast('Press Ctrl+C to copy', '');
                }
              },
            }, 'Copy link'),
            link.email
              ? h('a.btn.btn-sm', {
                href: `mailto:${encodeURIComponent(link.email)}`
                  + `?subject=${encodeURIComponent('Document for your signature')}`
                  + `&body=${encodeURIComponent(`Please sign here:\n\n${url}\n`)}`,
              }, 'Open in email')
              : null,
            link.accessCode
              ? h('span.muted', { style: { fontSize: '.82rem' } },
                'Access code: ', h('code.mono', link.accessCode), ' — give this to them separately')
              : null,
          ),
        );
      }),
    ),

    h('div.btn-row', { style: { justifyContent: 'flex-end', marginTop: '.8rem' } },
      h('button.btn-primary', { onclick: () => dialog.close() }, 'Done'),
    ),
  );
}

function openVoid(envelope, reload) {
  const reason = h('textarea', {
    rows: 3,
    placeholder: 'What to tell anybody who opens their link afterwards',
  });

  const dialog = modal(`Withdraw ${envelope.ref}`, {},
    h('p', 'Every outstanding link stops working immediately. Anybody who tries one is shown '
      + 'the reason you give here.'),
    field('Reason', reason),
  );

  dialog.append(dialogActions(dialog, 'Withdraw it', async () => {
    await api.coVoidEnvelope(envelope.id, reason.value.trim() || undefined);
    toast('Withdrawn', 'good');
    await reload();
  }, { danger: true }));
}

/**
 * The certificate.
 *
 * Printable, because the moment anybody wants one is the moment somebody
 * outside the firm has asked for evidence.
 */
function openCertificate(data) {
  const dialog = modal(`${data.envelope.ref} — certificate`, { width: '820px' },
    h('div.btn-row',
      h('button.btn-sm', { onclick: () => window.print() }, '🖨 Print'),
      h('span.muted', { style: { fontSize: '.82rem' } },
        `${data.letter.ref} · ${data.letter.subject}`),
    ),

    h('div', { style: { margin: '.7rem 0', display: 'grid', gap: '.25rem', fontSize: '.88rem' } },
      certRow('Status', ENVELOPE_PILL[data.envelope.status]?.[1] ?? data.envelope.status),
      certRow('Sent', `${fmtWhen(data.envelope.sent_at)} by ${data.envelope.created_by_name ?? 'unknown'}`),
      certRow('Completed', data.envelope.completed_at ? fmtWhen(data.envelope.completed_at) : '—'),
      certRow('Order', data.envelope.routing === 'parallel' ? 'All at once' : 'One after another'),
      certRow('Document fingerprint', h('code.mono', { style: { fontSize: '.75rem' } },
        data.envelope.content_hash ?? '—')),
    ),

    h('h3', 'Recipients'),
    table([
      { key: 'seq', label: '#', align: 'right' },
      {
        key: 'name',
        label: 'Name',
        format: (name, r) => h('div',
          h('div', name),
          h('small.muted', r.email ?? 'no address', r.requiredAccessCode ? ' · access code' : ''),
        ),
      },
      { key: 'role', label: 'Asked to', format: (v) => ROLE_LABEL[v] ?? v },
      {
        key: 'status',
        label: 'Outcome',
        format: (v) => (RECIPIENT_PILL[v]?.[1] ?? v),
      },
      { key: 'first_viewed_at', label: 'Opened', format: (v) => (v ? fmtWhen(v) : '—') },
      { key: 'completed_at', label: 'Responded', format: (v) => (v ? fmtWhen(v) : '—') },
      { key: 'ip', label: 'From', format: (v) => h('code.mono', { style: { fontSize: '.75rem' } }, v ?? '—') },
    ], data.recipients),

    h('h3', 'Everything that happened'),
    table([
      { key: 'at', label: 'When', format: (v) => h('span.nowrap', fmtWhen(v)) },
      { key: 'actor', label: 'Who' },
      { key: 'action', label: 'What', format: (v) => h('code.mono', { style: { fontSize: '.78rem' } }, v) },
      {
        key: 'detail',
        label: 'Detail',
        format: (detail) => (detail
          ? h('small.muted', Object.entries(detail)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join(' · '))
          : ''),
      },
      { key: 'ip', label: 'From', format: (v) => h('code.mono', { style: { fontSize: '.72rem' } }, v ?? '—') },
    ], data.events),

    h('p.muted', { style: { fontSize: '.8rem' } },
      'The fingerprint above is a keyed digest of the document as it stood when the request went '
      + 'out. Every signature is sealed against that value, so a document altered afterwards no '
      + 'longer matches what was signed — and the letter’s own verification says so.'),

    h('div.btn-row', { style: { justifyContent: 'flex-end' } },
      h('button.btn-primary', { onclick: () => dialog.close() }, 'Close'),
    ),
  );
}

function certRow(label, value) {
  return h('div', { style: { display: 'flex', gap: '.6rem' } },
    h('span.muted', { style: { minWidth: '170px' } }, label),
    h('span', value),
  );
}

/**
 * The signature this person signs with, set up once.
 *
 * A card rather than a page, and on My desk rather than in setup, because it
 * belongs to the person rather than to the firm and nobody would ever go
 * looking for it under Practice setup.
 */
export function mySignatureCard(saved, reload) {
  const openIt = () => {
    const pad = signaturePad({ saved, defaultName: saved?.signatureName ?? '', width: 460 });
    // The name is not part of a saved signature — it is typed fresh each time
    // something is signed — so the control's own name box is redundant here.
    pad.nameInput.closest('label')?.remove();

    const dialog = modal('My signature', { width: '620px' },
      h('p.muted', { style: { fontSize: '.88rem', marginTop: '-.4rem' } },
        'Draw it once, or upload a photograph of your real signature. From then on signing '
        + 'a document is one tap. Replacing it changes what you sign with next time and changes '
        + 'nothing you have already signed.'),
      pad.element,
    );

    const actions = dialogActions(dialog, 'Save', async () => {
      const value = pad.value();
      if (!value.image) throw new Error('A saved signature has to be drawn or uploaded, not typed');
      await api.coSaveMySignature({ method: value.method, image: value.image });
      toast('Saved', 'good');
      await reload();
    });

    if (saved?.image) {
      actions.querySelector('.btn-row').prepend(h('button.btn-sm.btn-danger', {
        style: { marginRight: 'auto' },
        onclick: async () => {
          if (!window.confirm('Remove your saved signature? Nothing you have already signed changes.')) return;
          await act(api.coSaveMySignature({ clear: true }), 'Removed', reload).catch(() => {});
          dialog.close();
        },
      }, 'Remove it'));
    }

    dialog.append(actions);
  };

  return card('My signature', {
    note: saved?.image ? 'Used when you sign, unless you choose otherwise' : null,
    actions: h('button.btn-sm', { onclick: openIt }, saved?.image ? 'Change' : 'Set one up'),
  },
    saved?.image
      ? h('img', {
        src: saved.image,
        alt: 'My saved signature',
        style: {
          maxHeight: '80px', maxWidth: '100%', background: '#fff',
          padding: '.4rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
        },
      })
      : h('p.muted', { style: { fontSize: '.88rem', margin: 0 } },
        'Set one up and signing becomes one tap instead of drawing your name with a mouse '
        + 'every time.'),
  );
}
