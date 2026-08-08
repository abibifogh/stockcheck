import { api } from '../api.js';
import { h, mount, toast } from '../util.js';

/** PIN keypad. Big targets, no keyboard needed, works with gloves on. */
export function renderLogin(onSuccess) {
  let pin = '';
  let busy = false;

  const display = h('div.pin-display', '');
  const error = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } }, '');

  const paint = () => { display.textContent = '•'.repeat(pin.length); };

  const submit = async () => {
    if (busy || !pin) return;
    busy = true;
    error.textContent = 'Checking…';
    try {
      const result = await api.login(pin);
      toast(`Welcome, ${result.name}`, 'good');
      onSuccess(result);
    } catch (err) {
      error.textContent = err.message;
      pin = '';
      paint();
      display.animate(
        [{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
        { duration: 180, iterations: 2 },
      );
    } finally {
      busy = false;
    }
  };

  const press = (digit) => {
    if (pin.length >= 12) return;
    pin += digit;
    paint();
    error.textContent = '';
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const keypad = h('div.keypad',
    keys.map((k) => h('button', { onclick: () => press(k) }, k)),
    h('button.btn-ghost', {
      onclick: () => { pin = pin.slice(0, -1); paint(); },
    }, '⌫'),
    h('button', { onclick: () => press('0') }, '0'),
    h('button.btn-primary', { onclick: submit }, '→'),
  );

  const onKeydown = (event) => {
    if (/^\d$/.test(event.key)) press(event.key);
    else if (event.key === 'Backspace') { pin = pin.slice(0, -1); paint(); }
    else if (event.key === 'Enter') submit();
  };
  window.addEventListener('keydown', onKeydown);

  const wrap = h('div.login-wrap',
    h('div.card.login-card',
      h('div', { style: { fontSize: '2rem' } }, '🍳'),
      h('h1', 'Breakfast Control'),
      h('p.muted', { style: { fontSize: '.88rem' } }, 'Enter your PIN to continue'),
      display,
      error,
      keypad,
      h('p.muted', { style: { fontSize: '.75rem', marginTop: '1rem' } },
        'Cooks use the kitchen PIN. Managers use the manager PIN for reports and setup.'),
    ),
  );

  // The login screen is replaced wholesale on success; drop the global listener
  // with it so keystrokes are not captured by a detached view.
  const observer = new MutationObserver(() => {
    if (!wrap.isConnected) {
      window.removeEventListener('keydown', onKeydown);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return wrap;
}
