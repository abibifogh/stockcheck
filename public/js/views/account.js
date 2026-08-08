import { api } from '../api.js';
import { h, toast } from '../util.js';

/**
 * Changing your own PIN or password.
 *
 * Available to everybody, because a credential that only an administrator can
 * change is a credential nobody ever changes — and a kitchen PIN that has been
 * the same since opening day is known to people who left months ago.
 */
export function openAccountDialog({ role, name, isRecovery }) {
  const usesPassword = role === 'admin';
  const error = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } });

  const current = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'Current password' : 'Current PIN',
    autocomplete: 'current-password',
  });
  const next = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'New password (10+ characters)' : 'New PIN (4 to 10 digits)',
    autocomplete: 'new-password',
  });
  const confirm = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'Repeat the new password' : 'Repeat the new PIN',
    autocomplete: 'new-password',
  });

  const save = async (event) => {
    if (!current.value || !next.value) {
      error.textContent = 'Fill in every box';
      return;
    }
    if (next.value !== confirm.value) {
      error.textContent = usesPassword
        ? 'The two new passwords do not match'
        : 'The two new PINs do not match';
      return;
    }

    event.target.disabled = true;
    error.textContent = 'Saving…';
    try {
      await api.changeCredentials(usesPassword
        ? { currentPassword: current.value, newPassword: next.value }
        : { currentPin: current.value, newPin: next.value });

      toast(usesPassword ? 'Password changed' : 'PIN changed', 'good');
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      event.target.disabled = false;
    }
  };

  const body = isRecovery
    ? h('div',
      h('div.alert.warn',
        h('span.alert-icon', '🔑'),
        h('div',
          h('div.alert-title', 'You are signed in with the emergency recovery PIN'),
          h('div.alert-detail',
            'That PIN lives on the server rather than in this app, so it cannot be changed here. '
            + 'Create a proper administrator account for yourself under Users & data, then sign in '
            + 'with that.'),
        )))
    : h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        usesPassword
          ? 'Choose something long. It does not need to be complicated — a few unrelated words is stronger than one word with symbols in it.'
          : 'Pick a PIN only you know. Everyone needs a different one, so the day sheets show who entered them.'),
      h('label.field', h('span', usesPassword ? 'Current password' : 'Current PIN'), current),
      h('label.field', h('span', usesPassword ? 'New password' : 'New PIN'), next),
      h('label.field', h('span', 'Repeat it'), confirm),
      error,
      h('div.btn-row', { style: { justifyContent: 'flex-end' } },
        h('button', { onclick: () => dialog.close() }, 'Cancel'),
        h('button.btn-primary', { onclick: save }, usesPassword ? 'Change password' : 'Change PIN'),
      ));

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '420px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', 'My account'),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('p.muted', { style: { fontSize: '.85rem', marginTop: '-.4rem' } },
      `Signed in as ${name}`),
    body,
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  if (!isRecovery) setTimeout(() => current.focus(), 0);
}
