import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createToken } from '../src/lib/auth.js';
import {
  activeRecipients, envelopeOutcome, prepareRecipients, resetSigningThrottle,
} from '../src/lib/envelopes.js';
import { runSweep } from '../src/lib/co-workflow.js';

/**
 * Sending a document out for signature to somebody with no account.
 *
 * Most of this is driven through the Worker, because the interesting failures
 * are not in any one function — they are in whether a link that should be dead
 * is dead, whether the second signer can jump the queue, and whether the text
 * can move while four people are half-way through signing it.
 */

const SECRET = 'test-session-secret';

function environment() {
  // The public endpoints throttle by address, and every test here uses the
  // same one. Without this the twentieth test in the file gets a 429 for
  // reasons that have nothing to do with what it is testing.
  resetSigningThrottle();

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/correspondence-database.sql', 'utf8'));

  for (const [id, name, role] of [
    [1, 'Ama Serwaa', 'partner'],
    [2, 'Kofi Owusu', 'practice_manager'],
    [3, 'Efua Blay', 'registry_clerk'],
  ]) {
    sqlite.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(id, name, role);
  }

  const db = {
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

  return {
    DB: db,
    SESSION_SECRET: SECRET,
    DOC_SECRET: 'test-doc-secret',
    APP_SITE: 'correspondence',
    ASSETS: { fetch: async () => new Response('index.html') },
  };
}

async function cookieFor(userId, role) {
  const now = Math.floor(Date.now() / 1000);
  const token = await createToken({ uid: userId, role, iat: now, exp: now + 3600 }, SECRET);
  return `bf_session=${encodeURIComponent(token)}`;
}

function client(env, cookie) {
  return async function call(method, path, body) {
    const request = new Request(`https://cms.example.com${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': '198.51.100.7',
        'User-Agent': 'TestBrowser/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const response = await worker.fetch(request, env, { waitUntil: () => {} });
    const type = response.headers.get('Content-Type') || '';
    return {
      status: response.status,
      body: type.includes('json') ? await response.json() : await response.text(),
    };
  };
}

/** A recipient with no account at all — no cookie, nothing. */
function outsider(env) {
  return client(env, null);
}

const TOKEN_OF = (path) => new URL(`https://x${path}`).searchParams.get('t');

async function aLetterFor(partner, subject = 'Engagement letter 2026') {
  const letter = await partner('POST', '/api/co/letters', {
    type: 'outgoing', subject, body: 'Please confirm your agreement by signing below.', noWorkflow: true,
  });
  return letter.body.letter;
}

// ---------------------------------------------------------------------------
// The shape of a request
// ---------------------------------------------------------------------------

test('recipients are numbered in the order they were listed', async () => {
  const prepared = await prepareRecipients({ DOC_SECRET: 'x' }, [
    { name: 'Kwame Mensah', email: 'kwame@example.com' },
    { name: 'Akua Boateng', role: 'approver' },
    { name: 'File copy', role: 'viewer' },
  ]);

  assert.deepEqual(prepared.map((r) => r.seq), [1, 2, 3]);
  assert.deepEqual(prepared.map((r) => r.role), ['signer', 'approver', 'viewer']);
  assert.equal(new Set(prepared.map((r) => r.token)).size, 3, 'every token is its own');
  assert.ok(prepared[0].token.length >= 30, 'and long enough not to be guessed');
});

test('a recipient with no name, and a nonsense address, are both refused', async () => {
  const env = { DOC_SECRET: 'x' };
  await assert.rejects(() => prepareRecipients(env, []), /at least one recipient/);
  await assert.rejects(() => prepareRecipients(env, [{ name: '  ' }]), /needs a name/);
  await assert.rejects(
    () => prepareRecipients(env, [{ name: 'A', email: 'not-an-address' }]),
    /does not look like an email/,
  );
});

test('sequential holds everybody back; parallel invites them all', () => {
  const people = [
    { id: 1, seq: 1, role: 'signer', status: 'invited' },
    { id: 2, seq: 2, role: 'signer', status: 'pending' },
    { id: 3, seq: 3, role: 'viewer', status: 'pending' },
  ];

  const inOrder = activeRecipients({ routing: 'sequential' }, people).map((r) => r.id);
  assert.deepEqual(inOrder, [1, 3], 'the first actor, and the person copied in');

  const atOnce = activeRecipients({ routing: 'parallel' }, people).map((r) => r.id);
  assert.deepEqual(atOnce, [1, 2, 3]);

  // Once the first has signed, the second is up — and the viewer with them.
  const after = [{ ...people[0], status: 'signed' }, people[1], people[2]];
  assert.deepEqual(activeRecipients({ routing: 'sequential' }, after).map((r) => r.id), [2, 3]);
});

test('an envelope is not held open by somebody who was only copied in', () => {
  assert.equal(envelopeOutcome([
    { role: 'signer', status: 'signed' },
    { role: 'viewer', status: 'invited' },
  ]), 'completed', 'nothing was asked of the viewer');

  assert.equal(envelopeOutcome([
    { role: 'signer', status: 'signed' },
    { role: 'approver', status: 'invited' },
  ]), null);

  assert.equal(envelopeOutcome([
    { role: 'signer', status: 'signed' },
    { role: 'signer', status: 'declined' },
  ]), 'declined', 'one no ends it');
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('a client with no account opens a link, signs, and the document seals', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    message: 'Please sign and return.',
    recipients: [{ name: 'Kwame Mensah', email: 'kwame@example.com', title: 'Director' }],
  });

  assert.equal(sent.status, 201);
  assert.match(sent.body.envelope.ref, /^ENV-\d{4}-0001$/);
  assert.equal(sent.body.links.length, 1);
  assert.equal(sent.body.links[0].invited, true);

  const token = TOKEN_OF(sent.body.links[0].path);
  assert.ok(token);

  // Only the fingerprint is stored — the token itself is nowhere in the database.
  const stored = env.DB.sqlite.prepare('SELECT token_hash FROM co_envelope_recipients').get();
  assert.notEqual(stored.token_hash, token);
  assert.equal(
    env.DB.sqlite.prepare('SELECT COUNT(*) n FROM co_envelope_recipients WHERE token_hash = ?').get(token).n,
    0,
    'a stolen database is not a stolen set of links',
  );

  // The recipient opens it. No cookie, no account, nothing.
  const opened = await anyone('POST', '/api/co/sign/open', { token });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.you.name, 'Kwame Mensah');
  assert.equal(opened.body.theirTurn, true);
  assert.equal(opened.body.document.subject, 'Engagement letter 2026');
  assert.match(opened.body.document.body, /confirm your agreement/);
  assert.equal(opened.body.document.unchanged, true);
  assert.ok(opened.body.disclosure.length > 40, 'and is told what signing means');

  // Opening it is recorded.
  const events = env.DB.sqlite.prepare(
    "SELECT action, ip FROM co_envelope_events WHERE action = 'envelope.opened'",
  ).all();
  assert.equal(events.length, 1);
  assert.equal(events[0].ip, '198.51.100.7');

  // And signs.
  const signed = await anyone('POST', '/api/co/sign/submit', {
    token,
    consent: true,
    name: 'Kwame Mensah',
    method: 'drawn',
    image: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(signed.status, 200);
  assert.equal(signed.body.complete, true);
  assert.equal(signed.body.receipt.name, 'Kwame Mensah');

  // The envelope closed, and the letter sealed.
  const envelope = env.DB.sqlite.prepare('SELECT * FROM co_envelopes').get();
  assert.equal(envelope.status, 'completed');
  assert.ok(envelope.completed_at);

  const after = await partner('GET', `/api/co/letters/${letter.id}`);
  assert.equal(after.body.letter.sealed, true);
  assert.equal(after.body.signatures.length, 1);
  assert.equal(after.body.signatures[0].name, 'Kwame Mensah');
  assert.equal(after.body.signaturesValid, true, 'the seal holds and the document has not moved');

  // The letter's own trail records it too, and still verifies.
  const verified = await partner('GET', `/api/co/letters/${letter.id}/verify`);
  assert.equal(verified.body.trail.ok, true);
  assert.equal(verified.body.sealsValid, true);
});

test('a signed link cannot be used twice, and consent is not optional', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });
  const token = TOKEN_OF(sent.body.links[0].path);

  const noConsent = await anyone('POST', '/api/co/sign/submit', { token, name: 'Kwame Mensah' });
  assert.equal(noConsent.status, 400);
  assert.match(noConsent.body.error, /agree to sign electronically/);

  await anyone('POST', '/api/co/sign/submit', { token, consent: true, name: 'Kwame Mensah' });

  const again = await anyone('POST', '/api/co/sign/submit', { token, consent: true, name: 'Kwame Mensah' });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already signed/);
});

test('the second signer cannot jump the queue', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner, 'Board resolution');
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    routing: 'sequential',
    recipients: [
      { name: 'First Director', email: 'one@example.com' },
      { name: 'Second Director', email: 'two@example.com' },
    ],
  });

  const [first, second] = sent.body.links;
  assert.equal(first.invited, true);
  assert.equal(second.invited, false, 'their turn has not come');

  const early = await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(second.path), consent: true, name: 'Second Director',
  });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /not your turn/);

  // The link still opens — they can read what is coming, just not sign it.
  const peek = await anyone('POST', '/api/co/sign/open', { token: TOKEN_OF(second.path) });
  assert.equal(peek.status, 200);
  assert.equal(peek.body.theirTurn, false);

  await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(first.path), consent: true, name: 'First Director',
  });

  const now = await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(second.path), consent: true, name: 'Second Director',
  });
  assert.equal(now.status, 200);
  assert.equal(now.body.complete, true);
});

test('a parallel envelope lets everybody sign in any order', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner, 'Joint confirmation');
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    routing: 'parallel',
    recipients: [
      { name: 'A Person', email: 'a@example.com' },
      { name: 'B Person', email: 'b@example.com' },
    ],
  });
  assert.ok(sent.body.links.every((l) => l.invited));

  const second = await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(sent.body.links[1].path), consent: true, name: 'B Person',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.complete, false, 'still waiting on the other one');

  const first = await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(sent.body.links[0].path), consent: true, name: 'A Person',
  });
  assert.equal(first.body.complete, true);
});

test('declining ends it for everybody, and says why', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    routing: 'parallel',
    recipients: [
      { name: 'Kwame Mensah', email: 'k@example.com' },
      { name: 'Akua Boateng', email: 'a@example.com' },
    ],
  });

  const silent = await anyone('POST', '/api/co/sign/decline', { token: TOKEN_OF(sent.body.links[0].path) });
  assert.equal(silent.status, 400, 'a refusal with no reason cannot be acted on');

  const declined = await anyone('POST', '/api/co/sign/decline', {
    token: TOKEN_OF(sent.body.links[0].path),
    reason: 'The fee quoted does not match what we agreed.',
  });
  assert.equal(declined.status, 200);

  const envelope = env.DB.sqlite.prepare('SELECT * FROM co_envelopes').get();
  assert.equal(envelope.status, 'declined');
  assert.match(envelope.closed_reason, /fee quoted/);

  // And the other person's link is now dead.
  const other = await anyone('POST', '/api/co/sign/open', { token: TOKEN_OF(sent.body.links[1].path) });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /withdrawn|declined/i);

  const letterAfter = await partner('GET', `/api/co/letters/${letter.id}`);
  assert.equal(letterAfter.body.letter.sealed, false, 'nothing was signed, so nothing is sealed');
});

test('withdrawing kills every outstanding link and tells whoever opens one', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });
  const token = TOKEN_OF(sent.body.links[0].path);

  const voided = await partner('POST', `/api/co/envelopes/${sent.body.envelope.id}/void`, {
    reason: 'The wrong version went out.',
  });
  assert.equal(voided.status, 200);

  const dead = await anyone('POST', '/api/co/sign/open', { token });
  assert.equal(dead.status, 403);
  assert.match(dead.body.error, /wrong version went out/);
});

test('an access code is asked for before anything at all is shown', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner, 'Settlement of the disputed assessment');
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com', accessCode: 'blue-7' }],
  });
  const token = TOKEN_OF(sent.body.links[0].path);

  const gated = await anyone('POST', '/api/co/sign/open', { token });
  assert.equal(gated.body.needsAccessCode, true);
  assert.equal(gated.body.document, undefined);
  assert.equal(gated.body.envelope, undefined, 'not even the subject line');

  const wrong = await anyone('POST', '/api/co/sign/open', { token, accessCode: 'red-9' });
  assert.equal(wrong.body.needsAccessCode, true);
  assert.equal(wrong.body.wrong, true);

  // Case and surrounding space do not matter — it is read down a telephone.
  const right = await anyone('POST', '/api/co/sign/open', { token, accessCode: '  BLUE-7 ' });
  assert.equal(right.status, 200);
  assert.equal(right.body.document.subject, 'Settlement of the disputed assessment');

  const noCode = await anyone('POST', '/api/co/sign/submit', {
    token, consent: true, name: 'Kwame Mensah',
  });
  assert.equal(noCode.status, 403, 'and signing needs it too');
});

test('reissuing a link kills the one it replaces', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'wrong@example.com' }],
  });
  const original = TOKEN_OF(sent.body.links[0].path);
  const recipientId = env.DB.sqlite.prepare('SELECT id FROM co_envelope_recipients').get().id;

  const fresh = await partner('POST', `/api/co/envelope-recipients/${recipientId}/reissue`, {});
  assert.equal(fresh.status, 200);
  const replacement = TOKEN_OF(fresh.body.link.path);
  assert.notEqual(replacement, original);

  assert.equal((await anyone('POST', '/api/co/sign/open', { token: original })).status, 403);
  assert.equal((await anyone('POST', '/api/co/sign/open', { token: replacement })).status, 200);
});

test('a made-up token is refused exactly like a real one that has expired', async () => {
  const env = environment();
  const anyone = outsider(env);

  const nonsense = await anyone('POST', '/api/co/sign/open', { token: 'not-a-real-token' });
  assert.equal(nonsense.status, 403);
  assert.match(nonsense.body.error, /not valid/);

  assert.equal((await anyone('POST', '/api/co/sign/open', { token: '' })).status, 403);
  assert.equal((await anyone('POST', '/api/co/sign/open', { token: 'x'.repeat(500) })).status, 403);
});

// ---------------------------------------------------------------------------
// The document cannot move underneath it
// ---------------------------------------------------------------------------

test('a document out for signature cannot be edited', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await aLetterFor(partner);
  await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });

  const edit = await partner('PUT', `/api/co/letters/${letter.id}`, { body: 'Different terms entirely.' });
  assert.equal(edit.status, 400);
  assert.match(edit.body.error, /out for signature/);
});

test('two live envelopes against one document are refused', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await aLetterFor(partner);
  await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'One', email: 'one@example.com' }],
  });

  const second = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Two', email: 'two@example.com' }],
  });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /already out for signature/);
});

test('an envelope of viewers is refused: it asks nothing of anybody', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const letter = await aLetterFor(partner);

  const useless = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Just watching', role: 'viewer' }],
  });
  assert.equal(useless.status, 400);
  assert.match(useless.body.error, /sign or approve/);
});

test('a registry clerk cannot send a document out for signature', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const letter = await aLetterFor(partner);
  const refused = await clerk('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah' }],
  });
  assert.equal(refused.status, 403);
});

// ---------------------------------------------------------------------------
// The certificate
// ---------------------------------------------------------------------------

test('the certificate records everything, and never the token', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com', accessCode: 'code-1' }],
  });
  const token = TOKEN_OF(sent.body.links[0].path);

  await anyone('POST', '/api/co/sign/open', { token, accessCode: 'code-1' });
  await anyone('POST', '/api/co/sign/submit', {
    token, accessCode: 'code-1', consent: true, name: 'Kwame Mensah', method: 'typed',
  });

  const cert = await partner('GET', `/api/co/envelopes/${sent.body.envelope.id}/certificate`);
  assert.equal(cert.status, 200);
  assert.equal(cert.body.envelope.status, 'completed');
  assert.ok(cert.body.envelope.content_hash);

  const [recipient] = cert.body.recipients;
  assert.equal(recipient.name, 'Kwame Mensah');
  assert.equal(recipient.status, 'signed');
  assert.equal(recipient.ip, '198.51.100.7');
  assert.equal(recipient.user_agent, 'TestBrowser/1.0');
  assert.equal(recipient.requiredAccessCode, true);
  assert.equal(recipient.token_hash, undefined, 'never, not even to a partner');
  assert.equal(recipient.access_code_hash, undefined);

  const actions = cert.body.events.map((e) => e.action);
  assert.ok(actions.includes('envelope.sent'));
  assert.ok(actions.includes('envelope.opened'));
  assert.ok(actions.includes('envelope.signed'));
});

// ---------------------------------------------------------------------------
// Chasing and expiry
// ---------------------------------------------------------------------------

test('the sweep chases an outstanding envelope once per reminder period', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    reminderDays: 3,
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });

  // Nothing to chase on the day it went out.
  assert.equal((await runSweep(env.DB, env, new Date())).envelopesChased, 0);

  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  env.DB.sqlite.prepare('UPDATE co_envelopes SET sent_at = ? WHERE id = ?')
    .run(fourDaysAgo, sent.body.envelope.id);

  assert.equal((await runSweep(env.DB, env, new Date())).envelopesChased, 1);
  assert.equal((await runSweep(env.DB, env, new Date())).envelopesChased, 0, 'not every hour');

  const notices = env.DB.sqlite.prepare(
    "SELECT * FROM app_notices WHERE kind = 'co_envelope_chase'",
  ).all();
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /Kwame Mensah/);
});

test('a link that runs out is expired, and the firm is told', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    expiryDays: 1,
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });
  const token = TOKEN_OF(sent.body.links[0].path);

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  env.DB.sqlite.prepare('UPDATE co_envelopes SET expires_at = ? WHERE id = ?')
    .run(yesterday, sent.body.envelope.id);

  const result = await runSweep(env.DB, env, new Date());
  assert.equal(result.envelopesExpired, 1);

  const envelope = env.DB.sqlite.prepare('SELECT status FROM co_envelopes').get();
  assert.equal(envelope.status, 'expired');

  const dead = await anyone('POST', '/api/co/sign/open', { token });
  assert.equal(dead.status, 403);
  assert.match(dead.body.error, /expired/i);
});

test('a signed envelope is neither chased nor expired', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = outsider(env);

  const letter = await aLetterFor(partner);
  const sent = await partner('POST', `/api/co/letters/${letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'k@example.com' }],
  });
  await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(sent.body.links[0].path), consent: true, name: 'Kwame Mensah',
  });

  const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  env.DB.sqlite.prepare('UPDATE co_envelopes SET sent_at = ?, expires_at = ?')
    .run(longAgo, longAgo);

  const result = await runSweep(env.DB, env, new Date());
  assert.equal(result.envelopesChased, 0);
  assert.equal(result.envelopesExpired, 0);
});

// ---------------------------------------------------------------------------
// A signature you keep
// ---------------------------------------------------------------------------

test('a saved signature is stored, returned, replaced and cleared', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const before = await partner('GET', '/api/co/my-signature');
  assert.equal(before.status, 200);
  assert.equal(before.body.image, null);
  assert.equal(before.body.signatureName, 'Ama Serwaa', 'falls back to the account name');

  const saved = await partner('PUT', '/api/co/my-signature', {
    method: 'uploaded',
    image: 'data:image/png;base64,iVBORw0KGgoAAAA=',
  });
  assert.equal(saved.status, 200);

  const after = await partner('GET', '/api/co/my-signature');
  assert.equal(after.body.method, 'uploaded');
  assert.match(after.body.image, /^data:image\/png;base64,/);

  await partner('PUT', '/api/co/my-signature', {
    method: 'drawn', image: 'data:image/webp;base64,UklGRg==',
  });
  assert.equal((await partner('GET', '/api/co/my-signature')).body.method, 'drawn');

  await partner('PUT', '/api/co/my-signature', { clear: true });
  assert.equal((await partner('GET', '/api/co/my-signature')).body.image, null);
});

test('a saved signature has to actually be an image', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const script = await partner('PUT', '/api/co/my-signature', {
    method: 'uploaded',
    image: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  });
  assert.equal(script.status, 400);
  assert.match(script.body.error, /not an image/);

  const typed = await partner('PUT', '/api/co/my-signature', {
    method: 'typed', image: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(typed.status, 400, 'a typed name is not something that can be stored and shown');
});

test('anybody signed in has a signature of their own, not just partners', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const saved = await clerk('PUT', '/api/co/my-signature', {
    method: 'drawn', image: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(saved.status, 200);
  assert.match((await clerk('GET', '/api/co/my-signature')).body.image, /^data:image\/png/);
});

test('signing internally accepts an uploaded image as readily as a drawn one', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await aLetterFor(partner);
  const signed = await partner('POST', `/api/co/letters/${letter.id}/sign`, {
    name: 'Ama Serwaa',
    method: 'uploaded',
    image: 'data:image/jpeg;base64,/9j/4AAQ',
  });
  assert.equal(signed.status, 200);

  const full = await partner('GET', `/api/co/letters/${letter.id}`);
  assert.equal(full.body.signatures[0].method, 'uploaded');
  assert.match(full.body.signatures[0].image, /^data:image\/jpeg/);
});
