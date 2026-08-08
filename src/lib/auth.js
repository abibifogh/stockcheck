// PIN login with a signed session cookie.
//
// Each person has their own account and their own PIN. Login is by PIN alone —
// no username — because a cook on a shared tablet should be two taps from the
// entry screen, not filling in a login form. PINs are therefore unique across
// users, which the users table enforces.
//
// The env-var PINs from the original single-tenant setup still work as a
// recovery route (see `recoveryUser`), so an admin who forgets their PIN or
// deactivates the last account can always get back in.

import { isMissingTable } from './http.js';
import { effectivePermissions } from './permissions.js';

const COOKIE = 'bf_session';
const encoder = new TextEncoder();

// Cooks stay signed in on the kitchen tablet; anyone who can see money
// re-authenticates far more often.
const TTL_SECONDS = { cook: 60 * 60 * 24 * 60, manager: 60 * 60 * 12, admin: 60 * 60 * 12 };

function b64urlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createToken(payload, secret) {
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function readToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Hash a PIN for storage and lookup, using the installation's own pepper. */
export async function hashPin(pin, pepper) {
  const key = await hmacKey(`pin:${pepper}`);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(pin)));
  return b64urlEncode(new Uint8Array(sig));
}

export async function getPepper(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'pin_pepper'").first();
  if (row?.value) return row.value;

  // Should already exist from the migration; create it rather than fail if an
  // installation somehow reaches this without one.
  const generated = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('pin_pepper', ?1) ON CONFLICT(key) DO NOTHING",
  ).bind(generated).run();
  const again = await db.prepare("SELECT value FROM settings WHERE key = 'pin_pepper'").first();
  return again?.value ?? generated;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * The break-glass account backed by the MANAGER_PIN worker secret. It exists so
 * that a forgotten PIN or a mistakenly deactivated last admin can never lock
 * the owner out of their own data.
 */
function recoveryUser() {
  return {
    id: 0,
    name: 'Recovery access',
    role: 'admin',
    permissions: null,
    active: 1,
    isRecovery: true,
  };
}

/** Identify the person behind a PIN, or null. */
export async function userForPin(db, pin, env) {
  if (!pin) return null;

  // A missing users table means the database changes have not been applied yet.
  // The setup PINs still have to work in that state, or there is no way to
  // reach the screen that explains the problem.
  let row = null;
  let usersTableExists = true;
  try {
    const pepper = await getPepper(db);
    const hash = await hashPin(pin, pepper);
    row = await db.prepare(
      'SELECT id, name, role, permissions, active FROM users WHERE pin_hash = ?',
    ).bind(hash).first();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    usersTableExists = false;
  }

  if (row) return row.active ? row : null;

  // No matching account. Fall back to the recovery PIN.
  if (env.MANAGER_PIN && await constantTimeEqual(pin, env.MANAGER_PIN)) return recoveryUser();

  // Before anybody has been added, the original cook PIN still opens the entry
  // screen so a fresh installation is usable immediately.
  let anyUsers = 0;
  if (usersTableExists) {
    const counted = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 1').first();
    anyUsers = counted?.n ?? 0;
  }
  if (!anyUsers && env.COOK_PIN && await constantTimeEqual(pin, env.COOK_PIN)) {
    return { id: 0, name: 'Kitchen', role: 'cook', permissions: null, active: 1, isRecovery: true };
  }

  return null;
}

/** Load the signed-in user fresh from the database on every request. */
export async function getSession(request, env, db) {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;

  const token = readCookie(request, COOKIE);
  if (!token) return null;

  const payload = await readToken(token, secret);
  if (!payload) return null;

  // A recovery session carries its identity in the token; there is no row.
  if (payload.recovery) {
    const user = payload.role === 'cook'
      ? { id: 0, name: 'Kitchen', role: 'cook', permissions: null, active: 1, isRecovery: true }
      : recoveryUser();
    return { user, permissions: effectivePermissions(user) };
  }

  // Re-reading means deactivating someone, changing their role or narrowing
  // what they can see takes effect on their very next request rather than
  // whenever their cookie happens to expire.
  let user = null;
  try {
    user = await db.prepare(
      'SELECT id, name, role, permissions, active FROM users WHERE id = ?',
    ).bind(payload.uid).first();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return null; // schema not applied yet — force a fresh sign-in
  }

  if (!user || !user.active) return null;
  return { user, permissions: effectivePermissions(user) };
}

export function sessionCookie(token, role, secure = true) {
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TTL_SECONDS[role] ?? TTL_SECONDS.cook}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(secure = true) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function tokenTtl(role) {
  return TTL_SECONDS[role] ?? TTL_SECONDS.cook;
}

/** Length-independent comparison, so timing never reveals a PIN. */
export async function constantTimeEqual(a, b) {
  const key = await hmacKey('pin-compare');
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign('HMAC', key, encoder.encode(String(a ?? ''))),
    crypto.subtle.sign('HMAC', key, encoder.encode(String(b ?? ''))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Best-effort brute-force brake. Workers isolates are ephemeral and there may
// be several, so this slows an attacker down rather than stopping them.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function throttleCheck(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: now, count: 0 });
    return { allowed: true };
  }
  if (rec.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((rec.first + WINDOW_MS - now) / 1000) };
  }
  return { allowed: true };
}

export function throttleFail(ip) {
  const rec = attempts.get(ip);
  if (rec) rec.count += 1;
  if (attempts.size > 5000) attempts.clear();
}

export function throttleReset(ip) {
  attempts.delete(ip);
}
