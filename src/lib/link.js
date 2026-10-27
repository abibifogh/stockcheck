/**
 * Insight asking this app something, server to server.
 *
 * The group hub (Insight) builds a management report from every system. It
 * asks this one for its own figures rather than reading the database and
 * working them out a second time, so the report says exactly what the
 * breakfast screens say.
 *
 * Every request is signed with the secret this app already shares with the
 * hub for the sign-in hand-off (INSIGHT_SSO_SECRET here, SSO_SECRET_BREAKFAST
 * there), under a label of its own so a signature made for one purpose cannot
 * be replayed as the other. A request older than five minutes is refused, and
 * so is one whose body was changed on the way. The same scheme as Insight's
 * `bi/src/lib/link.js`: the two must agree.
 */

const LABEL = 'till-link';
const WINDOW_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The headers that prove a request came from the hub (used by the tests). */
export async function signLink(secret, path, bodyText, at = Date.now()) {
  const stamp = String(at);
  return { 'X-Till-At': stamp, 'X-Till-Sig': await hmac(secret, `${LABEL}\n${stamp}\n${path}\n${bodyText}`) };
}

/** Whether a request is from the hub: right secret, right path, recent, unaltered. */
export async function verifyLink(secret, { at, sig, path, bodyText, now = Date.now() }) {
  if (!secret || !at || !sig) return false;
  const stamp = Number(at);
  if (!Number.isFinite(stamp) || Math.abs(now - stamp) > WINDOW_MS) return false;
  return same(await hmac(secret, `${LABEL}\n${at}\n${path}\n${bodyText}`), String(sig));
}
