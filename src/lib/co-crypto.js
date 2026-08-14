/**
 * Hashing, sealing and encryption for the correspondence register.
 *
 * Three jobs, all built on the one keyed primitive the Workers runtime gives
 * us for free — HMAC-SHA-256 — plus AES-GCM for the file bytes:
 *
 *   The audit chain.  Each event carries the hash of the one before it, so a
 *   row edited or deleted in a console breaks the chain at a point the
 *   verification screen can name.
 *
 *   The document seal.  A digest of a letter's exact subject, body and
 *   attachment hashes, keyed with a secret that lives in the Worker rather
 *   than the database. A copy of the database alone cannot mint one, which is
 *   what makes a signature mean something.
 *
 *   Attachments at rest.  Files are AES-GCM encrypted before they reach R2, so
 *   the bucket holds ciphertext. The key is derived per attachment from the
 *   installation secret and the object's own key, so one leaked object cannot
 *   open the rest.
 *
 * The secret is `DOC_SECRET` where one is set, falling back to `SESSION_SECRET`
 * so an installation works before anybody has thought about it. Rotating
 * `DOC_SECRET` invalidates every existing seal — which is why the two are
 * separate variables, and why the README says to set it once and leave it.
 */

const encoder = new TextEncoder();

function secretOf(env) {
  const secret = env?.DOC_SECRET || env?.SESSION_SECRET;
  if (!secret) throw new Error('No DOC_SECRET or SESSION_SECRET is set');
  return secret;
}

function b64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret, usage = ['sign', 'verify']) {
  return crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage,
  );
}

/** Keyed digest of a string, as hex. The one primitive everything else uses. */
export async function keyedDigest(env, domain, value) {
  const key = await hmacKey(`${domain}:${secretOf(env)}`);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value))));
}

/** Unkeyed SHA-256 of bytes, as hex. Used for "is this the same file". */
export async function sha256(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// ---------------------------------------------------------------------------
// The audit chain
// ---------------------------------------------------------------------------

/**
 * The canonical string an event hashes over.
 *
 * Field order and separator are fixed here and nowhere else. Change either and
 * every existing chain fails to verify, which is the correct outcome — but it
 * has to be a deliberate one, so this lives alone in a function with a name.
 */
function eventPayload({ letterId, at, actor, action, detail, prevHash }) {
  return [
    'v1',
    String(letterId),
    String(at ?? ''),
    String(actor ?? ''),
    String(action ?? ''),
    // Detail is JSON, and two objects that differ only in key order should not
    // produce two different hashes. Stringifying whatever the caller passed
    // would; a stable form of it does not.
    stableJson(detail),
    String(prevHash ?? ''),
  ].join('␟');
}

/** JSON with object keys in sorted order, so the same data hashes the same. */
export function stableJson(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

export async function eventHash(env, event) {
  return keyedDigest(env, 'co-event', eventPayload(event));
}

// ---------------------------------------------------------------------------
// Document seals
// ---------------------------------------------------------------------------

/**
 * What a signature is over: the letter as it stands, and every file attached.
 *
 * Attachments are folded in by their own SHA-256 and sorted, so swapping the
 * scanned page behind a signed letter changes the digest even though no row in
 * `co_letters` moved. Sorting matters because the order rows come back in is
 * the database's business, not the document's.
 */
export function contentDigestPayload(letter, attachments = []) {
  const files = attachments
    .map((a) => `${a.sha256 ?? ''}:${a.name ?? ''}:${a.size ?? 0}`)
    .sort();
  return stableJson({
    v: 1,
    ref: letter.ref,
    type: letter.type,
    subject: letter.subject,
    body: letter.body ?? '',
    party: letter.party_id ?? null,
    letterDate: letter.letter_date ?? null,
    files,
  });
}

export async function contentDigest(env, letter, attachments = []) {
  return keyedDigest(env, 'co-content', contentDigestPayload(letter, attachments));
}

/** The seal placed under a signature: a keyed digest of the content digest. */
export async function sealFor(env, contentHash, signer) {
  return keyedDigest(env, 'co-seal', `${contentHash}|${signer.userId ?? 0}|${signer.name}|${signer.at}`);
}

export async function sealMatches(env, contentHash, signer, seal) {
  const expected = await sealFor(env, contentHash, signer);
  return timingSafeEqual(expected, String(seal ?? ''));
}

/** Length-independent string comparison. */
export function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Attachments at rest
// ---------------------------------------------------------------------------

/**
 * The AES key for one stored object.
 *
 * Derived from the installation secret and the object's own storage key, so
 * every attachment has a different key and none of them is written down. There
 * is nothing to rotate per file and nothing to lose: the same inputs always
 * produce the same key.
 */
async function fileKey(env, storageKey) {
  const material = await keyedDigest(env, 'co-file', storageKey); // 64 hex chars
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(material.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt for storage. The 12-byte IV is prepended to the ciphertext, which is
 * the ordinary way to do this and means the stored object is self-contained.
 */
export async function encryptBytes(env, storageKey, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await fileKey(env, storageKey);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

export async function decryptBytes(env, storageKey, stored) {
  const bytes = new Uint8Array(stored);
  if (bytes.length < 13) throw new Error('Stored file is too short to be encrypted');
  const key = await fileKey(env, storageKey);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12),
  );
  return new Uint8Array(plain);
}

/** A storage key nobody can guess, namespaced by what it belongs to. */
export function newStorageKey(scope, id, filename) {
  const random = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const safe = String(filename ?? 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-60) || 'file';
  return `${scope}/${id}/${random}-${safe}`;
}

// ---------------------------------------------------------------------------
// Small secrets kept where they can be read back
// ---------------------------------------------------------------------------

/**
 * Encrypt a short string so it can be recovered later.
 *
 * There is exactly one thing this is for: the signing link in an unfinished
 * request. A reminder three days on has to carry the *same* link the first
 * email did — a client who goes back to the original message and finds it dead
 * is a client who telephones instead of signing.
 *
 * The trade this makes, stated plainly: a signing link is recoverable from the
 * database **plus `DOC_SECRET`**, where before it was recoverable from neither.
 * That is the same protection attachments already have, and the same reason the
 * setup guide says to keep `DOC_SECRET` somewhere the database backups are not.
 * Lookup never touches this — that still goes through the hash — so a stolen
 * database on its own is still not a set of working links.
 */
export async function sealSecret(env, value) {
  if (value == null || value === '') return null;
  const key = await secretKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(String(value)),
  ));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return b64url(out);
}

/** The other half. Returns null for anything that will not open. */
export async function openSecret(env, sealed) {
  if (!sealed) return null;
  try {
    const bytes = unb64url(sealed);
    if (bytes.length < 13) return null;
    const key = await secretKey(env);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // A value sealed under a different DOC_SECRET, or a truncated one. Null
    // rather than a throw: the caller's job is to say "reissue the link", not
    // to fall over.
    return null;
  }
}

async function secretKey(env) {
  const material = await keyedDigest(env, 'co-sealed-secret', 'v1');
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(material.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function unb64url(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((String(text).length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
