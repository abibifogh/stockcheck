import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addWorkingHours, coSettings, currentDigest, isOverdue, nextRef, prefixFor,
  recordEvent, verifySignatures, verifyTrail, visibilityClause,
} from '../src/lib/correspondence.js';
import { contentDigestPayload, sealFor, stableJson } from '../src/lib/co-crypto.js';
import { nextOccurrence } from '../src/lib/co-workflow.js';
import { fillPlaceholders, placeholdersIn } from '../src/routes/correspondence.js';
import { permissionsFor, rolesFor } from '../src/lib/permissions.js';
import { servesPath } from '../src/lib/site.js';

/**
 * The correspondence register.
 *
 * The tests that matter here are the ones where a plausible implementation is
 * wrong: a reference number that can come round twice, a deadline that lands on
 * a Sunday, an audit trail that says "intact" after somebody has edited it, and
 * a signature that still validates against a document whose text has moved.
 */

const env = { DOC_SECRET: 'test-secret-not-a-real-one', SESSION_SECRET: 'session' };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/correspondence-database.sql', 'utf8'));
  // Real people, because every letter has an author and the foreign key is on.
  // Its being on is itself worth having: a register whose "registered by" can
  // point at nobody is a register that eventually does.
  for (const [id, name, role] of [
    [1, 'Ama Serwaa', 'partner'], [2, 'Kofi Owusu', 'practice_manager'],
    [3, 'Efua Blay', 'practice_staff'], [4, 'Yaw Boateng', 'practice_staff'],
    [9, 'Nana Adjei', 'partner'],
  ]) {
    sqlite.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(id, name, role);
  }
  return {
    sqlite,
    prepare(sql) {
      const st = { sql, binds: [] };
      st.bind = (...a) => { st.binds = a; return st; };
      st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
      st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
      st.run = async () => sqlite.prepare(sql).run(...st.binds);
      return st;
    },
    async batch(statements) {
      for (const st of statements) await st.run();
    },
  };
}

async function aLetter(db, overrides = {}) {
  const values = {
    ref: 'TAX-2026-0001', type: 'incoming', subject: 'Assessment for 2025',
    body: 'Please explain the difference.', ...overrides,
  };
  return db.prepare(
    `INSERT INTO co_letters (ref, type, subject, body, status, created_by, created_by_name, confidentiality)
     VALUES (?1, ?2, ?3, ?4, 'registered', ?5, ?6, ?7) RETURNING *`,
  ).bind(
    values.ref, values.type, values.subject, values.body,
    values.created_by ?? 1, values.created_by_name ?? 'Ama',
    values.confidentiality ?? 'normal',
  ).first();
}

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------

test('references run in sequence and never come round twice', async () => {
  const db = database();

  const first = await nextRef(db, 'TAX', { year: 2026, digits: 4 });
  const second = await nextRef(db, 'TAX', { year: 2026, digits: 4 });
  const third = await nextRef(db, 'TAX', { year: 2026, digits: 4 });

  assert.equal(first, 'TAX-2026-0001');
  assert.equal(second, 'TAX-2026-0002');
  assert.equal(third, 'TAX-2026-0003');
});

test('each prefix and each year counts on its own', async () => {
  const db = database();

  assert.equal(await nextRef(db, 'TAX', { year: 2026 }), 'TAX-2026-0001');
  assert.equal(await nextRef(db, 'AUD', { year: 2026 }), 'AUD-2026-0001');
  assert.equal(await nextRef(db, 'TAX', { year: 2027 }), 'TAX-2027-0001');
  assert.equal(await nextRef(db, 'TAX', { year: 2026 }), 'TAX-2026-0002');
});

test('deleting the newest letter does not free its number for reuse', async () => {
  // The bug a MAX(ref) + 1 implementation has, and the one that matters most in
  // a register: two different letters filed under one reference.
  const db = database();
  const ref = await nextRef(db, 'TAX', { year: 2026 });
  await aLetter(db, { ref });
  await db.prepare('DELETE FROM co_letters WHERE ref = ?').bind(ref).run();

  assert.equal(await nextRef(db, 'TAX', { year: 2026 }), 'TAX-2026-0002',
    'a deleted letter must take its number with it');
});

test('the reference prefix comes from the category where there is one', () => {
  assert.equal(prefixFor('incoming', { prefix: 'TAX' }), 'TAX');
  assert.equal(prefixFor('incoming', null), 'IN');
  assert.equal(prefixFor('outgoing', { prefix: null }), 'OUT');
  assert.equal(prefixFor('memo', undefined), 'MEM');
  assert.equal(prefixFor('circular', {}), 'CIR');
});

test('a nonsense prefix is cleaned rather than stored as typed', async () => {
  const db = database();
  const ref = await nextRef(db, 'ta x/2!', { year: 2026 });
  assert.equal(ref, 'TAX2-2026-0001');
});

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

test('a deadline set on Friday afternoon lands on Monday, not Saturday', () => {
  const workingDays = new Set([1, 2, 3, 4, 5]);
  // Friday 14 August 2026, 16:00 UTC. 24 working hours later.
  const friday = new Date('2026-08-14T16:00:00Z');
  const due = addWorkingHours(friday, 24, workingDays);

  assert.equal(due.getUTCDay(), 1, 'Monday');
  assert.equal(due.toISOString().slice(0, 10), '2026-08-17');
  assert.equal(due.getUTCHours(), 16);
});

test('a deadline inside one working day is simple arithmetic', () => {
  const due = addWorkingHours(new Date('2026-08-12T09:00:00Z'), 6, new Set([1, 2, 3, 4, 5]));
  assert.equal(due.toISOString(), '2026-08-12T15:00:00.000Z');
});

test('a firm that works every day has nothing skipped', () => {
  const all = new Set([1, 2, 3, 4, 5, 6, 7]);
  const due = addWorkingHours(new Date('2026-08-14T16:00:00Z'), 24, all);
  assert.equal(due.toISOString(), '2026-08-15T16:00:00.000Z', 'Saturday is a working day here');
});

test('a deadline starting on a closed day begins counting when the office opens', () => {
  // Registered on a Sunday. The 8 hours start on Monday morning, not Sunday.
  const due = addWorkingHours(new Date('2026-08-16T10:00:00Z'), 8, new Set([1, 2, 3, 4, 5]));
  assert.equal(due.toISOString().slice(0, 10), '2026-08-17');
  assert.equal(due.getUTCHours(), 8, 'from midnight on the first working day');
});

test('overdue is about the clock, and a missing deadline is never overdue', () => {
  const now = new Date('2026-08-14T12:00:00Z');
  assert.equal(isOverdue('2026-08-14T09:00:00Z', now), true);
  assert.equal(isOverdue('2026-08-14T18:00:00Z', now), false);
  assert.equal(isOverdue(null, now), false);
  assert.equal(isOverdue('not a date', now), false);
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

test('a trail written by the application verifies', async () => {
  const db = database();
  const letter = await aLetter(db);

  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'letter.registered', detail: { ref: letter.ref } });
  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'route.sent', detail: { to: 'Tax' } });
  await recordEvent(db, env, letter.id, { actor: 'Kofi', action: 'route.completed' });

  const result = await verifyTrail(db, env, letter.id);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
  assert.equal(result.failedAt, null);
});

test('an entry edited in a console breaks the trail, and the check says which one', async () => {
  const db = database();
  const letter = await aLetter(db);

  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'letter.registered' });
  await recordEvent(db, env, letter.id, { actor: 'Kofi', action: 'route.rejected', detail: { comment: 'figures wrong' } });
  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'letter.closed' });

  // Somebody rewrites history: the rejection becomes an approval.
  const middle = db.sqlite.prepare(
    "SELECT id FROM co_events WHERE action = 'route.rejected'",
  ).get().id;
  db.sqlite.prepare("UPDATE co_events SET action = 'route.approved' WHERE id = ?").run(middle);

  const result = await verifyTrail(db, env, letter.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'entry', 'this row itself was changed');
  assert.equal(result.failedAt, middle);
});

test('a deleted entry breaks the trail too, and reads as a broken chain', async () => {
  const db = database();
  const letter = await aLetter(db);

  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'letter.registered' });
  await recordEvent(db, env, letter.id, { actor: 'Kofi', action: 'route.rejected' });
  await recordEvent(db, env, letter.id, { actor: 'Ama', action: 'letter.closed' });

  const middle = db.sqlite.prepare("SELECT id FROM co_events WHERE action = 'route.rejected'").get().id;
  db.sqlite.prepare('DELETE FROM co_events WHERE id = ?').run(middle);

  const result = await verifyTrail(db, env, letter.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chain', 'the row after it points at something no longer there');
});

test('a trail with nothing in it is intact rather than broken', async () => {
  const db = database();
  const letter = await aLetter(db);
  const result = await verifyTrail(db, env, letter.id);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0);
});

test('two letters keep separate chains', async () => {
  const db = database();
  const one = await aLetter(db, { ref: 'TAX-2026-0001' });
  const two = await aLetter(db, { ref: 'TAX-2026-0002' });

  await recordEvent(db, env, one.id, { actor: 'Ama', action: 'letter.registered' });
  await recordEvent(db, env, two.id, { actor: 'Ama', action: 'letter.registered' });
  await recordEvent(db, env, one.id, { actor: 'Ama', action: 'letter.closed' });

  assert.equal((await verifyTrail(db, env, one.id)).ok, true);
  assert.equal((await verifyTrail(db, env, two.id)).ok, true);

  // And tampering with one does not accuse the other.
  db.sqlite.prepare("UPDATE co_events SET actor = 'Somebody else' WHERE letter_id = ?").run(two.id);
  assert.equal((await verifyTrail(db, env, one.id)).ok, true, 'the untouched letter is still fine');
  assert.equal((await verifyTrail(db, env, two.id)).ok, false);
});

// ---------------------------------------------------------------------------
// Signatures and seals
// ---------------------------------------------------------------------------

test('a signature validates, and stops validating when the text moves', async () => {
  const db = database();
  const letter = await aLetter(db);
  const at = '2026-08-14T10:00:00Z';

  const digest = await currentDigest(db, env, letter);
  const seal = await sealFor(env, digest, { userId: 1, name: 'Ama Serwaa', at });
  await db.prepare(
    `INSERT INTO co_signatures (letter_id, user_id, name, method, content_hash, seal, at)
     VALUES (?1, 1, 'Ama Serwaa', 'typed', ?2, ?3, ?4)`,
  ).bind(letter.id, digest, seal, at).run();

  const before = await verifySignatures(db, env, letter);
  assert.equal(before.allValid, true, 'the seal is genuine');
  assert.equal(before.documentMoved, false, 'and the document has not moved');

  // Somebody edits the letter behind the signature.
  db.sqlite.prepare("UPDATE co_letters SET body = 'Nothing to explain.' WHERE id = ?").run(letter.id);
  const after = await verifySignatures(db, env, await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(letter.id).first());

  assert.equal(after.allValid, true, 'the signature record itself is untouched');
  assert.equal(after.documentMoved, true, 'but it no longer describes this document');
});

test('swapping an attachment moves the document even though no letter row changed', async () => {
  const db = database();
  const letter = await aLetter(db);

  await db.prepare(
    `INSERT INTO co_attachments (letter_id, name, mime, size, sha256, storage_key)
     VALUES (?1, 'assessment.pdf', 'application/pdf', 1200, 'aaaa', 'letters/1/x')`,
  ).bind(letter.id).run();

  const at = '2026-08-14T10:00:00Z';
  const digest = await currentDigest(db, env, letter);
  const seal = await sealFor(env, digest, { userId: 1, name: 'Ama', at });
  await db.prepare(
    `INSERT INTO co_signatures (letter_id, user_id, name, method, content_hash, seal, at)
     VALUES (?1, 1, 'Ama', 'typed', ?2, ?3, ?4)`,
  ).bind(letter.id, digest, seal, at).run();

  assert.equal((await verifySignatures(db, env, letter)).documentMoved, false);

  db.sqlite.prepare("UPDATE co_attachments SET sha256 = 'bbbb' WHERE letter_id = ?").run(letter.id);
  assert.equal((await verifySignatures(db, env, letter)).documentMoved, true,
    'the scan behind a signed letter was replaced and nothing in co_letters said so');
});

test('a forged seal is caught even when the digest is right', async () => {
  const db = database();
  const letter = await aLetter(db);
  const digest = await currentDigest(db, env, letter);

  await db.prepare(
    `INSERT INTO co_signatures (letter_id, user_id, name, method, content_hash, seal, at)
     VALUES (?1, 1, 'Somebody', 'typed', ?2, 'a-made-up-seal', '2026-08-14T10:00:00Z')`,
  ).bind(letter.id, digest).run();

  const result = await verifySignatures(db, env, letter);
  assert.equal(result.allValid, false);
  assert.equal(result.documentMoved, false, 'the digest matches — it is the seal that is fake');
});

test('a seal minted with a different secret does not validate', async () => {
  const digest = 'a'.repeat(64);
  const signer = { userId: 1, name: 'Ama', at: '2026-08-14T10:00:00Z' };
  const mine = await sealFor(env, digest, signer);
  const theirs = await sealFor({ DOC_SECRET: 'a stolen database has no secret' }, digest, signer);
  assert.notEqual(mine, theirs);
});

test('the digest ignores the order attachments come back in', () => {
  const letter = { ref: 'TAX-2026-0001', type: 'incoming', subject: 'S', body: 'B', party_id: 1, letter_date: null };
  const a = { sha256: 'aaa', name: 'one.pdf', size: 1 };
  const b = { sha256: 'bbb', name: 'two.pdf', size: 2 };

  assert.equal(
    contentDigestPayload(letter, [a, b]),
    contentDigestPayload(letter, [b, a]),
    'row order is the database\'s business, not the document\'s',
  );
});

test('two objects differing only in key order hash the same', () => {
  assert.equal(stableJson({ a: 1, b: 2 }), stableJson({ b: 2, a: 1 }));
  assert.notEqual(stableJson({ a: 1 }), stableJson({ a: 2 }));
  assert.equal(stableJson(null), '');
});

// ---------------------------------------------------------------------------
// Confidentiality
// ---------------------------------------------------------------------------

test('a restricted letter is absent from an ordinary register query', async () => {
  const db = database();
  await aLetter(db, { ref: 'TAX-2026-0001', subject: 'Routine query' });
  await aLetter(db, {
    ref: 'TAX-2026-0002', subject: 'Suspected irregularity',
    confidentiality: 'restricted', created_by: 9,
  });

  const outsider = { user: { id: 3 }, permissions: ['co_register', 'co_route'] };
  const clause = visibilityClause(outsider);
  const rows = await db.prepare(
    `SELECT ref FROM co_letters l WHERE ${clause.sql} ORDER BY ref`,
  ).bind(...clause.binds).all();

  assert.deepEqual(rows.results.map((r) => r.ref), ['TAX-2026-0001'],
    'not greyed out — absent. A row saying a file exists is itself the disclosure.');
});

test('a partner sees the restricted file, and so does anybody it was routed to', async () => {
  const db = database();
  await aLetter(db, { ref: 'TAX-2026-0001', confidentiality: 'restricted', created_by: 9 });
  const letter = await db.prepare("SELECT id FROM co_letters WHERE ref = 'TAX-2026-0001'").first();

  const seen = async (session) => {
    const clause = visibilityClause(session);
    const rows = await db.prepare(`SELECT ref FROM co_letters l WHERE ${clause.sql}`)
      .bind(...clause.binds).all();
    return rows.results.map((r) => r.ref);
  };

  assert.deepEqual(await seen({ user: { id: 2 }, permissions: ['co_oversight'] }), ['TAX-2026-0001']);
  assert.deepEqual(await seen({ user: { id: 9 }, permissions: [] }), ['TAX-2026-0001'], 'the author');
  assert.deepEqual(await seen({ user: { id: 4 }, permissions: [] }), [], 'and nobody else');

  await db.prepare(
    "INSERT INTO co_routes (letter_id, to_user_id, action) VALUES (?1, 4, 'action')",
  ).bind(letter.id).run();

  assert.deepEqual(await seen({ user: { id: 4 }, permissions: [] }), ['TAX-2026-0001'],
    'until it is sent to them, at which point they can hardly act on what they cannot read');
});

// ---------------------------------------------------------------------------
// Recurring meetings
// ---------------------------------------------------------------------------

test('a recurring meeting lands on its next real slot, not the one after the last look', () => {
  // A weekly meeting nobody has touched since March, checked in June. The next
  // occurrence is this week's, not the one after 20 March.
  const next = nextOccurrence('2026-03-06T09:00:00Z', 'weekly', new Date('2026-06-10T12:00:00Z'));
  assert.ok(next > new Date('2026-06-10T12:00:00Z'));
  assert.ok(next < new Date('2026-06-17T12:00:00Z'), 'within one period of now');
  assert.equal(next.getUTCDay(), 5, 'and still a Friday');
});

test('every repeat pattern steps by the period it names', () => {
  const from = '2026-01-15T09:00:00Z';
  const now = new Date('2026-01-15T09:00:00Z');
  assert.equal(nextOccurrence(from, 'daily', now).toISOString(), '2026-01-16T09:00:00.000Z');
  assert.equal(nextOccurrence(from, 'weekly', now).toISOString(), '2026-01-22T09:00:00.000Z');
  assert.equal(nextOccurrence(from, 'fortnightly', now).toISOString(), '2026-01-29T09:00:00.000Z');
  assert.equal(nextOccurrence(from, 'monthly', now).toISOString(), '2026-02-15T09:00:00.000Z');
  assert.equal(nextOccurrence(from, 'quarterly', now).toISOString(), '2026-04-15T09:00:00.000Z');
  assert.equal(nextOccurrence(from, 'yearly', now).toISOString(), '2027-01-15T09:00:00.000Z');
});

test('a meeting that does not repeat has no next occurrence', () => {
  assert.equal(nextOccurrence('2026-01-15T09:00:00Z', 'none', new Date()), null);
  assert.equal(nextOccurrence('2026-01-15T09:00:00Z', null, new Date()), null);
  assert.equal(nextOccurrence('not a date', 'weekly', new Date()), null);
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('a placeholder the system cannot fill is left on the page, not blanked', () => {
  const filled = fillPlaceholders(
    'Dear {{client_contact}}, our fee for {{engagement}} is {{fee}}.',
    { client_contact: 'Mr Mensah', engagement: 'the 2026 audit' },
  );
  assert.equal(filled, 'Dear Mr Mensah, our fee for the 2026 audit is {{fee}}.',
    'a blank is a letter that goes out with a hole in it; a placeholder is a prompt');
});

test('placeholders are found whatever the spacing, and listed once each', () => {
  assert.deepEqual(
    placeholdersIn('{{ client_name }} and {{client_name}} and {{Firm_Name}}').sort(),
    ['client_name', 'firm_name'],
  );
});

test('an empty value counts as unfilled', () => {
  assert.equal(fillPlaceholders('{{a}}', { a: '' }), '{{a}}');
  assert.equal(fillPlaceholders('{{a}}', { a: null }), '{{a}}');
  assert.equal(fillPlaceholders('{{a}}', { a: 0 }), '0', 'but zero is an answer');
});

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

test('the practice serves its own API and neither hotel', () => {
  for (const path of [
    '/api/co/bootstrap', '/api/co/letters', '/api/co/letters/4/verify',
    '/api/auth/login', '/api/users', '/api/notices', '/api/audit',
  ]) {
    assert.equal(servesPath('correspondence', path), true, `${path} should be served`);
  }
  for (const path of ['/api/days', '/api/mx/issues', '/api/shop/sales', '/api/hk/bootstrap', '/api/insights/stock']) {
    assert.equal(servesPath('correspondence', path), false, `${path} should be absent`);
  }

  // "Erase a period" counts and deletes day sheets and bed checks. An
  // accounting file has a statutory keeping period, and its equivalent here is
  // the retention review — which lists what is past it and lets a person
  // decide, rather than letting a date range sweep it away.
  assert.equal(servesPath('correspondence', '/api/data/summary'), false);
  assert.equal(servesPath('correspondence', '/api/data/erase'), false);
  assert.equal(servesPath('housekeeping', '/api/data/erase'), true, 'the dorm still has one');
});

test('and the hotel deployments do not serve the practice', () => {
  assert.equal(servesPath('full', '/api/co/letters'), false);
  assert.equal(servesPath('housekeeping', '/api/co/letters'), false);
  // A path that merely starts with the same letters is not caught.
  assert.equal(servesPath('full', '/api/company-thing'), true);
});

test('the practice offers only practice permissions and roles', () => {
  const keys = permissionsFor('correspondence').map((p) => p.key);
  assert.deepEqual(keys, [
    'co_register', 'co_route', 'co_approve', 'co_cases', 'co_tasks',
    'co_meetings', 'co_reports', 'co_setup', 'co_oversight',
  ]);

  const roles = rolesFor('correspondence').map((r) => r.key);
  assert.deepEqual(roles, ['registry_clerk', 'practice_staff', 'practice_manager', 'partner', 'admin']);
  assert.ok(!roles.includes('cook'), 'an accounting firm has no cook');

  // Nothing offered here names a section this site does not have.
  const available = new Set(keys);
  for (const role of rolesFor('correspondence')) {
    for (const key of role.defaults) {
      if (key === 'users') continue; // every site needs somebody who manages people
      assert.ok(available.has(key), `${role.key} defaults to ${key}, which this site does not offer`);
    }
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('settings come back with sane defaults and are clamped', async () => {
  const db = database();
  const settings = await coSettings(db);

  assert.equal(settings.refDigits, 4);
  assert.equal(settings.defaultDueHours, 72);
  assert.deepEqual([...settings.workingDays].sort(), [1, 2, 3, 4, 5]);
  assert.equal(settings.sweepEnabled, true);

  db.sqlite.prepare("UPDATE settings SET value = '99' WHERE key = 'co_ref_digits'").run();
  db.sqlite.prepare("UPDATE settings SET value = '' WHERE key = 'co_working_days'").run();

  const clamped = await coSettings(db);
  assert.equal(clamped.refDigits, 8, 'a reference with ninety-nine digits is not a reference');
  assert.equal(clamped.workingDays.size, 7, 'no working days at all means every day, not none');
});
