// PIN login with a signed session cookie.
//
// Two roles: `cook` can read the catalogue and write the day sheet; `manager`
// can do everything. PINs live in Worker secrets rather than the database so
// there is no user table to manage and no password reset flow for a kitchen to
// get stuck in.

const COOKIE = 'bf_session';
const encoder = new TextEncoder();

const ROLE_RANK = { cook: 1, manager: 2 };
// Cooks stay signed in on the kitchen tablet; managers re-auth more often.
const TTL_SECONDS = { cook: 60 * 60 * 24 * 60, manager: 60 * 60 * 12 };

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

/** Length-independent comparison, so timing never reveals the PIN. */
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

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function getSession(request, env) {
  const secret = env.SESSION_SECRET;
  if (!secret) return null;
  const token = readCookie(request, COOKIE);
  return token ? readToken(token, secret) : null;
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

export function hasRole(session, required) {
  if (!session?.role) return false;
  return (ROLE_RANK[session.role] ?? 0) >= (ROLE_RANK[required] ?? 99);
}

/**
 * Identify a PIN. Returns the highest role it unlocks, or null.
 * The manager PIN is checked first so that setting both to the same value
 * grants the stronger role rather than silently locking the manager out.
 */
export async function roleForPin(pin, env) {
  if (!pin) return null;
  if (env.MANAGER_PIN && await constantTimeEqual(pin, env.MANAGER_PIN)) return 'manager';
  if (env.COOK_PIN && await constantTimeEqual(pin, env.COOK_PIN)) return 'cook';
  return null;
}

export function tokenTtl(role) {
  return TTL_SECONDS[role] ?? TTL_SECONDS.cook;
}

// Best-effort brute-force brake. Workers isolates are ephemeral and there may
// be several, so this slows an attacker down rather than stopping them; the
// real protection is that a PIN is only useful with the site URL.
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
