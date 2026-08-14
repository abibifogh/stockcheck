/**
 * Envelopes: sending a document out for signature to people with no account.
 *
 * An engagement letter goes to a client; an audit confirmation goes to a bank.
 * Neither of them will create an account in an accounting firm's correspondence
 * system, and asking them to is how a signed engagement letter becomes a
 * printed page, a wet signature and a photograph taken on a phone.
 *
 * So an envelope holds one document, a list of people, and the order they act
 * in. Each person gets a link that is theirs alone. They open it, read what
 * they are signing, agree to sign electronically, sign, and that is the whole
 * interaction.
 *
 * The rules that everything else follows from:
 *
 *   Sending freezes the document.  The content hash is taken at that moment and
 *   every signature is sealed against it, so four people signing over three
 *   weeks have signed one document rather than four.
 *
 *   The link is the identity, and only its hash is stored.  A copy of the
 *   database is not a working set of links. A lost link is reissued, never
 *   recovered — and reissuing invalidates the old one.
 *
 *   Everything is recorded, including what is not an action.  Sent, opened,
 *   signed, declined, reminded, expired: with the address, the time, the
 *   network address and the browser. That record is what makes the signature
 *   worth anything six months later.
 */

import { badRequest, forbidden } from './http.js';
import { keyedDigest, sealFor } from './co-crypto.js';
import { currentDigest, isoStamp, nowStamp, recordEvent } from './correspondence.js';

const encoder = new TextEncoder();

export const ENVELOPE_STATUSES = ['draft', 'sent', 'completed', 'declined', 'voided', 'expired'];
export const RECIPIENT_ROLES = ['signer', 'approver', 'viewer'];
export const SIGNATURE_METHODS = ['typed', 'drawn', 'uploaded'];
export const ROUTINGS = ['sequential', 'parallel'];

/** Statuses in which an envelope is still asking somebody for something. */
export const LIVE_ENVELOPE = new Set(['draft', 'sent']);

/** A recipient who has finished with it, whichever way. */
const SETTLED = new Set(['signed', 'declined', 'cancelled']);

function b64url(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A link token, and the hash of it that is all we keep.
 *
 * 24 random bytes. No salt and no stretching: this is a 192-bit random string,
 * not a password, so there is nothing to guess and nothing to look up.
 */
export function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(24)));
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token)));
  return b64url(new Uint8Array(digest));
}

/**
 * The access code is short enough to read down a telephone, so unlike the token
 * it *is* guessable and has to be treated like a password: keyed, and never
 * compared in a way that leaks its length.
 */
export async function hashAccessCode(env, code) {
  if (!code) return null;
  return keyedDigest(env, 'co-access-code', String(code).trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

/**
 * Turn the recipient list from a form into rows, minting a token for each.
 *
 * Returns the rows to insert *and* the plain tokens, which is the only moment
 * they exist. The caller hands them to whoever is sending the envelope; after
 * that the only way back to a working link is to reissue it.
 */
export async function prepareRecipients(env, recipients) {
  if (!Array.isArray(recipients) || !recipients.length) {
    throw badRequest('An envelope needs at least one recipient');
  }
  if (recipients.length > 25) {
    throw badRequest('That is more than 25 recipients. Split it into two envelopes.');
  }

  const prepared = [];
  let seq = 0;

  for (const person of recipients) {
    const name = String(person.name ?? '').trim();
    if (!name) throw badRequest('Every recipient needs a name');
    if (name.length > 200) throw badRequest('That name is too long');

    const role = RECIPIENT_ROLES.includes(person.role) ? person.role : 'signer';
    const email = String(person.email ?? '').trim();
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      throw badRequest(`"${email}" does not look like an email address`);
    }
    // A signer with no address cannot be sent anything, and the link would have
    // to be delivered by hand. That is allowed — some confirmations genuinely
    // go by courier — but it is worth being deliberate about.
    seq += 1;

    prepared.push({
      seq,
      role,
      name,
      email: email || null,
      title: String(person.title ?? '').trim().slice(0, 120) || null,
      partyId: person.partyId ? Number(person.partyId) : null,
      accessCode: person.accessCode ? String(person.accessCode).trim().toUpperCase().slice(0, 24) : null,
      token: newToken(),
    });
  }

  const codes = await Promise.all(prepared.map((r) => hashAccessCode(env, r.accessCode)));
  return prepared.map((r, i) => ({ ...r, accessCodeHash: codes[i] }));
}

/**
 * Who should be holding the envelope right now.
 *
 * Parallel: everybody who has not finished. Sequential: the lowest sequence
 * number that has not finished, and nobody after them — which is what makes a
 * countersigned agreement work, and what stops the second director signing a
 * document the first has not yet agreed to.
 *
 * Viewers never take a turn. Nothing is being asked of them, so they get their
 * copy the moment the envelope goes out and the queue never waits on them —
 * an engagement letter outstanding for a fortnight because somebody copied in
 * never opened their email is not a thing anybody wants to explain.
 */
export function activeRecipients(envelope, recipients) {
  const outstanding = recipients.filter((r) => !SETTLED.has(r.status));
  if (!outstanding.length) return [];
  if (envelope.routing === 'parallel') return outstanding;

  const actors = outstanding.filter((r) => r.role !== 'viewer');
  if (!actors.length) return outstanding;

  const turn = Math.min(...actors.map((r) => r.seq));
  return outstanding.filter((r) => r.role === 'viewer' || r.seq <= turn);
}

/** Is this recipient allowed to act right now? */
export function isTheirTurn(envelope, recipients, recipient) {
  return activeRecipients(envelope, recipients).some((r) => r.id === recipient.id);
}

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

/**
 * Record something that happened to an envelope.
 *
 * Never throws at its caller. The certificate describes work that has already
 * happened; failing to write a line of it must not undo the signature it was
 * describing.
 */
export async function recordEnvelopeEvent(db, envelopeId, {
  recipientId = null, actor, action, detail = null, ip = null, userAgent = null,
}) {
  try {
    await db.prepare(
      `INSERT INTO co_envelope_events (envelope_id, recipient_id, actor, action, detail, ip, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      envelopeId,
      recipientId,
      String(actor ?? 'system').slice(0, 200),
      String(action).slice(0, 60),
      detail == null ? null : JSON.stringify(detail),
      ip ? String(ip).slice(0, 60) : null,
      userAgent ? String(userAgent).slice(0, 300) : null,
    ).run();
  } catch (err) {
    console.error('envelope event not recorded', err);
  }
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Place a signature from outside the firm.
 *
 * Sealed against the envelope's own content hash rather than the document as it
 * stands. If the two ever differ, the document moved after the envelope went
 * out — which is exactly the thing worth being able to detect, and would be
 * invisible if each signature simply re-hashed whatever it found.
 */
export async function sealExternal(env, envelope, recipient, { name, at }) {
  return sealFor(env, envelope.content_hash, {
    // Not a user id, because this is somebody outside the firm — and not zero
    // either, because zero is the emergency account. Naming the recipient row
    // makes an external signature impossible to confuse with an internal one,
    // and `externalSigner` below is the single place that shape is written.
    userId: externalSigner(recipient.id),
    name,
    at,
  });
}

/**
 * The identity an external seal is computed over.
 *
 * Exported because verification has to rebuild it exactly, and a second copy of
 * this string somewhere else is a signature that stops verifying the day
 * somebody changes one of them.
 */
export function externalSigner(recipientId) {
  return `ext:${recipientId}`;
}

/**
 * Is the envelope finished, and how?
 *
 * Viewers are not waited for. Somebody copied in who never opens their link is
 * a fact for the certificate, not a reason an engagement letter stays
 * outstanding for ever.
 */
export function envelopeOutcome(recipients) {
  if (recipients.some((r) => r.status === 'declined')) return 'declined';
  const actors = recipients.filter((r) => r.role !== 'viewer');
  if (!actors.length) return null;
  return actors.every((r) => r.status === 'signed' || r.status === 'cancelled')
    ? 'completed'
    : null;
}

/**
 * Close an envelope, and say so on the letter it belongs to.
 *
 * A completed envelope seals the letter: what went out for signature is now
 * what was signed, and the text must not move underneath it afterwards.
 */
export async function closeEnvelope(db, env, envelope, letter, outcome, reason = null) {
  const at = nowStamp();

  await db.prepare(
    `UPDATE co_envelopes
        SET status = ?1,
            completed_at = CASE WHEN ?1 = 'completed' THEN ?2 ELSE completed_at END,
            closed_reason = ?3
      WHERE id = ?4`,
  ).bind(outcome, at, reason, envelope.id).run();

  // Anybody still holding a link has nothing left to do with it.
  await db.prepare(
    `UPDATE co_envelope_recipients SET status = 'cancelled'
      WHERE envelope_id = ? AND status IN ('pending','invited','viewed')`,
  ).bind(envelope.id).run();

  if (outcome === 'completed') {
    await db.prepare(
      `UPDATE co_letters
          SET sealed_at = COALESCE(sealed_at, ?1), content_hash = ?2, updated_at = datetime('now')
        WHERE id = ?3`,
    ).bind(at, envelope.content_hash, letter.id).run();
  }

  await recordEvent(db, env, letter.id, {
    actor: 'Signing',
    action: `envelope.${outcome}`,
    detail: { envelope: envelope.ref, reason },
  });
}

/**
 * Does this letter have an envelope out for signature?
 *
 * Used to refuse edits. A document whose text can change while it is sitting in
 * somebody's inbox waiting to be signed is a document nobody should sign.
 */
export async function openEnvelopeFor(db, letterId) {
  return db.prepare(
    "SELECT * FROM co_envelopes WHERE letter_id = ? AND status IN ('draft','sent') ORDER BY id DESC LIMIT 1",
  ).bind(letterId).first().catch(() => null);
}

export async function assertNoOpenEnvelope(db, letter) {
  const envelope = await openEnvelopeFor(db, letter.id);
  if (!envelope) return;
  throw badRequest(
    envelope.status === 'sent'
      ? `${envelope.ref} is out for signature, so this document cannot be changed. `
        + 'Void that envelope first if the text is wrong — anybody holding a link will be told.'
      : `${envelope.ref} is a draft envelope against this document. `
        + 'Send it or delete it before changing the text.',
  );
}

// ---------------------------------------------------------------------------
// Resolving a link
// ---------------------------------------------------------------------------

/**
 * A gentle throttle on the public endpoints.
 *
 * Not the security boundary — the token is that. This exists so a link opened
 * in a loop, or somebody idly guessing, cannot burn through the day's request
 * budget or grind at an access code.
 */
const attempts = new Map();

/**
 * Counted per purpose as well as per address.
 *
 * One shared counter meant that reading the document — which happens on every
 * page load, and again after every action — ate the budget for actually
 * signing, so a careful recipient who read the attachments twice found they
 * could no longer sign at all.
 */
export function throttleSigning(ip, limit = 60, purpose = 'open') {
  const key = `${purpose}:${ip}`;
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.since > 60_000) {
    attempts.set(key, { since: now, count: 1 });
    return true;
  }
  record.count += 1;
  if (attempts.size > 500) attempts.clear();
  return record.count <= limit;
}

/** For tests, which would otherwise carry one test's counter into the next. */
export function resetSigningThrottle() {
  attempts.clear();
}

/**
 * Resolve a token to the recipient it belongs to, or null.
 *
 * Null for anything unknown, cancelled, finished or expired — the caller must
 * not be able to tell those apart from the outside, or the endpoint becomes a
 * way of discovering which links exist.
 */
export async function recipientForToken(db, token) {
  const value = String(token ?? '').trim();
  if (!value || value.length > 128) return null;

  const recipient = await db.prepare(
    'SELECT * FROM co_envelope_recipients WHERE token_hash = ?',
  ).bind(await hashToken(value)).first();
  if (!recipient) return null;

  const envelope = await db.prepare('SELECT * FROM co_envelopes WHERE id = ?')
    .bind(recipient.envelope_id).first();
  if (!envelope) return null;

  const letter = await db.prepare('SELECT * FROM co_letters WHERE id = ?')
    .bind(envelope.letter_id).first();
  if (!letter) return null;

  return { recipient, envelope, letter };
}

/**
 * Why a link will not open, in words a recipient can act on.
 *
 * Deliberately specific once the token itself has checked out: at that point
 * the holder has proved they were sent it, and "this was withdrawn on Tuesday"
 * is far more use to them than a blank refusal.
 */
export function signingBlockedReason(envelope, recipient, now = new Date()) {
  // Their own decline first — it is about them, and they already know.
  if (recipient.status === 'declined') {
    return 'You have already declined to sign this.';
  }
  // Then the envelope, before the recipient's `cancelled`. Closing an envelope
  // cancels every outstanding recipient, so checking the recipient first would
  // replace "the wrong version went out" with a blank refusal in exactly the
  // case where the reason is the useful part.
  if (envelope.status === 'voided') {
    return `This request was withdrawn${envelope.closed_reason ? `: ${envelope.closed_reason}` : '.'}`;
  }
  if (envelope.status === 'declined') {
    return 'This request was ended because somebody else declined to sign.';
  }
  if (envelope.status === 'expired') {
    return 'This link has expired. Ask the firm to send a new one.';
  }
  if (envelope.status === 'draft') {
    return 'This request has not been sent yet.';
  }
  if (recipient.status === 'cancelled') {
    return 'This request has been withdrawn. Please contact the firm if you were expecting it.';
  }
  if (envelope.expires_at && new Date(envelope.expires_at) < now) {
    return 'This link has expired. Ask the firm to send a new one.';
  }
  return null;
}

export async function checkAccessCode(env, recipient, supplied) {
  if (!recipient.access_code_hash) return true;
  const given = await hashAccessCode(env, supplied);
  if (!given) return false;
  // Both are fixed-length keyed digests, so a plain comparison leaks nothing
  // about the code itself.
  return given === recipient.access_code_hash;
}

/** The document as the recipient should see it, and nothing more. */
export async function documentFor(db, env, envelope, letter) {
  const files = await db.prepare(
    'SELECT id, name, mime, size, sha256 FROM co_attachments WHERE letter_id = ? ORDER BY id',
  ).bind(letter.id).all().catch(() => ({ results: [] }));

  // The digest as it stands now, against what the envelope froze. They should
  // agree; the signing page says so if they do not, because a recipient is
  // entitled to know the document moved after it was sent to them.
  const current = await currentDigest(db, env, letter);

  return {
    ref: letter.ref,
    subject: letter.subject,
    body: letter.body ?? '',
    letterDate: letter.letter_date ?? null,
    attachments: files.results ?? [],
    unchanged: current === envelope.content_hash,
  };
}

/** A stamp `days` from now, or null when the caller asked for no expiry. */
export function inDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return isoStamp(new Date(Date.now() + n * 86_400_000));
}

export function assertLive(envelope) {
  if (!LIVE_ENVELOPE.has(envelope.status)) {
    throw forbidden(`${envelope.ref} is ${envelope.status} and can no longer be changed.`);
  }
}
