import { api } from '../api.js';
import { deriveLoginKey, prepareNewPassword } from '../crypto.js';
import { h, mount, toast } from '../util.js';
import {
  currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported, testPush,
} from '../push.js';

/**
 * Changing your own PIN or password.
 *
 * Available to everybody, because a credential that only an administrator can
 * change is a credential nobody ever changes — and a kitchen PIN that has been
 * the same since opening day is known to people who left months ago.
 */
export function openAccountDialog({ role, name, email: myEmail, isRecovery, canAlert = false }) {
  const usesPassword = role === 'admin';
  // Only the people who read the reports are offered the alert. A cook does not
  // need to be pinged about the sheet they just filled in themselves.
  const canSeeAlerts = canAlert && pushSupported();
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

    if (usesPassword && next.value.length < 10) {
      error.textContent = 'The new password must be at least 10 characters';
      return;
    }
    if (usesPassword && /^\d+$/.test(next.value)) {
      error.textContent = 'A password of only digits is a PIN. Include some words or letters.';
      return;
    }

    event.target.disabled = true;
    error.textContent = 'Saving…';
    try {
      if (usesPassword) {
        // Both the current and the new password are stretched here; neither
        // reaches the server in the clear.
        const params = await api.passwordSalt(myEmail);
        const currentPasswordKey = await deriveLoginKey(current.value, params.salt, params.iterations);
        await api.changeCredentials({
          currentPasswordKey,
          ...(await prepareNewPassword(next.value)),
        });
      } else {
        await api.changeCredentials({ currentPin: current.value, newPin: next.value });
      }

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
    canSeeAlerts ? alertsSection() : null,
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  if (!isRecovery) setTimeout(() => current.focus(), 0);

  /**
   * Alerts on this device.
   *
   * Rendered into a placeholder rather than awaited before opening, so the
   * dialog never waits on a service worker to appear.
   */
  function alertsSection() {
    const host = h('div', { style: { marginTop: '1.1rem', paddingTop: '.9rem', borderTop: '1px solid var(--border)' } });
    const status = h('p.muted', { style: { fontSize: '.85rem', minHeight: '1.2rem' } });

    const draw = (subscribed) => {
      const busy = (button, label) => { button.disabled = true; button.textContent = label; };

      const turnOn = h('button.btn-primary', {
        onclick: async (event) => {
          busy(event.target, 'Asking…');
          try {
            await enablePush();
            toast('Alerts are on for this device', 'good');
            draw(true);
          } catch (err) {
            status.textContent = err.message;
            event.target.disabled = false;
            event.target.textContent = 'Alert me on this device';
          }
        },
      }, 'Alert me on this device');

      const turnOff = h('button', {
        onclick: async (event) => {
          busy(event.target, 'Turning off…');
          await disablePush().catch(() => {});
          toast('Alerts are off for this device');
          draw(false);
        },
      }, 'Turn off');

      const tryIt = h('button.btn-sm', {
        onclick: async (event) => {
          busy(event.target, 'Sending…');
          try {
            await testPush();
            status.textContent = 'Sent. It should appear within a few seconds.';
          } catch (err) {
            status.textContent = err.message;
          }
          event.target.disabled = false;
          event.target.textContent = 'Send a test';
        },
      }, 'Send a test');

      mount(host,
        h('h3', { style: { fontSize: '.95rem', marginBottom: '.35rem' } }, 'Alerts on this device'),
        h('p.muted', { style: { fontSize: '.85rem' } },
          subscribed
            ? 'This device is alerted whenever a cook submits a day.'
            : 'Get a notification the moment a cook submits a day. Each device has to be turned on '
              + 'separately — a phone and a computer are two separate permissions.'),
        needsHomeScreen() && !subscribed
          ? h('div.guide-note.warn', { style: { marginTop: 0, fontSize: '.83rem' } },
            h('strong', 'On an iPhone or iPad: '),
            'add this site to your Home Screen first (Share → Add to Home Screen) and open it from '
            + 'there. Apple only allows alerts for sites added that way.')
          : null,
        status,
        h('div.btn-row', subscribed ? [turnOff, tryIt] : [turnOn]),
      );
    };

    currentSubscription().then((sub) => draw(Boolean(sub))).catch(() => draw(false));
    return host;
  }
}
