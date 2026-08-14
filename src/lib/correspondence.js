/**
 * The correspondence register.
 *
 * Everything that decides what a letter *is* lives here: how it gets its
 * reference number, who is allowed to see it, what a deadline means when the
 * office is shut at the weekend, and how the audit trail is written so that it
 * can later be checked.
 *
 * The route handlers above this file do validation and shape the JSON. They do
 * not decide any of the above, because two handlers deciding the same thing
 * differently is how a register ends up with two letters numbered IN-2026-0041.
 */

import { badRequest, forbidden, notFound } from './http.js';
import { contentDigest, eventHash, keyedDigest } from './co-crypto.js';

export const LETTER_TYPES = [
  { key: 'incoming', label: 'Incoming', prefix: 'IN', detail: 'Received from a client or third party' },
  { key: 'outgoing', label: 'Outgoing', prefix: 'OUT', detail: 'Sent by the firm' },
  { key: 'memo', label: 'Internal memo', prefix: 'MEM', detail: 'Inside the firm' },
  { key: 'circular', label: 'Circular', prefix: 'CIR', detail: 'To everybody at once' },
];

export const TYPE_KEYS = LETTER_TYPES.map((t) => t.key);
export const TYPE_MAP = new Map(LETTER_TYPES.map((t) => [t.key, t]));

export const STATUSES = [
  'draft', 'registered', 'in_progress', 'awaiting_approval',
  'approved', 'dispatched', 'closed', 'cancelled',
];

/** Statuses that mean nobody is waiting on this any more. */
export const CLOSED_STATUSES = new Set(['closed', 'cancelled']);

export const ROUTE_ACTIONS = [
  { key: 'action', label: 'For action', detail: 'Do what the letter asks and report back' },
  { key: 'review', label: 'For review', detail: 'Read and comment before it goes further' },
  { key: 'approve', label: 'For approval', detail: 'Approve or reject. Blocks dispatch.' },
  { key: 'sign', label: 'For signature', detail: 'Sign the document. Blocks dispatch.' },
  { key: 'information', label: 'For information', detail: 'No reply expected' },
];

export const ACTION_KEYS = ROUTE_ACTIONS.map((a) => a.key);

/** The two that hold a letter back: it cannot be dispatched while one is open. */
export const BLOCKING_ACTIONS = new Set(['approve', 'sign']);

export const CONFIDENTIALITY = ['normal', 'confidential', 'restricted'];
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const CHANNELS = ['email', 'post', 'courier', 'hand', 'fax', 'portal'];

export const ENGAGEMENT_TYPES = [
  'audit', 'tax', 'payroll', 'bookkeeping', 'advisory', 'secretarial', 'other',
];

export const CASE_STATUSES = ['planned', 'active', 'review', 'on_hold', 'completed', 'archived'];
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
export const RECURRENCES = ['none', 'daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function coSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all().catch(() => ({ results: [] }));
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return {
    firmName: map.co_firm_name || 'The Practice',
    refDigits: clampInt(map.co_ref_digits, 4, 3, 8),
    escalationGrace: clampInt(map.co_escalation_grace, 24, 0, 720),
    reminderLead: clampInt(map.co_reminder_lead, 24, 0, 720),
    defaultDueHours: clampInt(map.co_default_due_hours, 72, 1, 8760),
    workingDays: parseWorkingDays(map.co_working_days),
    sweepEnabled: map.co_sweep_enabled !== '0',
    timezone: map.timezone || 'UTC',
    raw: map,
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** '1,2,3,4,5' → Set of ISO weekday numbers. An empty list means every day. */
function parseWorkingDays(value) {
  const days = String(value ?? '1,2,3,4,5')
    .split(',')
    .map((d) => Number.parseInt(d.trim(), 10))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return new Set(days.length ? days : [1, 2, 3, 4, 5, 6, 7]);
}

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------

/**
 * Issue the next reference for a prefix and year: TAX-2026-0007.
 *
 * Taken from a counter row rather than `MAX(ref) + 1`. The maximum of a table
 * somebody has deleted from goes down, and a register that issues the same
 * reference twice is worse than one that skips a number — a skipped number is a
 * question, a repeated one is two different letters filed as the same letter.
 *
 * `UPDATE ... RETURNING` is a single statement, so two requests arriving
 * together get two different numbers even though D1 has no transactions we can
 * hold open across awaits.
 */
export async function nextRef(db, prefix, { year = new Date().getUTCFullYear(), digits = 4 } = {}) {
  const clean = String(prefix || 'GEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'GEN';

  await db.prepare(
    'INSERT INTO co_numbering (prefix, year, next) VALUES (?1, ?2, 1) ON CONFLICT(prefix, year) DO NOTHING',
  ).bind(clean, year).run();

  const row = await db.prepare(
    'UPDATE co_numbering SET next = next + 1 WHERE prefix = ?1 AND year = ?2 RETURNING next',
  ).bind(clean, year).first();

  // `next` came back already incremented, so the number we just claimed is the
  // one before it.
  const claimed = Number(row?.next ?? 2) - 1;
  return `${clean}-${year}-${String(claimed).padStart(digits, '0')}`;
}

/**
 * Which prefix a letter takes: its category's, or its type's.
 *
 * A category prefix wins because it says more. "TAX-2026-0007" tells somebody
 * reading a file note what the letter was about; "IN-2026-0412" tells them only
 * that it came from outside.
 */
export function prefixFor(type, category) {
  if (category?.prefix) return category.prefix;
  return TYPE_MAP.get(type)?.prefix ?? 'GEN';
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * Add working hours to an instant, skipping non-working days entirely.
 *
 * A letter registered at 4pm on Friday with a 24-hour deadline is due at 4pm on
 * Monday, not Saturday. This is not a full working-calendar — it does not know
 * about opening hours or public holidays — and it deliberately does not pretend
 * to: a deadline that is a day out is a conversation, a deadline the system
 * cannot explain is an argument.
 */
export function addWorkingHours(from, hours, workingDays) {
  const start = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (Number.isNaN(start.getTime())) return null;

  const days = workingDays instanceof Set && workingDays.size ? workingDays : new Set([1, 2, 3, 4, 5]);
  // Every day is a working day: nothing to skip, and the loop below would spin.
  if (days.size === 7) return new Date(start.getTime() + hours * 3600_000);

  let remaining = Math.max(0, Number(hours) || 0);
  const cursor = new Date(start.getTime());
  let guard = 0;

  while (remaining > 0 && guard < 3000) {
    guard += 1;
    if (!days.has(isoWeekday(cursor))) {
      // Jump to the start of the next day and try again.
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    // Hours left in this day.
    const endOfDay = new Date(cursor.getTime());
    endOfDay.setUTCHours(24, 0, 0, 0);
    const available = (endOfDay - cursor) / 3600_000;
    if (available >= remaining) return new Date(cursor.getTime() + remaining * 3600_000);
    remaining -= available;
    cursor.setTime(endOfDay.getTime());
  }
  return cursor;
}

export function isoWeekday(date) {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day; // Sunday is 7, not 0
}

/** '2026-08-14T09:30:00Z' from a Date. Stored form for every instant here. */
export function isoStamp(date = new Date()) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nowStamp() {
  return isoStamp(new Date());
}

/** Hours from now until a stored timestamp. Negative when it has passed. */
export function hoursUntil(stamp, now = new Date()) {
  if (!stamp) return null;
  const then = new Date(stamp);
  if (Number.isNaN(then.getTime())) return null;
  return (then.getTime() - now.getTime()) / 3600_000;
}

export function isOverdue(stamp, now = new Date()) {
  const h = hoursUntil(stamp, now);
  return h != null && h < 0;
}

// ---------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------

/**
 * The oversight permission: sees every letter, including restricted ones.
 *
 * Held by partners and the practice administrator. Named here once so that the
 * answer to "who can read a restricted letter" is in a single place rather than
 * repeated across a dozen queries with one of them eventually wrong.
 */
export const OVERSIGHT = 'co_oversight';

/**
 * A SQL fragment restricting a letter query to what this person may see.
 *
 * Returns `{ sql, binds }` to be spliced into a WHERE clause. Restricted
 * letters are absent rather than locked: a row that says "you may not read
 * this" still tells you the firm is corresponding with somebody about
 * something, and for the letters that get marked restricted — a disciplinary
 * matter, a suspected fraud, a partner's own tax affairs — that is the leak.
 */
export function visibilityClause(session, alias = 'l') {
  const permissions = session?.permissions ?? [];
  if (permissions.includes(OVERSIGHT)) return { sql: '1 = 1', binds: [] };

  const uid = session?.user?.id ?? 0;
  return {
    sql: `(${alias}.confidentiality != 'restricted'
       OR ${alias}.created_by = ?
       OR EXISTS (SELECT 1 FROM co_routes r WHERE r.letter_id = ${alias}.id AND r.to_user_id = ?))`,
    binds: [uid, uid],
  };
}

/** The same question for one already-loaded letter. */
export async function canSeeLetter(db, letter, session) {
  if (!letter) return false;
  if (letter.confidentiality !== 'restricted') return true;
  const permissions = session?.permissions ?? [];
  if (permissions.includes(OVERSIGHT)) return true;

  const uid = session?.user?.id ?? 0;
  if (letter.created_by && letter.created_by === uid) return true;

  const routed = await db.prepare(
    'SELECT 1 FROM co_routes WHERE letter_id = ? AND to_user_id = ? LIMIT 1',
  ).bind(letter.id, uid).first();
  return Boolean(routed);
}

/** Load a letter this person is allowed to see, or throw. */
export async function loadLetter(db, id, session) {
  const letter = await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(id).first();
  if (!letter) throw notFound('That correspondence could not be found');
  if (!await canSeeLetter(db, letter, session)) {
    // Deliberately the same answer as a letter that does not exist. "You may
    // not see this" confirms it exists, which is the thing being withheld.
    throw notFound('That correspondence could not be found');
  }
  return letter;
}

/**
 * May this person change the letter itself — its subject, body, party?
 *
 * Once sealed, nobody may: the signature underneath is over those exact bytes,
 * and a system that lets the text move after signing has a signature that means
 * nothing. Before sealing it is the author, anybody holding the register
 * permission, and oversight.
 */
export function canEditLetter(letter, session) {
  if (letter.sealed_at) return false;
  if (CLOSED_STATUSES.has(letter.status)) return false;
  const permissions = session?.permissions ?? [];
  if (permissions.includes(OVERSIGHT)) return true;
  if (letter.created_by && letter.created_by === session?.user?.id) return true;
  return permissions.includes('co_register');
}

export function assertEditable(letter, session) {
  if (canEditLetter(letter, session)) return;
  if (letter.sealed_at) {
    throw badRequest(
      'This document has been sealed and signed, so its text can no longer be changed. '
      + 'Register a follow-up letter instead — it will be linked to this one.',
    );
  }
  if (CLOSED_STATUSES.has(letter.status)) {
    throw badRequest('This correspondence is closed. Reopen it first if it needs changing.');
  }
  throw forbidden('Only the person who registered this, or a partner, can change it.');
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

/**
 * Record something that happened to a letter.
 *
 * Never throws at its caller for anything but a genuine database fault: the
 * trail exists to describe work that already succeeded, and losing the note
 * must not undo the work. A failure to write it is logged and the event that
 * earned it stands.
 */
export async function recordEvent(db, env, letterId, { actor, actorUserId = null, action, detail = null }) {
  try {
    const previous = await db.prepare(
      'SELECT hash FROM co_events WHERE letter_id = ? ORDER BY id DESC LIMIT 1',
    ).bind(letterId).first();

    const at = nowStamp();
    const prevHash = previous?.hash ?? null;
    const hash = await eventHash(env, {
      letterId, at, actor, action, detail, prevHash,
    });

    await db.prepare(
      `INSERT INTO co_events (letter_id, at, actor_user_id, actor, action, detail, prev_hash, hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      letterId, at, actorUserId, String(actor ?? 'system').slice(0, 120),
      String(action).slice(0, 60),
      detail == null ? null : JSON.stringify(detail),
      prevHash, hash,
    ).run();

    return hash;
  } catch (err) {
    console.error('correspondence event not recorded', err);
    return null;
  }
}

/**
 * Re-walk a letter's trail and report the first place it stops adding up.
 *
 * Two things can be wrong, and they are worth telling apart. A broken `hash`
 * means that row's own contents were changed. A broken `prev_hash` means a row
 * before it was changed or removed — the row you are looking at is fine, its
 * ancestry is not.
 */
export async function verifyTrail(db, env, letterId) {
  const rows = await db.prepare(
    'SELECT * FROM co_events WHERE letter_id = ? ORDER BY id ASC',
  ).bind(letterId).all();

  const events = rows.results ?? [];
  let prevHash = null;

  for (const event of events) {
    if ((event.prev_hash ?? null) !== prevHash) {
      return {
        ok: false,
        checked: events.length,
        failedAt: event.id,
        at: event.at,
        reason: 'chain',
        message: 'An earlier entry has been changed or removed.',
      };
    }
    const expected = await eventHash(env, {
      letterId,
      at: event.at,
      actor: event.actor,
      action: event.action,
      detail: event.detail == null ? null : safeParse(event.detail),
      prevHash: event.prev_hash,
    });
    if (expected !== event.hash) {
      return {
        ok: false,
        checked: events.length,
        failedAt: event.id,
        at: event.at,
        reason: 'entry',
        message: 'This entry has been changed since it was written.',
      };
    }
    prevHash = event.hash;
  }

  return { ok: true, checked: events.length, failedAt: null };
}

export function safeParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Seals
// ---------------------------------------------------------------------------

/** The digest of a letter as it stands right now, attachments included. */
export async function currentDigest(db, env, letter) {
  const files = await db.prepare(
    'SELECT name, sha256, size FROM co_attachments WHERE letter_id = ? ORDER BY id',
  ).bind(letter.id).all().catch(() => ({ results: [] }));
  return contentDigest(env, letter, files.results ?? []);
}

/**
 * Does every signature on this letter still match what the letter now says?
 *
 * A signature whose digest no longer matches is not evidence of wrongdoing on
 * its own — it means the document moved after it was signed, which is exactly
 * what the reader needs to be told.
 */
export async function verifySignatures(db, env, letter) {
  const rows = await db.prepare(
    'SELECT * FROM co_signatures WHERE letter_id = ? ORDER BY id',
  ).bind(letter.id).all();

  const signatures = rows.results ?? [];
  if (!signatures.length) return { signatures: [], allValid: true, documentMoved: false };

  const digest = await currentDigest(db, env, letter);
  const checked = [];

  for (const sig of signatures) {
    // Who the seal names. Internally that is the account; from outside the firm
    // it is the envelope recipient, because zero — the emergency account — is a
    // real user id and an external signature must never be able to wear it.
    const signer = sig.external ? `ext:${sig.recipient_id}` : (sig.user_id ?? 0);
    const expectedSeal = await keyedDigest(
      env, 'co-seal', `${sig.content_hash}|${signer}|${sig.name}|${sig.at}`,
    );
    checked.push({
      id: sig.id,
      name: sig.name,
      title: sig.title,
      method: sig.method,
      at: sig.at,
      external: Boolean(sig.external),
      email: sig.email ?? null,
      // The seal is intact: nobody has forged or edited the signature row.
      sealValid: expectedSeal === sig.seal,
      // And the document has not moved since it was signed.
      documentUnchanged: sig.content_hash === digest,
    });
  }

  return {
    signatures: checked,
    allValid: checked.every((s) => s.sealValid),
    documentMoved: checked.some((s) => !s.documentUnchanged),
    digest,
  };
}

// ---------------------------------------------------------------------------
// Small shared shapes
// ---------------------------------------------------------------------------

/** Everything a list row needs to be drawn, and nothing that costs a join. */
export function letterSummary(row, now = new Date()) {
  return {
    id: row.id,
    ref: row.ref,
    type: row.type,
    subject: row.subject,
    summary: row.summary ?? null,
    status: row.status,
    priority: row.priority,
    confidentiality: row.confidentiality,
    partyId: row.party_id ?? null,
    partyName: row.party_name ?? null,
    caseId: row.case_id ?? null,
    caseRef: row.case_ref ?? null,
    categoryId: row.category_id ?? null,
    categoryName: row.category_name ?? null,
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    letterDate: row.letter_date ?? null,
    receivedAt: row.received_at ?? null,
    dueAt: row.due_at ?? null,
    overdue: !CLOSED_STATUSES.has(row.status) && isOverdue(row.due_at, now),
    openRoutes: row.open_routes ?? 0,
    withNames: row.with_names ?? null,
    createdAt: row.created_at,
    createdBy: row.created_by_name ?? null,
    sealed: Boolean(row.sealed_at),
    archived: Boolean(row.archived),
  };
}

/**
 * The person a route is really waiting on.
 *
 * A route addressed to somebody who is away is also the delegate's problem —
 * shown to them, escalated through them — without ever being reassigned. The
 * work stays with the person who owns it; somebody else can simply see it while
 * they are out.
 */
export async function delegateFor(db, userId, now = new Date()) {
  if (!userId) return null;
  const row = await db.prepare(
    'SELECT away_until, delegate_user_id FROM co_staff WHERE user_id = ?',
  ).bind(userId).first().catch(() => null);
  if (!row?.delegate_user_id || !row.away_until) return null;
  return new Date(row.away_until) > now ? row.delegate_user_id : null;
}
