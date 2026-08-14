import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createToken } from '../src/lib/auth.js';
import { resetSigningThrottle } from '../src/lib/envelopes.js';
import { openSecret, sealSecret } from '../src/lib/co-crypto.js';
import { absoluteUrl, mailConfigured, signingEmail } from '../src/lib/co-email.js';
import { runSweep } from '../src/lib/co-workflow.js';

/**
 * Email.
 *
 * The failures worth catching are not "did we call the provider" — they are
 * whether a reminder carries a link that still works, whether a message goes
 * out at all when nobody has configured anything, and whether a failure to send
 * is loud enough that somebody notices before a client does not sign.
 *
 * The provider is replaced by a recording stub, so nothing here reaches the
 * network and every message can be read back and checked.
 */

const SECRET = 'test-session-secret';

/** Stand in for the provider, and keep everything it was asked to send. */
function mailbox() {
  const sent = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(options.body);
      sent.push(body);
      return new Response('{"id":"test"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return original(url, options);
  };

  return {
    sent,
    /** Everything sent to one address, newest last. */
    to(address) {
      return sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(address));
    },
    restore() { globalThis.fetch = original; },
    fail(message = 'Domain is not verified') {
      globalThis.fetch = async (url) => {
        if (String(url).includes('api.resend.com')) {
          return new Response(JSON.stringify({ message }), { status: 403 });
        }
        return original(url);
      };
    },
  };
}

function environment({ withProvider = true } = {}) {
  resetSigningThrottle();

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/correspondence-database.sql', 'utf8'));

  for (const [id, name, role, email] of [
    [1, 'Ama Serwaa', 'partner', 'ama@firm.test'],
    [2, 'Kofi Owusu', 'practice_manager', 'kofi@firm.test'],
    [3, 'Efua Blay', 'registry_clerk', null],
  ]) {
    sqlite.prepare('INSERT INTO users (id, name, role, email) VALUES (?, ?, ?, ?)')
      .run(id, name, role, email);
  }

  // What a firm fills in on the Email card.
  for (const [key, value] of [
    ['email_from', 'practice@firm.test'],
    ['co_email_sender_name', 'Serwaa & Co'],
    ['co_email_reply_to', 'office@firm.test'],
    ['site_url', 'https://cms.firm.test'],
    ['co_firm_name', 'Serwaa & Co'],
  ]) {
    sqlite.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
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
    ...(withProvider ? { RESEND_API_KEY: 're_test_key' } : {}),
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
    const response = await worker.fetch(new Request(`https://cms.firm.test${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': '203.0.113.9',
      },
      body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: () => {} });
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, body: type.includes('json') ? await response.json() : await response.text() };
  };
}

const TOKEN_OF = (path) => new URL(`https://x${path}`).searchParams.get('t');

async function anEnvelope(partner, { recipients, ...rest } = {}) {
  const letter = await partner('POST', '/api/co/letters', {
    type: 'outgoing', subject: 'Engagement letter 2026', body: 'Please sign.', noWorkflow: true,
  });
  const sent = await partner('POST', `/api/co/letters/${letter.body.letter.id}/envelopes`, {
    recipients: recipients ?? [{ name: 'Kwame Mensah', email: 'kwame@client.test' }],
    ...rest,
  });
  return { letter: letter.body.letter, sent };
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('a sealed link comes back out, and only with the right secret', async () => {
  const env = { DOC_SECRET: 'the-real-one' };
  const sealed = await sealSecret(env, 'a-signing-token-value');

  assert.notEqual(sealed, 'a-signing-token-value', 'not stored in the clear');
  assert.equal(await openSecret(env, sealed), 'a-signing-token-value');

  assert.equal(await openSecret({ DOC_SECRET: 'a stolen database has no secret' }, sealed), null);
  assert.equal(await openSecret(env, 'not-a-sealed-value'), null, 'rubbish opens to null, not a throw');
  assert.equal(await openSecret(env, null), null);
  assert.equal(await sealSecret(env, ''), null);
});

test('two seals of the same value differ, so the store leaks nothing', async () => {
  const env = { DOC_SECRET: 'x' };
  const a = await sealSecret(env, 'same-token');
  const b = await sealSecret(env, 'same-token');
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.equal(await openSecret(env, a), await openSecret(env, b));
});

test('email is only configured when both halves exist', () => {
  assert.equal(mailConfigured({ RESEND_API_KEY: 'k' }, { email_from: 'a@b.com' }), true);
  assert.equal(mailConfigured({}, { email_from: 'a@b.com' }), false, 'no provider key');
  assert.equal(mailConfigured({ RESEND_API_KEY: 'k' }, {}), false, 'no from address');
  assert.equal(mailConfigured({ RESEND_API_KEY: 'k' }, { email_from: '   ' }), false);
});

test('links are absolute, or absent — never half-built', () => {
  assert.equal(absoluteUrl({ site_url: 'https://cms.firm.test/' }, '/sign?t=abc'),
    'https://cms.firm.test/sign?t=abc');
  assert.equal(absoluteUrl({ site_url: 'https://cms.firm.test' }, 'sign'), 'https://cms.firm.test/sign');
  assert.equal(absoluteUrl({}, '/sign'), null, 'no site address means no link at all');
});

test('the invitation says what is being asked, and the chaser says how long', () => {
  const base = {
    firmName: 'Serwaa & Co',
    envelope: { subject: 'Engagement letter', created_by_name: 'Ama', message: null },
    letterRef: 'OUT-2026-0001',
    url: 'https://cms.firm.test/sign?t=x',
  };

  const invite = signingEmail({ ...base, recipient: { name: 'Kwame', role: 'signer' } });
  assert.match(invite.subject, /^Please sign: Engagement letter$/);
  assert.match(invite.html, /do not need an account or a password/);

  const approve = signingEmail({ ...base, recipient: { name: 'Kwame', role: 'approver' } });
  assert.match(approve.subject, /^Please approve/);

  const copy = signingEmail({ ...base, recipient: { name: 'Kwame', role: 'viewer' } });
  assert.match(copy.subject, /^For your records/);
  assert.match(copy.html, /Nothing is needed from you/);

  const chase = signingEmail({
    ...base, recipient: { name: 'Kwame', role: 'signer' }, chasing: true, daysWaiting: 4,
  });
  assert.match(chase.subject, /^Reminder:/);
  assert.match(chase.html, /4 days ago/);
  assert.match(chase.html, /already dealt with it, please ignore/);

  const yesterday = signingEmail({
    ...base, recipient: { name: 'Kwame', role: 'signer' }, chasing: true, daysWaiting: 1,
  });
  assert.match(yesterday.html, /yesterday/, 'not "1 days ago"');
});

test('an access code is never in the message that carries the link', () => {
  const mail = signingEmail({
    firmName: 'Serwaa & Co',
    recipient: { name: 'Kwame', role: 'signer', access_code_hash: 'set' },
    envelope: { subject: 'Engagement letter', created_by_name: 'Ama', message: null },
    letterRef: 'OUT-2026-0001',
    url: 'https://cms.firm.test/sign?t=x',
  });
  assert.match(mail.html, /code we gave you separately/,
    'it says a code is needed');
  assert.ok(!/access code.*[A-Z0-9]{4}/i.test(mail.html.replace(/Access code/gi, '')),
    'a code sent alongside the link it protects is not a second factor, it is a longer link');
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test('sending a request emails the link, and the link in it works', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = client(env, null);

  const { sent } = await anEnvelope(partner);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.email.sent, 1);

  const [message] = post.to('kwame@client.test');
  assert.ok(message, 'the client was emailed');
  assert.equal(message.from, 'Serwaa & Co <practice@firm.test>');
  assert.equal(message.reply_to, 'office@firm.test');
  assert.match(message.subject, /Please sign/);

  // The link inside the email is a working one.
  const url = message.html.match(/https:\/\/cms\.firm\.test\/sign\?t=[\w-]+/)[0];
  const opened = await anyone('POST', '/api/co/sign/open', { token: TOKEN_OF(url.slice('https://cms.firm.test'.length)) });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.you.name, 'Kwame Mensah');

  // And the row records that it left.
  const row = env.DB.sqlite.prepare('SELECT invite_sent_at, last_email_error FROM co_envelope_recipients').get();
  assert.ok(row.invite_sent_at);
  assert.equal(row.last_email_error, null);
});

test('a reminder repeats the same link rather than breaking the first one', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = client(env, null);

  const { sent } = await anEnvelope(partner, { reminderDays: 3 });
  const original = TOKEN_OF(sent.body.links[0].path);

  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  env.DB.sqlite.prepare('UPDATE co_envelopes SET sent_at = ?').run(fourDaysAgo);

  const swept = await runSweep(env.DB, env, new Date());
  assert.equal(swept.envelopesChased, 1);
  assert.equal(swept.recipientsChased, 1, 'the client, not just the firm');

  const messages = post.to('kwame@client.test');
  assert.equal(messages.length, 2, 'the invitation and the chaser');
  assert.match(messages[1].subject, /^Reminder:/);

  const chased = messages[1].html.match(/\/sign\?t=([\w-]+)/)[1];
  assert.equal(chased, original,
    'a client who goes back to the first email must not find a dead link');

  // And it genuinely still opens.
  assert.equal((await anyone('POST', '/api/co/sign/open', { token: original })).status, 200);
});

test('a reminder does not chase somebody who was only copied in', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  await anEnvelope(partner, {
    routing: 'parallel',
    reminderDays: 1,
    recipients: [
      { name: 'Kwame Mensah', email: 'kwame@client.test' },
      { name: 'Their accountant', email: 'copy@client.test', role: 'viewer' },
    ],
  });

  assert.equal(post.to('copy@client.test').length, 1, 'they got their copy');

  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  env.DB.sqlite.prepare('UPDATE co_envelopes SET sent_at = ?').run(twoDaysAgo);
  await runSweep(env.DB, env, new Date());

  assert.equal(post.to('kwame@client.test').length, 2, 'the signer is chased');
  assert.equal(post.to('copy@client.test').length, 1, 'nothing was ever asked of them');
});

test('the next person in the queue is emailed when their turn comes', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = client(env, null);

  const { sent } = await anEnvelope(partner, {
    routing: 'sequential',
    recipients: [
      { name: 'First Director', email: 'one@client.test' },
      { name: 'Second Director', email: 'two@client.test' },
    ],
  });

  assert.equal(post.to('one@client.test').length, 1);
  assert.equal(post.to('two@client.test').length, 0, 'not until it is their turn');

  await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(sent.body.links[0].path), consent: true, name: 'First Director',
  });

  assert.equal(post.to('two@client.test').length, 1, 'now they are told');
  assert.match(post.to('two@client.test')[0].subject, /Please sign/);
});

test('everybody who signed gets a receipt when it completes', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = client(env, null);

  const { sent } = await anEnvelope(partner);
  await anyone('POST', '/api/co/sign/submit', {
    token: TOKEN_OF(sent.body.links[0].path), consent: true, name: 'Kwame Mensah',
  });

  const receipt = post.to('kwame@client.test').at(-1);
  assert.match(receipt.subject, /^Signed:/);
  assert.match(receipt.html, /now fully signed/);
  assert.match(receipt.html, /Kwame Mensah/);
});

test('a decline reaches the firm, not only the bell', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const anyone = client(env, null);

  const { sent } = await anEnvelope(partner);
  await anyone('POST', '/api/co/sign/decline', {
    token: TOKEN_OF(sent.body.links[0].path),
    reason: 'The fee does not match what we agreed.',
  });

  const toFirm = post.to('ama@firm.test').at(-1);
  assert.match(toFirm.subject, /^Declined:/);
  assert.match(toFirm.html, /fee does not match/);
});

test('a route addressed to a person emails them; a pool route emails nobody', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Assessment', noWorkflow: true,
  });

  await partner('POST', `/api/co/letters/${letter.body.letter.id}/routes`, {
    toUserId: 2, action: 'action', instruction: 'Please deal with this.',
  });
  const toKofi = post.to('kofi@firm.test');
  assert.equal(toKofi.length, 1);
  assert.match(toKofi[0].subject, /For action: IN-/);
  assert.match(toKofi[0].html, /Please deal with this/);

  const before = post.sent.length;
  const tax = env.DB.sqlite.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").get();
  await partner('POST', `/api/co/letters/${letter.body.letter.id}/routes`, {
    toDepartmentId: tax.id, action: 'action',
  });
  assert.equal(post.sent.length, before,
    'mailing everybody in Tax about something four of them will not touch teaches a department to filter');
});

test('escalation reaches an inbox — it had to, or it would not be escalation', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const letter = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Overdue thing', noWorkflow: true,
  });
  const tax = env.DB.sqlite.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").get();
  env.DB.sqlite.prepare('UPDATE co_departments SET head_user_id = 1 WHERE id = ?').run(tax.id);
  env.DB.sqlite.prepare('INSERT INTO co_staff (user_id, department_id) VALUES (2, ?)').run(tax.id);

  const overdue = new Date(Date.now() - 48 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await partner('POST', `/api/co/letters/${letter.body.letter.id}/routes`, {
    toUserId: 2, action: 'action', dueAt: overdue,
  });
  post.sent.length = 0;

  const swept = await runSweep(env.DB, env, new Date());
  assert.equal(swept.escalated, 1);

  // The head of department and the person who is late both hear about it.
  assert.match(post.to('ama@firm.test').at(-1).subject, /late: IN-/);
  assert.match(post.to('kofi@firm.test').at(-1).subject, /late: IN-/);
});

// ---------------------------------------------------------------------------
// When it is not set up, or goes wrong
// ---------------------------------------------------------------------------

test('with no provider key nothing is emailed, and nothing fails', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment({ withProvider: false });
  const partner = client(env, await cookieFor(1, 'partner'));

  const { sent } = await anEnvelope(partner);
  assert.equal(sent.status, 201, 'the request still goes out');
  assert.equal(sent.body.email.sent, 0);
  assert.equal(post.sent.length, 0);

  // The link is still shown on screen, which is how a firm without email works.
  assert.ok(sent.body.links[0].path.startsWith('/sign?t='));

  // And nothing is recorded as a failure, because this is not one.
  const row = env.DB.sqlite.prepare('SELECT invite_sent_at, last_email_error FROM co_envelope_recipients').get();
  assert.equal(row.invite_sent_at, null);
  assert.equal(row.last_email_error, null, 'not configured is not a failure');
});

test('a provider refusal is recorded against the recipient, where somebody will see it', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());
  post.fail('The firm.test domain is not verified');

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const { sent } = await anEnvelope(partner);
  assert.equal(sent.status, 201, 'the request stands — a mail outage must not undo it');
  assert.equal(sent.body.email.failed, 1);

  const row = env.DB.sqlite.prepare('SELECT invite_sent_at, last_email_error FROM co_envelope_recipients').get();
  assert.equal(row.invite_sent_at, null);
  assert.match(row.last_email_error, /not verified/);

  const logged = env.DB.sqlite.prepare("SELECT * FROM email_log WHERE status = 'failed'").all();
  assert.equal(logged.length, 1);
});

test('a recipient with no address is counted, not silently dropped', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const { sent } = await anEnvelope(partner, {
    routing: 'parallel',
    recipients: [
      { name: 'Kwame Mensah', email: 'kwame@client.test' },
      { name: 'Walk-in signer' },
    ],
  });

  assert.equal(sent.body.email.sent, 1);
  assert.equal(sent.body.email.noAddress, 1, 'the screen can say "one has no address"');
});

test('with no site address a link would be relative, so it is refused and said', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  env.DB.sqlite.prepare("UPDATE settings SET value = '' WHERE key = 'site_url'").run();

  const partner = client(env, await cookieFor(1, 'partner'));
  const { sent } = await anEnvelope(partner);

  assert.equal(sent.body.email.sent, 0);
  assert.equal(post.sent.length, 0, 'better than a message whose button goes nowhere');

  const row = env.DB.sqlite.prepare('SELECT last_email_error FROM co_envelope_recipients').get();
  assert.match(row.last_email_error, /No site address/);
});

test('either switch turns its half off without touching the other', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  await partner('PUT', '/api/co/setup/settings', { emailRecipients: false });

  const letter = await partner('POST', '/api/co/letters', {
    type: 'outgoing', subject: 'Quiet one', noWorkflow: true,
  });
  await partner('POST', `/api/co/letters/${letter.body.letter.id}/envelopes`, {
    recipients: [{ name: 'Kwame Mensah', email: 'kwame@client.test' }],
  });
  assert.equal(post.to('kwame@client.test').length, 0, 'clients switched off');

  await partner('POST', `/api/co/letters/${letter.body.letter.id}/routes`, {
    toUserId: 2, action: 'action',
  });
  assert.equal(post.to('kofi@firm.test').length, 1, 'staff still on');

  await partner('PUT', '/api/co/setup/settings', { emailStaff: false });
  await partner('POST', `/api/co/letters/${letter.body.letter.id}/routes`, {
    toUserId: 2, action: 'review',
  });
  assert.equal(post.to('kofi@firm.test').length, 1, 'and now off too');
});

test('the test button says what is wrong rather than failing quietly', async (t) => {
  const post = mailbox();
  t.after(() => post.restore());

  const noKey = environment({ withProvider: false });
  const first = client(noKey, await cookieFor(1, 'partner'));
  const refused = await first('POST', '/api/co/setup/email-test', {});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /RESEND_API_KEY/);

  const env = environment();
  const noAddress = client(env, await cookieFor(3, 'registry_clerk'));
  // A clerk cannot reach setup at all, which is its own answer.
  assert.equal((await noAddress('POST', '/api/co/setup/email-test', {})).status, 403);

  const partner = client(env, await cookieFor(1, 'partner'));
  const ok = await partner('POST', '/api/co/setup/email-test', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.to, 'ama@firm.test');
  assert.match(post.to('ama@firm.test')[0].subject, /Test message/);
});

test('the setup screen is told whether a provider exists at all', async () => {
  const withKey = client(environment(), await cookieFor(1, 'partner'));
  assert.equal((await withKey('GET', '/api/co/setup')).body.settings.emailConfigured, true);

  const without = client(environment({ withProvider: false }), await cookieFor(1, 'partner'));
  const settings = (await without('GET', '/api/co/setup')).body.settings;
  assert.equal(settings.emailConfigured, false);
  assert.equal(settings.emailFrom, 'practice@firm.test',
    'the from address is still theirs — it is the key that is missing');
});

test('a nonsense from address or reply-to is refused before it is saved', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  assert.equal((await partner('PUT', '/api/co/setup/settings', { emailFrom: 'not-an-address' })).status, 400);
  assert.equal((await partner('PUT', '/api/co/setup/settings', { emailReplyTo: 'also nonsense' })).status, 400);

  // The named form is a perfectly good from-address and has to be allowed.
  assert.equal((await partner('PUT', '/api/co/setup/settings', {
    emailFrom: 'Serwaa & Co <practice@firm.test>',
  })).status, 200);
});
