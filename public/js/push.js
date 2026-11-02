import { api } from './api.js';
import { h, mount, toast } from './util.js';
import { installOffered, onInstallChange } from './install.js';

/**
 * Turning on alerts for this browser.
 *
 * Notification permission is granted by a browser to a site on one device. It
 * cannot be carried to another, so this is a per-device switch rather than a
 * per-person setting, and the wording in the app says so.
 */

export function pushSupported() {
  return 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/**
 * iOS only allows notifications once a site has been added to the Home Screen.
 * Worth saying out loud, because the alternative is a permission prompt that
 * never appears and no explanation of why.
 */
export function needsHomeScreen() {
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  return iOS && !standalone;
}

let registration = null;
async function ready() {
  if (!registration) registration = await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready.then(() => registration);
}

/** The subscription this browser already holds, if any. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    const reg = await ready();
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function urlBase64ToBytes(value) {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function keysOf(subscription) {
  const raw = subscription.toJSON().keys ?? {};
  return { p256dh: raw.p256dh, auth: raw.auth };
}

/** A name for this device, so a list of them is readable later. */
function describeDevice() {
  const ua = navigator.userAgent;
  const platform = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android phone'
        : /Macintosh/.test(ua) ? 'Mac'
          : /Windows/.test(ua) ? 'Windows PC'
            : 'This device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Safari\//.test(ua) ? 'Safari'
          : 'browser';
  return `${platform} · ${browser}`;
}

/** Turn a browser's developer-facing failure into something actionable. */
function hintFor(err) {
  const text = String(err?.message || err);
  if (/incognito|private/i.test(text)) {
    return 'Private browsing windows cannot receive alerts — open the site in a normal window.';
  }
  if (/permission/i.test(text)) {
    return 'This can happen in a private window, or where notifications are switched off for the '
      + 'whole browser. Check your browser’s notification settings and try again.';
  }
  if (/push service|network|failed to fetch/i.test(text)) {
    return 'The browser could not reach its notification service. Check the connection and try again.';
  }
  return 'Try again, or use a different browser on this device.';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('This browser cannot show alerts.');

  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new Error('This browser is blocking alerts for the site. Allow notifications for it in '
      + 'your browser settings, then try again.');
  }
  if (permission !== 'granted') throw new Error('Alerts were not allowed.');

  const reg = await ready();
  const { key } = await api.pushKey();

  let subscription = await reg.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(key),
      });
    } catch (err) {
      // The browser's own wording here is for developers — "Registration failed
      // - permission denied" means almost nothing to somebody trying to get
      // alerts on their phone.
      throw new Error(`This browser would not register for alerts. ${hintFor(err)}`);
    }
  }

  await api.pushSubscribe({
    endpoint: subscription.endpoint,
    ...keysOf(subscription),
    label: describeDevice(),
  });

  return subscription;
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.pushUnsubscribe({ endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

export async function testPush() {
  const subscription = await currentSubscription();
  if (!subscription) throw new Error('Turn alerts on for this device first.');
  await api.pushTest({ endpoint: subscription.endpoint });
}

/**
 * Keep this device's alerts pointed at whoever is signed in.
 *
 * A browser that has already been allowed to notify needs no second question:
 * if it has no subscription yet (a new sign-in, a cleared cache, a phone the
 * push service rotated) it is subscribed quietly here. It also re-sends an
 * existing one, so a shared kitchen phone alerts the person now using it.
 *
 * A browser that has not been asked yet is never asked from here. Every
 * browser only shows that question after a tap, and one that pops up unasked
 * is the one people answer "Block" to for good.
 */
export async function keepAlertsOn() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await ready();
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const { key } = await api.pushKey();
      subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
    }
    await api.pushSubscribe({ endpoint: subscription.endpoint, ...keysOf(subscription), label: describeDevice() });
  } catch { /* the account dialog is where a failure gets explained */ }
}

const ALERTS_DISMISS_KEY = 'bf.alertsDismissed';
const alertsDismissed = () => {
  try {
    return Date.now() - (Number(localStorage.getItem(ALERTS_DISMISS_KEY)) || 0) < 14 * 86400000;
  } catch { return false; }
};

/**
 * The one-tap offer to turn alerts on, for a device that has never been asked.
 *
 * Waits behind the install offer: on an iPhone alerts only work once the app
 * is on the home screen, and two banners at once is one too many.
 */
export function alertsBanner() {
  const host = h('div.install-host');
  const paint = () => {
    const show = pushSupported()
      && Notification.permission === 'default'
      && !needsHomeScreen()
      && !installOffered()
      && !alertsDismissed();
    if (!show) { mount(host); return; }
    const status = h('div.install-sub', 'A notification the moment a request or a day needs you, even with the app closed.');
    mount(host, h('section.install-banner.alerts-banner',
      h('span.alerts-mark', { html: ALERTS_ICON }),
      h('div', h('div.install-title', 'Turn on alerts for this device'), status),
      h('div.btn-row',
        h('button.btn-sm.btn-ghost', {
          onclick: () => {
            try { localStorage.setItem(ALERTS_DISMISS_KEY, String(Date.now())); } catch { /* private mode */ }
            paint();
          },
        }, 'Not now'),
        h('button.btn-sm.btn-primary', {
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              await enablePush();
              toast('Alerts are on for this device', 'good');
              paint();
            } catch (err) {
              status.textContent = err.message;
              event.target.disabled = false;
              if (Notification.permission === 'denied') paint();
            }
          },
        }, 'Turn on')),
    ));
  };
  paint();
  const stop = onInstallChange(() => (host.isConnected ? paint() : stop()));
  return host;
}

const ALERTS_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9z"/><path d="M10.2 20.5a2 2 0 0 0 3.6 0"/></svg>';
