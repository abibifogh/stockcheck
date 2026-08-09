import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PASSWORD_ITERATIONS, hashPin, isReservedPin, normaliseEmail,
  passwordParams, storedPassword, verifyPasswordKey,
} from '../src/lib/auth.js';

/**
 * Passwords are stretched in the browser and the server keeps a keyed hash of
 * the result. A Worker gets 10ms of CPU on the free plan; stretching properly
 * costs roughly ten times that, so doing it server-side means either a broken
 * login or a work factor not worth having.
 */

const PEPPER = 'installation-pepper';
const SALT = 'AAAAAAAAAAAAAAAAAAAAAA';

const make = (passwordKey, opts = {}) => storedPassword(
  { passwordKey, salt: opts.salt ?? SALT, iterations: opts.iterations ?? DEFAULT_PASSWORD_ITERATIONS },
  opts.pepper ?? PEPPER,
);

test('the derived key verifies, and a different one does not', async () => {
  const stored = await make('derived-key-from-the-browser');
  assert.equal(await verifyPasswordKey('derived-key-from-the-browser', stored, PEPPER), true);
  assert.equal(await verifyPasswordKey('a-different-derived-key', stored, PEPPER), false);
  assert.equal(await verifyPasswordKey('', stored, PEPPER), false);
});

test('verifying is cheap enough for a Worker', async () => {
  const stored = await make('derived-key-from-the-browser');
  const started = process.hrtime.bigint();
  await verifyPasswordKey('derived-key-from-the-browser', stored, PEPPER);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 5, `verification took ${ms.toFixed(1)}ms, which must stay far below the 10ms budget`);
});

test('the stored value records how to reproduce the derivation', async () => {
  const stored = await make('key', { salt: 'abcdEFGH1234', iterations: 600000 });
  const params = passwordParams(stored);
  assert.equal(params.salt, 'abcdEFGH1234');
  assert.equal(params.iterations, 600000);
  assert.ok(stored.startsWith('pbkdf2c$1$'), 'the format is versioned so it can be changed later');
});

test('a stolen database is useless without the installation pepper', async () => {
  const stored = await make('derived-key-from-the-browser');
  assert.equal(await verifyPasswordKey('derived-key-from-the-browser', stored, 'wrong-pepper'), false);
});

test('the same key under different salts stores differently', async () => {
  const a = await make('same-key', { salt: 'saltOneAAAAAAAAAAAAAAA' });
  const b = await make('same-key', { salt: 'saltTwoBBBBBBBBBBBBBBB' });
  assert.notEqual(a, b);
});

test('a malformed or missing stored password fails closed', async () => {
  assert.equal(await verifyPasswordKey('anything', null, PEPPER), false);
  assert.equal(await verifyPasswordKey('anything', '', PEPPER), false);
  assert.equal(await verifyPasswordKey('anything', 'plaintext', PEPPER), false);
  assert.equal(await verifyPasswordKey('anything', 'pbkdf2c$1$broken', PEPPER), false);
  assert.equal(passwordParams('nonsense'), null);
});

test('email addresses are compared without case or spacing mattering', () => {
  assert.equal(normaliseEmail('  Micheal@NiceOperation.com '), 'micheal@niceoperation.com');
  assert.equal(normaliseEmail(null), '');
});

// ---------------------------------------------------------------- PINs ----

test('the same PIN hashes to the same value, so login is a single lookup', async () => {
  assert.equal(await hashPin('4321', 'pepper'), await hashPin('4321', 'pepper'));
});

test('two installations with the same PIN produce different hashes', async () => {
  assert.notEqual(await hashPin('4321', 'pepper-one'), await hashPin('4321', 'pepper-two'));
});

test('a PIN matching a server recovery secret is reserved', async () => {
  const env = { MANAGER_PIN: '9999', COOK_PIN: '1111' };
  assert.equal(await isReservedPin('9999', env), true);
  assert.equal(await isReservedPin('1111', env), true);
  assert.equal(await isReservedPin('4321', env), false);
  assert.equal(await isReservedPin(null, env), false);
});

test('nothing is reserved when no recovery secrets are configured', async () => {
  assert.equal(await isReservedPin('9999', {}), false);
});
