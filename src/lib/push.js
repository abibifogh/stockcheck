import { dailyInsights, loadDataset } from './analytics.js';

/**
 * Phone and desktop alerts when a day sheet is submitted.
 *
 * Web Push, spoken directly to whichever push service the browser nominated —
 * Google's, Mozilla's, Apple's. There is no third-party service in the middle
 * and nothing to pay for: the browser hands us an endpoint, we sign a request
 * to it with our own key (VAPID, RFC 8292) and encrypt the message so only that
 * browser can read it (RFC 8291). Neither the push service nor anyone watching
 * the wire can see the guest counts.
 *
 * Sending is fired through `waitUntil` exactly like the email, so a push
 * service being slow or down can never delay, or fail, a cook pressing Submit.
 */

const encoder = new TextEncoder();

// --------------------------------------------------------------- base64url --

export function b64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// -------------------------------------------------------------------- HKDF --

async function hmac(key, data) {
  const imported = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

/**
 * HKDF as the push encryption spec uses it: one extract, then a single expand
 * round — every output here is 32 bytes or fewer, so the counter never passes 1.
 */
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const expanded = await hmac(prk, concat(info, Uint8Array.of(1)));
  return expanded.slice(0, length);
}

// ------------------------------------------------------------- encryption --

/**
 * Encrypt a message for one subscription (RFC 8291, aes128gcm).
 *
 * The shared secret comes from our throwaway key and the browser's public key,
 * salted with the subscription's own auth secret, so a message can only be read
 * by the browser that asked for it — and only that message, since the throwaway
 * key is discarded straight after.
 */
export async function encryptPayload(plaintext, p256dh, auth, testKeys = null) {
  const uaPublicRaw = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);

  const ephemeral = testKeys?.keyPair ?? await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, ephemeral.privateKey, 256,
  ));

  // The receiver's key comes first in the info string, then the sender's.
  const ikm = await hkdf(
    authSecret,
    shared,
    concat(encoder.encode('WebPush: info\0'), uaPublicRaw, asPublicRaw),
    32,
  );

  const salt = testKeys?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(encoder.encode('Content-Encoding: aes128gcm\0'), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(encoder.encode('Content-Encoding: nonce\0'), Uint8Array.of(1)))).slice(0, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks this as the final record; there is only ever one.
  const padded = concat(encoder.encode(plaintext), Uint8Array.of(2));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded,
  ));

  // Header: salt | record size | key length | our public key.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);

  return concat(salt, recordSize, Uint8Array.of(asPublicRaw.length), asPublicRaw, ciphertext);
}

// ------------------------------------------------------------------ VAPID --

/** Our own identity to the push service: a key we hold and nobody else does. */
export async function getVapidKeys(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('vapid_public', 'vapid_private')",
  ).all();
  const found = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  if (found.vapid_public && found.vapid_private) return found;

  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const privateKey = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));

  await db.batch([
    db.prepare("INSERT INTO settings (key, value) VALUES ('vapid_public', ?1) ON CONFLICT(key) DO NOTHING").bind(publicKey),
    db.prepare("INSERT INTO settings (key, value) VALUES ('vapid_private', ?1) ON CONFLICT(key) DO NOTHING").bind(privateKey),
  ]);

  // Re-read: a concurrent request may have won the race, and a mismatched pair
  // would invalidate every subscription already stored.
  const after = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('vapid_public', 'vapid_private')",
  ).all();
  return Object.fromEntries((after.results ?? []).map((r) => [r.key, r.value]));
}

/** A short-lived token proving the message came from this installation. */
export async function signVapid(privateJwk, audience, subject) {
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  })));

  const key = await crypto.subtle.importKey(
    'jwk', typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`),
  ));

  return `${header}.${claims}.${b64urlEncode(signature)}`;
}

// ------------------------------------------------------------------- send --

/**
 * Deliver to one subscription.
 *
 * Returns the push service's status so the caller can retire endpoints the
 * service has declared dead — a phone that was reset, or an app deleted.
 */
export async function sendPush(subscription, message, vapid, subject) {
  const endpoint = new URL(subscription.endpoint);
  const body = await encryptPayload(message, subscription.p256dh, subscription.auth);
  const jwt = await signVapid(vapid.vapid_private, endpoint.origin, subject);

  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: `vapid t=${jwt}, k=${vapid.vapid_public}`,
    },
    body,
  });

  return {
    ok: response.ok,
    status: response.status,
    // 404 and 410 are the push service saying this endpoint will never work
    // again. Anything else may be transient.
    gone: response.status === 404 || response.status === 410,
    detail: response.ok ? null : (await response.text().catch(() => '')).slice(0, 300),
  };
}

/** A ping short enough to read on a lock screen. */
export function renderPing({ insight, propertyName, submittedBy, resubmission }) {
  const t = insight.today;
  const flags = insight.alerts.filter((a) => a.level === 'high').length;
  const cost = t.costPerGuest == null
    ? 'no cost yet'
    : `${insight.currency} ${Number(t.costPerGuest).toFixed(2)} per guest`;

  return {
    title: `${propertyName} — ${insight.weekday} breakfast${resubmission ? ' (updated)' : ''}`,
    body: `${submittedBy} submitted ${insight.day}. ${t.guests} guests, ${cost}.`
      + (flags ? `\n${flags} ${flags === 1 ? 'item needs' : 'items need'} a look.` : ''),
    day: insight.day,
    flags,
  };
}

/**
 * Ping everyone subscribed. Never throws: a failure here must not affect the
 * kitchen, so every outcome is written to push_log instead.
 */
export async function pingDaySubmitted(db, { day, submittedBy, resubmission }) {
  const log = (status, detail, count = 0) => db.prepare(
    'INSERT INTO push_log (day, sent, status, detail) VALUES (?, ?, ?, ?)',
  ).bind(day, count, status, detail ? String(detail).slice(0, 500) : null)
    .run()
    .catch(() => {});

  try {
    const settingsRows = await db.prepare('SELECT key, value FROM settings').all();
    const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));
    if (settings.push_on_submit !== '1') return;

    const subs = await db.prepare('SELECT * FROM push_subscriptions').all();
    const list = subs.results ?? [];
    if (!list.length) {
      await log('skipped', 'Nobody has turned on alerts yet');
      return;
    }

    const ds = await loadDataset(db);
    const insight = dailyInsights(ds, day);
    const ping = renderPing({
      insight,
      propertyName: settings.property_name || 'Breakfast Unit',
      submittedBy,
      resubmission,
    });

    const vapid = await getVapidKeys(db);
    const subject = settings.email_from && settings.email_from.includes('@')
      ? `mailto:${settings.email_from.replace(/^.*<|>.*$/g, '').trim()}`
      : (settings.site_url || 'https://example.com');

    const message = JSON.stringify({ ...ping, url: `${settings.site_url || ''}/#/daily?day=${day}` });

    let sent = 0;
    const dead = [];
    const failures = [];
    for (const sub of list) {
      try {
        const result = await sendPush(sub, message, vapid, subject);
        if (result.ok) sent += 1;
        else if (result.gone) dead.push(sub.id);
        else failures.push(`${result.status} ${result.detail ?? ''}`.trim());
      } catch (err) {
        failures.push(err.message);
      }
    }

    // Retire endpoints the push service says are finished, so a reset phone
    // does not generate a failure every morning forever.
    if (dead.length) {
      await db.batch(dead.map((id) => db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id)))
        .catch(() => {});
    }

    // "sent" has to mean somebody was actually alerted. A morning where every
    // subscription turned out to be dead delivered nothing, and saying
    // otherwise would hide exactly the problem this log exists to show.
    const status = sent ? 'sent' : (failures.length || dead.length) ? 'failed' : 'skipped';

    await log(
      status,
      [
        failures.length ? `${failures.length} failed: ${failures[0]}` : null,
        dead.length
          ? `${dead.length} ${dead.length === 1 ? 'device had expired and was' : 'devices had expired and were'} removed`
          : null,
      ].filter(Boolean).join('; ') || null,
      sent,
    );
  } catch (err) {
    await log('failed', err.message);
  }
}
