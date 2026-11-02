import { h, mount } from './util.js';

/**
 * Putting the app on the phone's home screen.
 *
 * Two kinds of phone, two ways in. Android (and Chrome on a computer) offers a
 * prompt the page can open with one tap — but only hands it over when it is
 * ready, so this listens from the moment the app loads. iPhones have no such
 * prompt: Safari's Share menu has "Add to Home Screen", so the app says
 * exactly that. On an iPhone this is also what lets the app send alerts at
 * all; Safari only allows notifications to an installed app.
 *
 * Once installed it opens full screen with its own icon, and none of this is
 * shown again.
 */

let deferred = null;
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferred = event;
  changed();
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  changed();
});

/**
 * The service worker, registered on every visit. It caches nothing — a
 * kitchen app showing yesterday's numbers is worse than one that is offline —
 * but browsers treat a site that has one as an app, and it is what delivers
 * alerts.
 */
export function registerWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

export function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 'installed', 'prompt' (one tap), 'ios' (Share → Add to Home Screen) or 'none'. */
export function installState() {
  if (isInstalled()) return 'installed';
  if (deferred) return 'prompt';
  if (isIOS()) return 'ios';
  return 'none';
}

export function onInstallChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const SHARE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

/** The iPhone's three steps, shown over the page. */
function showIOSSteps() {
  const dialog = h('dialog.install-steps',
    h('h2', 'Install on this iPhone'),
    h('ol',
      h('li', 'Tap ', h('b', 'Share'), ' ', h('span.install-share', { html: SHARE_ICON }),
        ' at the bottom of Safari (top right on an iPad).'),
      h('li', 'Scroll down and tap ', h('b', 'Add to Home Screen'), '.'),
      h('li', 'Tap ', h('b', 'Add'), '. The app is on your home screen, and opens full screen.')),
    h('p.muted', 'Using Chrome on the iPhone? The same is under its Share menu.'),
    h('div.btn-row', { style: { justifyContent: 'flex-end' } },
      h('button.btn-primary', { onclick: () => dialog.close() }, 'Got it')),
  );
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

/** Install, whichever way this phone does it. */
export async function install() {
  if (deferred) {
    const event = deferred;
    deferred = null;
    await event.prompt();
    await event.userChoice.catch(() => null);
    changed();
    return;
  }
  if (isIOS()) showIOSSteps();
}

const DISMISS_KEY = 'bf.installDismissed';
const dismissedRecently = () => {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY)) || 0;
    return Date.now() - at < 30 * 86400000;
  } catch { return false; }
};

/**
 * A quiet offer at the top of the page, until it is installed or somebody
 * says "Not now" (asked again after a month). It fills itself in when the
 * browser's prompt arrives, which can be a moment after the page loads.
 */
export function installBanner() {
  const host = h('div.install-host');
  const paint = () => {
    const state = installState();
    if (state === 'installed' || state === 'none' || dismissedRecently()) { mount(host); return; }
    mount(host, h('section.install-banner',
      h('img', { src: '/icons/icon-192.png', alt: '', width: 44, height: 44 }),
      h('div',
        h('div.install-title', 'Install the app on this phone'),
        h('div.install-sub', state === 'ios'
          ? 'Its own icon on the home screen, full screen, and alerts when something needs you.'
          : 'Its own icon on the home screen, opening full screen like any other app.')),
      h('div.btn-row',
        h('button.btn-sm.btn-ghost', {
          onclick: () => {
            try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
            paint();
          },
        }, 'Not now'),
        h('button.btn-sm.btn-primary', { onclick: install }, 'Install')),
    ));
  };
  paint();
  const stop = onInstallChange(() => (host.isConnected ? paint() : stop()));
  return host;
}
