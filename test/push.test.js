import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import ece from 'http_ece';

import {
  b64urlDecode, b64urlEncode, encryptPayload, renderPing, signVapid,
} from '../src/lib/push.js';

/**
 * These tests exist because push encryption is the one part of this system
 * nobody can eyeball. A wrong byte does not look wrong — it just silently never
 * arrives on somebody's phone. So the output is decrypted by http_ece, the
 * reference implementation of the same spec, rather than by our own code
 * reading back its own homework.
 */

/** A browser subscription, as a real one would arrive. */
function fakeSubscription() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return {
    privateKey: ua,
    p256dh: b64urlEncode(new Uint8Array(ua.getPublicKey())),
    auth: b64urlEncode(crypto.randomBytes(16)),
  };
}

test('the reference implementation can decrypt what we encrypt', async () => {
  const sub = fakeSubscription();
  const plaintext = 'When I grow up, I want to be a watermelon';

  const body = await encryptPayload(plaintext, sub.p256dh, sub.auth);

  const decrypted = ece.decrypt(Buffer.from(body), {
    version: 'aes128gcm',
    privateKey: sub.privateKey,
    authSecret: Buffer.from(b64urlDecode(sub.auth)),
  });

  assert.equal(decrypted.toString('utf8'), plaintext);
});

test('a realistic ping survives the round trip intact', async () => {
  const sub = fakeSubscription();
  const message = JSON.stringify({
    title: 'Nice Operation — Monday breakfast',
    body: 'Kofi submitted 2026-08-10. 62 guests, GHS 24.10 per guest.\n2 items need a look.',
    url: 'https://breakfast.niceoperation.com/#/daily?day=2026-08-10',
  });

  const body = await encryptPayload(message, sub.p256dh, sub.auth);
  const decrypted = ece.decrypt(Buffer.from(body), {
    version: 'aes128gcm',
    privateKey: sub.privateKey,
    authSecret: Buffer.from(b64urlDecode(sub.auth)),
  });

  assert.deepEqual(JSON.parse(decrypted.toString('utf8')), JSON.parse(message));
});

test('the encrypted body carries the header the spec requires', async () => {
  const sub = fakeSubscription();
  const body = await encryptPayload('hello', sub.p256dh, sub.auth);

  assert.equal(body.length > 16 + 4 + 1 + 65, true, 'body must exceed its own header');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  assert.equal(view.getUint32(16), 4096, 'record size');
  assert.equal(body[20], 65, 'uncompressed P-256 key length');
  assert.equal(body[21], 0x04, 'key must be an uncompressed point');
});

test('every message uses a fresh salt and a fresh key', async () => {
  const sub = fakeSubscription();
  const one = await encryptPayload('same text', sub.p256dh, sub.auth);
  const two = await encryptPayload('same text', sub.p256dh, sub.auth);

  assert.notDeepEqual(one.slice(0, 16), two.slice(0, 16), 'salt must differ');
  assert.notDeepEqual(one.slice(21, 86), two.slice(21, 86), 'ephemeral key must differ');
  assert.notDeepEqual(one, two);
});

test('a message encrypted for one browser cannot be read by another', async () => {
  const mine = fakeSubscription();
  const theirs = fakeSubscription();

  const body = await encryptPayload('guest counts', mine.p256dh, mine.auth);

  assert.throws(() => ece.decrypt(Buffer.from(body), {
    version: 'aes128gcm',
    privateKey: theirs.privateKey,
    authSecret: Buffer.from(b64urlDecode(theirs.auth)),
  }));
});

// ------------------------------------------------------------------ VAPID --

test('the VAPID token verifies against our own public key', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);

  const jwt = await signVapid(privateJwk, 'https://fcm.googleapis.com', 'mailto:owner@example.com');
  const [header, claims, signature] = jwt.split('.');

  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(header)).toString()), { typ: 'JWT', alg: 'ES256' });

  const payload = JSON.parse(Buffer.from(b64urlDecode(claims)).toString());
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:owner@example.com');
  // The spec caps the lifetime at 24 hours; we ask for 12.
  const hours = (payload.exp - Math.floor(Date.now() / 1000)) / 3600;
  assert.ok(hours > 11.9 && hours < 12.1, `expiry was ${hours} hours`);

  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    b64urlDecode(signature), new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(verified, true);
  assert.equal(b64urlDecode(signature).length, 64, 'raw r||s, not DER');
});

test('a tampered token fails verification', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const jwt = await signVapid(await crypto.subtle.exportKey('jwk', pair.privateKey),
    'https://fcm.googleapis.com', 'mailto:owner@example.com');
  const [header, claims, signature] = jwt.split('.');

  const forged = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    aud: 'https://fcm.googleapis.com', exp: 9999999999, sub: 'mailto:attacker@example.com',
  })));

  const verified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey,
    b64urlDecode(signature), new TextEncoder().encode(`${header}.${forged}`),
  );
  assert.equal(verified, false);
});

// ------------------------------------------------------------- the wording --

test('the ping says who, when, how many and how much', () => {
  const ping = renderPing({
    insight: {
      day: '2026-08-10',
      weekday: 'Monday',
      currency: 'GHS',
      today: { guests: 62, costPerGuest: 24.1 },
      alerts: [{ level: 'high' }, { level: 'high' }, { level: 'warn' }],
    },
    propertyName: 'Nice Operation',
    submittedBy: 'Kofi',
    resubmission: false,
  });

  assert.equal(ping.title, 'Nice Operation — Monday breakfast');
  assert.match(ping.body, /Kofi submitted 2026-08-10/);
  assert.match(ping.body, /62 guests/);
  assert.match(ping.body, /GHS 24\.10 per guest/);
  assert.match(ping.body, /2 items need a look/);
});

test('a resubmission says so, and a day with no cost does not invent one', () => {
  const ping = renderPing({
    insight: {
      day: '2026-08-10',
      weekday: 'Monday',
      currency: 'GHS',
      today: { guests: 0, costPerGuest: null },
      alerts: [],
    },
    propertyName: 'Nice Operation',
    submittedBy: 'Ama',
    resubmission: true,
  });

  assert.match(ping.title, /\(updated\)/);
  assert.match(ping.body, /no cost yet/);
  assert.doesNotMatch(ping.body, /need a look/);
});
