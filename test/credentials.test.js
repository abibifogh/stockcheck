import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword, hashPin, isReservedPin, normaliseEmail, verifyPassword,
} from '../src/lib/auth.js';

test('a correct password verifies and a wrong one does not', async () => {
  const stored = await hashPassword('breakfast-toast-lantern');
  assert.equal(await verifyPassword('breakfast-toast-lantern', stored), true);
  assert.equal(await verifyPassword('breakfast-toast-lanterns', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('the same password hashes differently every time', async () => {
  const a = await hashPassword('kettle-harbour-window');
  const b = await hashPassword('kettle-harbour-window');
  assert.notEqual(a, b, 'a per-password salt must make identical passwords look different');
  // …and both still verify.
  assert.equal(await verifyPassword('kettle-harbour-window', a), true);
  assert.equal(await verifyPassword('kettle-harbour-window', b), true);
});

test('the stored hash reveals neither the password nor a reusable secret', async () => {
  const stored = await hashPassword('sunrise-kettle-window');
  assert.ok(!stored.includes('sunrise'));
  assert.ok(stored.startsWith('pbkdf2$'), 'the algorithm and cost are recorded with the hash');
  const [, iterations] = stored.split('$');
  assert.ok(Number(iterations) >= 100000, 'the work factor must be high enough to matter');
});

test('a malformed or missing stored hash fails closed', async () => {
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', ''), false);
  assert.equal(await verifyPassword('anything', 'plaintext'), false);
  assert.equal(await verifyPassword('anything', 'pbkdf2$broken'), false);
});

test('a raised work factor does not invalidate existing passwords', async () => {
  const old = await hashPassword('harbour-pencil-morning', 120_000);
  assert.equal(await verifyPassword('harbour-pencil-morning', old), true);
});

test('email addresses are compared without case or spacing mattering', () => {
  assert.equal(normaliseEmail('  Micheal@NiceOperation.com '), 'micheal@niceoperation.com');
  assert.equal(normaliseEmail(null), '');
});

// ---------------------------------------------------------------- PINs ----

test('the same PIN hashes to the same value, so login is a single lookup', async () => {
  const a = await hashPin('4321', 'installation-pepper');
  const b = await hashPin('4321', 'installation-pepper');
  assert.equal(a, b);
});

test('two installations with the same PIN produce different hashes', async () => {
  const a = await hashPin('4321', 'pepper-one');
  const b = await hashPin('4321', 'pepper-two');
  assert.notEqual(a, b, 'the per-installation pepper must separate them');
});

test('a PIN matching a server recovery secret is reserved', async () => {
  const env = { MANAGER_PIN: '9999', COOK_PIN: '1111' };
  assert.equal(await isReservedPin('9999', env), true, 'the manager recovery PIN');
  assert.equal(await isReservedPin('1111', env), true, 'the cook setup PIN');
  assert.equal(await isReservedPin('4321', env), false);
  assert.equal(await isReservedPin('', env), false);
  assert.equal(await isReservedPin(null, env), false);
});

test('nothing is reserved when no recovery secrets are configured', async () => {
  assert.equal(await isReservedPin('9999', {}), false);
});
