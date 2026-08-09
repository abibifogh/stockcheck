// Password stretching, done in the browser.
//
// Cloudflare Workers allow 10ms of CPU per request on the free plan. A properly
// stretched password costs far more than that — 200,000 PBKDF2 rounds is about
// 90ms — so doing it on the server means either a broken login or a work factor
// too low to be worth having.
//
// The browser has no such budget. So the browser does the stretching and sends
// the derived key; the server keeps a keyed hash of that key, which costs
// microseconds. The work factor an attacker must repeat for every guess is
// unchanged, because guessing still means running these rounds.
//
// The raw password never leaves this file.

const ITERATIONS = 600_000;
const KEY_BITS = 256;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((String(text).length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A fresh random salt for a password being set for the first time. */
export function newSalt() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

export const DEFAULT_ITERATIONS = ITERATIONS;

/**
 * Derive the login key the server will see. Given the same password, salt and
 * iteration count this always produces the same key, which is what lets the
 * server verify it without ever holding the password.
 */
export async function deriveLoginKey(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64url(salt), iterations: Number(iterations) || ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return b64url(new Uint8Array(bits));
}

/**
 * Everything needed to store a brand-new password: a fresh salt, the work
 * factor used, and the derived key. The server stores all three — the salt and
 * iteration count are not secret, they only have to be remembered.
 */
export async function prepareNewPassword(password) {
  const salt = newSalt();
  return {
    passwordSalt: salt,
    passwordIterations: ITERATIONS,
    passwordKey: await deriveLoginKey(password, salt, ITERATIONS),
  };
}
