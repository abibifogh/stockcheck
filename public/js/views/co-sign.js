import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { fmtDate, fmtWhen, signaturePad } from './co-common.js';

/**
 * The page somebody outside the firm sees when they open a signing link.
 *
 * It exists entirely outside the rest of the application: no account, no sign
 * in, no menu, no way to reach anything else. The token from the URL is the
 * whole of the recipient's identity, and it goes no further than the four
 * endpoints that accept it.
 *
 * Written for somebody who has never seen this system, is probably on a phone,
 * and did not choose to be here. So: what it is, who sent it, what it says,
 * and one button. Nothing to explore, nothing to configure, nothing that looks
 * like software.
 */
export async function renderSigningPage(token) {
  const root = h('div.sign-page');
  let accessCode = null;

  const load = async () => {
    mount(root, h('div.card', h('div.skeleton', { style: { height: '140px' } })));
    try {
      const data = await api.coSignOpen(token, accessCode);
      if (data.needsAccessCode) {
        mount(root, accessCodeForm(data, (code) => { accessCode = code; return load(); }));
        return;
      }
      mount(root, page(data, token, accessCode, load));
    } catch (err) {
      mount(root, closedCard(err.message || String(err)));
    }
  };

  await load();
  return root;
}

// ---------------------------------------------------------------------------

function shell(title, sub, ...children) {
  return h('div', { style: { maxWidth: '760px', margin: '0 auto', padding: '1.2rem .8rem 3rem' } },
    h('div.page-head',
      h('div',
        h('h1', title),
        sub ? h('div.sub', sub) : null,
      ),
    ),
    ...children,
  );
}

function closedCard(message) {
  return shell('This link cannot be opened', null,
    h('div.card.empty',
      h('h3', 'Nothing to sign here'),
      h('p', message),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'If you were expecting to sign something, reply to the email you were sent and '
        + 'ask for a new link. Links are deliberately short-lived and can only be used by '
        + 'the person they were sent to.'),
    ));
}

/**
 * The access code gate.
 *
 * Asked for before anything at all is shown, including the subject line. "Your
 * settlement of the disputed assessment" tells a reader who should not have the
 * email a great deal on its own.
 */
function accessCodeForm(data, submit) {
  const code = h('input', {
    placeholder: 'Access code',
    autocomplete: 'one-time-code',
    style: { textTransform: 'uppercase', letterSpacing: '.08em', fontSize: '1.1rem' },
  });
  const error = h('div.form-error', { style: { display: data.wrong ? '' : 'none' } },
    'That code was not right. Check it and try again.');

  const go = () => {
    if (!code.value.trim()) return;
    submit(code.value.trim());
  };
  code.addEventListener('keydown', (event) => { if (event.key === 'Enter') go(); });

  return shell(data.firmName ?? 'Document for signature', null,
    h('section.card',
      h('p', 'This document is protected by an access code. '
        + 'It was given to you separately — by telephone, or in the covering letter.'),
      h('label.field', h('span', 'Access code'), code),
      error,
      h('button.btn-primary', { onclick: go }, 'Continue'),
    ));
}

function page(data, token, accessCode, reload) {
  const { envelope, you, document: doc, others, theirTurn, firmName } = data;
  const done = you.status === 'signed';
  const declined = you.status === 'declined';

  return shell(
    envelope.subject,
    `${firmName} · ${envelope.ref}`,

    done ? signedCard(you, envelope, doc) : null,
    declined ? declinedCard() : null,

    !done && !declined && !theirTurn
      ? h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'Not your turn yet'),
          h('div.alert-detail',
            'This document is being signed in order, and somebody before you has not finished. '
            + 'You will be told when it reaches you — this link will still work.'),
        ))
      : null,

    envelope.message
      ? h('section.card',
        h('div.card-head', h('h2', `A note from ${envelope.sentBy ?? firmName}`)),
        h('p', { style: { whiteSpace: 'pre-line', margin: 0 } }, envelope.message))
      : null,

    !doc.unchanged
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'This document has changed since it was sent to you'),
          h('div.alert-detail',
            'Do not sign it. Contact the firm and ask them to send a fresh request.'),
        ))
      : null,

    documentCard(doc, token, accessCode),

    others.length
      ? h('section.card',
        h('div.card-head', h('h2', 'Who else is signing')),
        h('ul', { style: { margin: 0, paddingLeft: '1.1rem' } },
          others.map((person) => h('li',
            person.name,
            h('span.muted', ` — ${ROLE_WORD[person.role] ?? person.role}`),
            person.status === 'signed' ? h('span.pill.good', { style: { marginLeft: '.4rem' } }, 'signed') : null,
            person.status === 'declined' ? h('span.pill.bad', { style: { marginLeft: '.4rem' } }, 'declined') : null,
          )),
        ))
      : null,

    !done && !declined && theirTurn && doc.unchanged
      ? signingCard(data, token, accessCode, reload)
      : null,

    h('p.muted', { style: { fontSize: '.8rem', textAlign: 'center', marginTop: '1.4rem' } },
      envelope.expiresAt
        ? `This link stops working on ${fmtDate(envelope.expiresAt)}. `
        : '',
      'It was sent to you alone and should not be forwarded.'),
  );
}

const ROLE_WORD = {
  signer: 'signing',
  approver: 'approving',
  viewer: 'copied in',
};

function signedCard(you, envelope, doc) {
  return h('div',
    h('div.alert.good',
      h('span.alert-icon', '✓'),
      h('div',
        h('div.alert-title', 'You have signed this'),
        h('div.alert-detail',
          `Signed as ${you.signedName ?? you.name} on ${fmtWhen(you.completedAt)}. `
          + 'Nothing further is needed from you.'),
      )),
    h('section.card',
      h('div.card-head', h('h2', 'Your receipt'), h('button.btn-sm', { onclick: () => window.print() }, '🖨 Print')),
      h('div', { style: { display: 'grid', gap: '.3rem', fontSize: '.9rem' } },
        receiptRow('Document', doc.ref),
        receiptRow('Request', envelope.ref),
        receiptRow('Signed by', you.signedName ?? you.name),
        receiptRow('Signed on', fmtWhen(you.completedAt)),
      ),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Keep this page or print it. The firm holds the full record, including the exact '
        + 'document you signed and the time it was signed.')),
  );
}

function receiptRow(label, value) {
  return h('div', { style: { display: 'flex', gap: '.6rem' } },
    h('span.muted', { style: { minWidth: '120px' } }, label),
    h('span', value ?? '—'),
  );
}

function declinedCard() {
  return h('div.alert.warn',
    h('span.alert-icon', '⚠️'),
    h('div',
      h('div.alert-title', 'You declined to sign this'),
      h('div.alert-detail', 'The firm has been told. Contact them if that was a mistake.'),
    ));
}

/** The document itself: the text, and any files, fetched with the same token. */
function documentCard(doc, token, accessCode) {
  const openFile = async (file, button) => {
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      const response = await api.coSignFile({ token, accessCode, id: file.id });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // Revoked on a timer rather than immediately: the new tab has to have
      // finished with it first, and there is no event that says when.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast(err.message || 'That file could not be opened', 'bad');
    }
    button.disabled = false;
    button.textContent = 'Open';
  };

  return h('section.card',
    h('div.card-head',
      h('h2', 'The document'),
      h('span.card-note', doc.ref),
    ),
    doc.letterDate ? h('p.muted', { style: { fontSize: '.85rem' } }, fmtDate(doc.letterDate)) : null,
    h('h3', { style: { marginTop: 0 } }, doc.subject),
    doc.body
      ? h('pre', {
        style: {
          whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '0 0 1rem',
          lineHeight: '1.65', fontSize: '.95rem',
        },
      }, doc.body)
      : h('p.muted', 'The document is the attached file below.'),

    doc.attachments.length
      ? h('div',
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Attached'),
        h('div', { style: { display: 'grid', gap: '.4rem' } },
          doc.attachments.map((file) => {
            const button = h('button.btn-sm', {}, 'Open');
            button.addEventListener('click', () => openFile(file, button));
            return h('div', {
              style: {
                display: 'flex', alignItems: 'center', gap: '.6rem',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '.5rem .7rem',
              },
            },
              h('span', { style: { flex: '1' } }, file.name),
              h('span.muted', { style: { fontSize: '.8rem' } }, `${Math.max(1, Math.round(file.size / 1024))} KB`),
              button,
            );
          }),
        ),
        h('p.muted', { style: { fontSize: '.8rem', marginBottom: 0 } },
          'Please read every attachment before you sign. They are part of what you are signing.'))
      : null,
  );
}

/** The one thing this page is for. */
function signingCard(data, token, accessCode, reload) {
  const { you, disclosure } = data;
  const asked = you.role === 'approver' ? 'approve' : 'sign';

  const pad = signaturePad({ defaultName: you.name, width: 420 });
  const consent = h('input', { type: 'checkbox' });
  const error = h('div.form-error', { style: { display: 'none' } });

  const fail = (message) => {
    error.textContent = message;
    error.style.display = '';
  };

  const submit = h('button.btn-primary', {
    onclick: async () => {
      error.style.display = 'none';
      if (!consent.checked) {
        fail('Please tick the box above to confirm you agree to sign electronically.');
        return;
      }

      let signature;
      try {
        signature = pad.value();
      } catch (err) {
        fail(err.message);
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Signing…';
      try {
        await api.coSignSubmit({
          token,
          accessCode,
          consent: true,
          name: signature.name,
          method: signature.method,
          image: signature.image ?? undefined,
          title: title.value.trim() || undefined,
        });
        toast('Signed. Thank you.', 'good');
        await reload();
      } catch (err) {
        fail(err.message || String(err));
        submit.disabled = false;
        submit.textContent = asked === 'approve' ? 'Approve' : 'Sign';
      }
    },
  }, asked === 'approve' ? 'Approve' : 'Sign');

  const title = h('input', {
    value: you.title ?? '',
    maxlength: 120,
    placeholder: 'e.g. Director, or Finance Manager',
  });

  return h('section.card',
    h('div.card-head', h('h2', asked === 'approve' ? 'Approve this document' : 'Sign this document')),

    pad.element,
    h('label.field', h('span', 'Your position (optional)'), title),

    h('div', {
      style: {
        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
        padding: '.7rem .8rem', margin: '.6rem 0',
      },
    },
      h('label.inline-check', { style: { alignItems: 'flex-start' } },
        consent,
        h('span', { style: { fontSize: '.86rem', lineHeight: '1.5' } }, disclosure),
      )),

    error,

    h('div.btn-row', { style: { marginTop: '.4rem' } },
      submit,
      h('button.btn-sm', {
        onclick: () => openDecline(token, accessCode, reload),
      }, 'I will not sign this'),
    ),
  );
}

/**
 * Declining.
 *
 * A reason is required. A refusal with no reason leaves the firm with nothing
 * to act on and the recipient with a second email asking them what was wrong,
 * which is the conversation this box exists to have once.
 */
function openDecline(token, accessCode, reload) {
  const reason = h('textarea', {
    rows: 4,
    placeholder: 'What is wrong with it, or why you are not the right person to sign.',
  });
  const error = h('div.form-error', { style: { display: 'none' } });

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '480px', width: '94vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', 'Decline to sign'),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('p.muted', { style: { fontSize: '.88rem' } },
      'This ends the request for everybody, and the firm is told straight away. '
      + 'Nothing is signed.'),
    h('label.field', h('span', 'Why'), reason),
    error,
    h('div.btn-row', { style: { justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Go back'),
      h('button.btn-danger', {
        onclick: async (event) => {
          if (!reason.value.trim()) {
            error.textContent = 'Please say why. The firm cannot act on a refusal with no reason.';
            error.style.display = '';
            return;
          }
          event.target.disabled = true;
          try {
            await api.coSignDecline({ token, accessCode, reason: reason.value.trim() });
            dialog.close();
            await reload();
          } catch (err) {
            error.textContent = err.message || String(err);
            error.style.display = '';
            event.target.disabled = false;
          }
        },
      }, 'Decline'),
    ),
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  setTimeout(() => reason.focus(), 0);
}
