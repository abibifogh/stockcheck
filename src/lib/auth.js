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

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------
//
// Administrators sign in with an email address and a real password rather than
// a PIN. A PIN is the right trade-off for a cook at a tablet with flour on
// their hands; it is the wrong one for an account that can see every cost,
// manage people and erase data.
//
// Passwords are stretched with PBKDF2-SHA256. The iteration count is stored
// alongside each hash, so it can be raised later without invalidating anyone's
// existing password.

// The browser derives a key from the password (see public/js/crypto.js) and
// sends that. All the server does is keep a keyed hash of it, which costs
// microseconds and fits comfortably inside a Worker's CPU budget.
//
// Stored as:  pbkdf2c$1$<iterations>$<salt>$<hmac>
//
// The salt and iteration count are not secret; they are recorded so the browser
// can reproduce the same derivation at sign-in. The hash is keyed with the
// installation's pepper, so a stolen database still has to be attacked one
// guess at a time — and every guess costs the full 600,000 rounds, because that
// is where the work actually happens.

const PASSWORD_VERSION = '1';
export const DEFAULT_PASSWORD_ITERATIONS = 600_000;

async function pepperHmac(value, pepper) {
  const key = await hmacKey(`password:${pepper}`);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(value)));
  return b64urlEncode(new Uint8Array(sig));
}

/**
 * Build the stored value from what the browser derived.
 * `salt` and `iterations` come from the browser and are kept verbatim.
 */
export async function storedPassword({ passwordKey, salt, iterations }, pepper) {
  const hmac = await pepperHmac(passwordKey, pepper);
  return `pbkdf2c$${PASSWORD_VERSION}$${Number(iterations) || DEFAULT_PASSWORD_ITERATIONS}$${salt}$${hmac}`;
}

/** The salt and work factor recorded in a stored password, or null. */
export function passwordParams(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('pbkdf2c$')) return null;
  const [, , iterations, salt] = stored.split('$');
  if (!iterations || !salt) return null;
  return { iterations: Number(iterations), salt };
}

/** Constant-time check of a browser-derived key against a stored password. */
export async function verifyPasswordKey(passwordKey, stored, pepper) {
  const params = passwordParams(stored);
  if (!params || !passwordKey) return false;

  const expected = stored.split('$')[4];
  const actual = await pepperHmac(passwordKey, pepper);
  if (!expected || expected.length !== actual.length) return false;

  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The salt to derive with for a given address.
 *
 * An address with no account still gets a salt — a stable one derived from the
 * address itself — so that asking for a salt never reveals who has an account.
 */
export async function saltForEmail(db, email, pepper) {
  const normalised = normaliseEmail(email);

  let row = null;
  try {
    row = await db.prepare('SELECT password_hash FROM users WHERE email = ? AND active = 1')
      .bind(normalised).first();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  const params = row ? passwordParams(row.password_hash) : null;
  if (params) return params;

  const key = await hmacKey(`salt:${pepper}`);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(normalised));
  return {
    salt: b64urlEncode(new Uint8Array(sig).slice(0, 16)),
    iterations: DEFAULT_PASSWORD_ITERATIONS,
  };
}

export function normaliseEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Sign in with an email address and password. Used by administrators, and
 * available to anyone else who has credentials set.
 */
export async function userForCredentials(db, email, passwordKey) {
  if (!email || !passwordKey) return null;

  let row = null;
  try {
    row = await db.prepare(
      'SELECT id, name, role, permissions, active, email, password_hash FROM users WHERE email = ?',
    ).bind(normaliseEmail(email)).first();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    return null;
  }

  const pepper = await getPepper(db);

  // Compare even when no account matched, so a wrong address and a wrong
  // password take the same path and the same time.
  const stored = row?.password_hash ?? `pbkdf2c$1$1$AAAAAAAAAAAAAAAAAAAAAA$${'A'.repeat(43)}`;
  const valid = await verifyPasswordKey(passwordKey, stored, pepper);

  if (!row || !valid || !row.active) return null;
  const { password_hash: _ignored, ...user } = row;
  return user;
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

/**
 * Is this PIN reserved by the server's recovery secrets?
 *
 * A user PIN that matched one of them would shadow it — the users table is
 * consulted first — silently destroying the owner's way back in. Refusing the
 * collision is what keeps the emergency route emergency-proof.
 *
 * Callers must report this with exactly the same wording as "already in use by
 * someone else". Two different messages would let anyone with an account probe
 * for the recovery PIN one guess at a time.
 */
export async function isReservedPin(pin, env) {
  if (!pin) return false;
  if (env.MANAGER_PIN && await constantTimeEqual(pin, env.MANAGER_PIN)) return true;
  if (env.COOK_PIN && await constantTimeEqual(pin, env.COOK_PIN)) return true;
  return false;
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

  if (row) {
    if (!row.active) return null;
    // An administrator's PIN, if one was ever set, is not a way in. The whole
    // point of giving them a password is that a short code is not enough.
    if (row.role === 'admin') return null;
    return row;
  }

  // No matching account. Fall back to the recovery PIN, unless it has been
  // switched off — which an administrator can do once they have credentials
  // and no longer want a PIN that reaches everything.
  let recoveryAllowed = true;
  try {
    const setting = await db.prepare("SELECT value FROM settings WHERE key = 'allow_recovery_pin'").first();
    recoveryAllowed = setting?.value !== '0';
  } catch { /* setting missing: leave the way in open */ }

  if (recoveryAllowed && env.MANAGER_PIN && await constantTimeEqual(pin, env.MANAGER_PIN)) {
    return recoveryUser();
  }

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
      'SELECT id, name, email, role, permissions, active FROM users WHERE id = ?',
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
