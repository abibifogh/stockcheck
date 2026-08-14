import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { createToken } from '../src/lib/auth.js';

/**
 * The correspondence API, driven through the Worker itself.
 *
 * The unit tests above cover what the pieces decide. This one covers whether
 * they are wired together: that the route table names handlers that exist, that
 * the permission on each route is the one the screen needs, and that a letter
 * can actually travel from being logged at the front desk to being signed and
 * closed without anybody touching the database by hand.
 */

const SECRET = 'test-session-secret';

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/correspondence-database.sql', 'utf8'));
  sqlite.exec(readFileSync('seed/correspondence-starter.sql', 'utf8'));

  for (const [id, name, role] of [
    [1, 'Ama Serwaa', 'partner'],
    [2, 'Kofi Owusu', 'practice_manager'],
    [3, 'Efua Blay', 'registry_clerk'],
  ]) {
    sqlite.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(id, name, role);
  }
  sqlite.prepare("UPDATE co_departments SET head_user_id = 2 WHERE code = 'TAX'").run();

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

/** A signed-in caller. Returns the parsed body and the status. */
function client(env, cookie) {
  return async function call(method, path, body) {
    const request = new Request(`https://cms.example.com${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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

// ---------------------------------------------------------------------------

test('a letter travels from the front desk to signed and closed', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  const partner = client(env, await cookieFor(1, 'partner'));

  // The clerk logs a client into the party list, then the post.
  const client1 = await clerk('POST', '/api/co/parties', { name: 'Kwame Foods Ltd', kind: 'client', tin: 'C0001234' });
  assert.equal(client1.status, 403, 'the registry clerk keeps the post, not the client list');

  const added = await partner('POST', '/api/co/parties', { name: 'Kwame Foods Ltd', kind: 'client', tin: 'C0001234' });
  assert.equal(added.status, 201);

  const category = env.DB.sqlite.prepare("SELECT id FROM co_categories WHERE prefix = 'TAX'").get();

  const registered = await clerk('POST', '/api/co/letters', {
    type: 'incoming',
    subject: 'Assessment for year ended 31 December 2025',
    body: 'Please explain the difference between the return and the accounts.',
    partyId: added.body.party.id,
    categoryId: category.id,
    priority: 'high',
    channel: 'post',
    theirRef: 'GRA/LTU/2026/118',
    noWorkflow: true,
  });
  assert.equal(registered.status, 201);
  const letter = registered.body.letter;
  assert.match(letter.ref, /^TAX-\d{4}-0001$/, 'the category prefix, not the kind');
  assert.equal(letter.status, 'registered', 'incoming post has already arrived');
  assert.ok(letter.due_at, 'and it has a deadline from the category');

  // It goes to the partner for approval.
  const routed = await clerk('POST', `/api/co/letters/${letter.id}/routes`, {
    toUserId: 1,
    action: 'approve',
    instruction: 'Please look before we reply.',
  });
  assert.equal(routed.status, 201);

  // A letter waiting on an approval cannot be marked as sent.
  const premature = await clerk('POST', `/api/co/letters/${letter.id}/status`, { status: 'dispatched' });
  assert.equal(premature.status, 400);
  assert.match(premature.body.error, /waiting for approval or signature/);

  // The partner sees it on their desk.
  const desk = await partner('GET', '/api/co/mine');
  assert.equal(desk.status, 200);
  assert.equal(desk.body.routes.length, 1);
  assert.equal(desk.body.routes[0].ref, letter.ref);

  // …and approves it.
  const decided = await partner('POST', `/api/co/routes/${routed.body.route.id}/act`, {
    act: 'complete', decision: 'approved', comment: 'Content. Reply as drafted.',
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.decision, 'approved');

  // Signing seals it.
  const signed = await partner('POST', `/api/co/letters/${letter.id}/sign`, {
    name: 'Ama Serwaa', title: 'FCCA, Partner', method: 'typed',
  });
  assert.equal(signed.status, 200);

  // And now it cannot be edited.
  const edit = await partner('PUT', `/api/co/letters/${letter.id}`, { subject: 'Something else entirely' });
  assert.equal(edit.status, 400);
  assert.match(edit.body.error, /sealed and signed/);

  // The record checks out.
  const verified = await partner('GET', `/api/co/letters/${letter.id}/verify`);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.trail.ok, true);
  assert.equal(verified.body.sealsValid, true);
  assert.equal(verified.body.documentMoved, false);
  assert.ok(verified.body.trail.checked >= 4, 'registered, routed, approved, signed');

  // Closing it clears what was still outstanding.
  const closed = await clerk('POST', `/api/co/letters/${letter.id}/status`, { status: 'closed' });
  assert.equal(closed.status, 200);

  const full = await partner('GET', `/api/co/letters/${letter.id}`);
  assert.equal(full.body.letter.status, 'closed');
  assert.equal(full.body.signatures.length, 1);
  assert.equal(full.body.signaturesValid, true);
});

test('registering in a category with a workflow starts it with nothing to press', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  const category = env.DB.sqlite.prepare(
    "SELECT id FROM co_categories WHERE name = 'Tax — assessments and queries'",
  ).get();

  const registered = await clerk('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Query on input VAT', categoryId: category.id,
  });
  assert.equal(registered.status, 201);

  const detail = await clerk('GET', `/api/co/letters/${registered.body.letter.id}`);
  assert.equal(detail.body.routes.length, 1, 'the first step opened on its own');
  assert.equal(detail.body.routes[0].to_name, 'Tax');
  assert.equal(detail.body.workflow.workflow_name, 'Incoming tax correspondence');
  assert.equal(detail.body.letter.status, 'in_progress');
});

test('a pool route is claimed by whoever acts on it first', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  const manager = client(env, await cookieFor(2, 'practice_manager'));

  const tax = env.DB.sqlite.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").get();
  const registered = await clerk('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Payroll query', noWorkflow: true,
  });
  const routed = await clerk('POST', `/api/co/letters/${registered.body.letter.id}/routes`, {
    toDepartmentId: tax.id, action: 'action',
  });
  assert.equal(routed.body.route.to_user_id, null);

  const taken = await manager('POST', `/api/co/routes/${routed.body.route.id}/act`, { act: 'acknowledge' });
  assert.equal(taken.status, 200);

  const after = env.DB.sqlite.prepare('SELECT to_user_id, to_name FROM co_routes WHERE id = ?')
    .get(routed.body.route.id);
  assert.equal(after.to_user_id, 2, 'the pool route now has a name against it');
  assert.equal(after.to_name, 'Kofi Owusu');
});

test('somebody a letter was not sent to cannot act on it', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  const manager = client(env, await cookieFor(2, 'practice_manager'));

  const registered = await clerk('POST', '/api/co/letters', {
    type: 'incoming', subject: 'For the partner only', noWorkflow: true,
  });
  const routed = await clerk('POST', `/api/co/letters/${registered.body.letter.id}/routes`, {
    toUserId: 1, action: 'action',
  });

  const meddling = await manager('POST', `/api/co/routes/${routed.body.route.id}/act`, { act: 'complete' });
  assert.equal(meddling.status, 403);
  assert.match(meddling.body.error, /not with you/);
});

test('a rejection must say why', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  const partner = client(env, await cookieFor(1, 'partner'));

  const registered = await clerk('POST', '/api/co/letters', {
    type: 'outgoing', subject: 'Draft management letter', noWorkflow: true,
  });
  const routed = await clerk('POST', `/api/co/letters/${registered.body.letter.id}/routes`, {
    toUserId: 1, action: 'approve',
  });

  const silent = await partner('POST', `/api/co/routes/${routed.body.route.id}/act`, {
    act: 'complete', decision: 'rejected',
  });
  assert.equal(silent.status, 400);
  assert.match(silent.body.error, /why it was rejected/);

  const reasoned = await partner('POST', `/api/co/routes/${routed.body.route.id}/act`, {
    act: 'complete', decision: 'rejected', comment: 'The comparatives do not agree to last year.',
  });
  assert.equal(reasoned.status, 200);
});

test('a restricted letter is invisible to everybody it was not shown to', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const restricted = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Suspected irregularity', confidentiality: 'restricted', noWorkflow: true,
  });
  assert.equal(restricted.status, 201);
  const ordinary = await clerk('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Routine filing reminder', noWorkflow: true,
  });

  const clerkSees = await clerk('GET', '/api/co/letters?status=');
  const refs = clerkSees.body.letters.map((l) => l.ref);
  assert.ok(refs.includes(ordinary.body.letter.ref));
  assert.ok(!refs.includes(restricted.body.letter.ref), 'absent, not greyed out');
  assert.equal(clerkSees.body.total, 1, 'and the count does not give it away either');

  // Opening it directly is a not-found, deliberately the same answer as a
  // letter that does not exist.
  const direct = await clerk('GET', `/api/co/letters/${restricted.body.letter.id}`);
  assert.equal(direct.status, 404);

  const partnerSees = await partner('GET', '/api/co/letters?status=');
  assert.equal(partnerSees.body.letters.length, 2);
});

test('only a partner can mark something restricted', async () => {
  const env = environment();
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const registered = await clerk('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Ordinary letter', noWorkflow: true,
  });
  const raised = await clerk('PUT', `/api/co/letters/${registered.body.letter.id}`, {
    confidentiality: 'restricted',
  });
  assert.equal(raised.status, 403);
});

test('the hotel API is not there, and neither is an endpoint nobody wrote', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  for (const path of ['/api/days', '/api/mx/issues', '/api/hk/bootstrap', '/api/shop/sales']) {
    const result = await partner('GET', path);
    assert.equal(result.status, 404, `${path} should not exist on the practice`);
  }
  assert.equal((await partner('GET', '/api/co/nonsense')).status, 404);
});

test('signing in is required, and the wrong method is a 405 rather than a 404', async () => {
  const env = environment();
  const anonymous = await worker.fetch(
    new Request('https://cms.example.com/api/co/letters'), env, { waitUntil: () => {} },
  );
  assert.equal(anonymous.status, 401);

  const partner = client(env, await cookieFor(1, 'partner'));
  const wrongMethod = await partner('DELETE', '/api/co/letters');
  assert.equal(wrongMethod.status, 405, 'a 404 here would read as "we removed that endpoint"');
});

test('bootstrap gives a screen everything it needs to draw itself', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const boot = await partner('GET', '/api/co/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.user.name, 'Ama Serwaa');
  assert.ok(boot.body.departments.length >= 6);
  assert.ok(boot.body.categories.length >= 8);
  assert.ok(boot.body.templates.length >= 7);
  assert.ok(boot.body.workflows.length >= 2);
  assert.ok(boot.body.permissions.includes('co_oversight'));
  assert.deepEqual(boot.body.types.map((t) => t.key), ['incoming', 'outgoing', 'memo', 'circular']);
});

test('a template comes back with the client filled in and the rest left to type', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const party = await partner('POST', '/api/co/parties', {
    name: 'Adom Clinic', kind: 'client', contactName: 'Dr Mensah', tin: 'C0009876',
  });
  const template = env.DB.sqlite.prepare("SELECT id FROM co_templates WHERE name = 'Engagement letter'").get();

  const rendered = await partner('GET', `/api/co/templates/${template.id}/render?party=${party.body.party.id}`);
  assert.equal(rendered.status, 200);
  assert.match(rendered.body.body, /Dear Dr Mensah/);
  assert.match(rendered.body.body, /Adom Clinic/);
  assert.match(rendered.body.body, /\{\{engagement\}\}/, 'no engagement was named, so the prompt stays');
});

test('a reply template quotes their reference back at them', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const incoming = await partner('POST', '/api/co/letters', {
    type: 'incoming',
    subject: 'Query on input VAT',
    theirRef: 'GRA/LTU/2026/118',
    noWorkflow: true,
  });
  const party = await partner('POST', '/api/co/parties', {
    name: 'Kwame Foods Ltd', kind: 'client', tin: 'C0001234',
  });
  const template = env.DB.sqlite.prepare(
    "SELECT id FROM co_templates WHERE name = 'Response to a Revenue query'",
  ).get();

  const rendered = await partner(
    'GET',
    `/api/co/templates/${template.id}/render`
      + `?party=${party.body.party.id}&letter=${incoming.body.letter.id}`,
  );
  assert.equal(rendered.status, 200);
  assert.match(rendered.body.body, /Your reference: GRA\/LTU\/2026\/118/);
  assert.match(rendered.body.body, /Kwame Foods Ltd/);
  assert.ok(!rendered.body.body.includes('{{their_ref}}'), 'no placeholder left where an answer exists');

  // Without the letter it stays a prompt rather than going out blank.
  const alone = await partner('GET', `/api/co/templates/${template.id}/render`);
  assert.match(alone.body.body, /\{\{their_ref\}\}/);
});

test('a template cannot be used to read a restricted letter', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const restricted = await partner('POST', '/api/co/letters', {
    type: 'incoming',
    subject: 'Suspected irregularity',
    theirRef: 'SECRET-REF-9',
    confidentiality: 'restricted',
    noWorkflow: true,
  });
  const template = env.DB.sqlite.prepare(
    "SELECT id FROM co_templates WHERE name = 'Response to a Revenue query'",
  ).get();

  const sneaky = await clerk(
    'GET',
    `/api/co/templates/${template.id}/render?letter=${restricted.body.letter.id}`,
  );
  assert.equal(sneaky.status, 200, 'the template still renders');
  assert.ok(!sneaky.body.body.includes('SECRET-REF-9'), 'but tells them nothing about the letter');
  assert.match(sneaky.body.body, /\{\{their_ref\}\}/);
});

test('an engagement takes a reference from the same register as the letters', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const party = await partner('POST', '/api/co/parties', { name: 'Kwame Foods Ltd', kind: 'client' });
  const engagement = await partner('POST', '/api/co/cases', {
    title: 'Statutory audit 2026',
    partyId: party.body.party.id,
    engagementType: 'audit',
    periodLabel: 'Year ended 31 December 2026',
    statutoryDue: '2027-06-30',
    partnerUserId: 1,
    budgetHours: 120,
  });
  assert.equal(engagement.status, 201);
  assert.match(engagement.body.case.ref, /^ENG-\d{4}-0001$/);

  const detail = await partner('GET', `/api/co/cases/${engagement.body.case.id}`);
  assert.equal(detail.body.case.party_name, 'Kwame Foods Ltd');
  assert.deepEqual(detail.body.letters, []);
});

test('minutes turn agreed actions into tracked action points', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const meeting = await partner('POST', '/api/co/meetings', {
    title: 'Partners meeting',
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    durationMins: 60,
    attendees: [{ userId: 2 }],
  });
  assert.equal(meeting.status, 201);

  const minuted = await partner('POST', `/api/co/meetings/${meeting.body.meeting.id}/minutes`, {
    minutes: 'Discussed the year-end timetable. Two matters carried forward.',
    actionPoints: [
      { title: 'Write to the Registrar', assigneeUserId: 2, dueAt: '2026-09-01T17:00:00Z' },
      { title: 'Circulate the revised fee schedule', assigneeUserId: 1 },
      { title: '' },
    ],
  });
  assert.equal(minuted.status, 200);
  assert.equal(minuted.body.actionPoints, 2, 'the blank row is not an action point');

  const tasks = await partner('GET', '/api/co/tasks?status=open');
  assert.equal(tasks.body.tasks.length, 2);
  assert.equal(tasks.body.tasks.find((t) => t.title === 'Write to the Registrar').assignee_name, 'Kofi Owusu');

  const held = env.DB.sqlite.prepare('SELECT status, minutes_by FROM co_meetings WHERE id = ?')
    .get(meeting.body.meeting.id);
  assert.equal(held.status, 'held');
  assert.equal(held.minutes_by, 'Ama Serwaa');
});

test('a recurring meeting stores the rule and the first occurrence separately', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const created = await partner('POST', '/api/co/meetings', {
    title: 'Monday briefing',
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    recurrence: 'weekly',
    attendees: [{ userId: 2 }, { userId: 3 }],
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.seriesId);

  const listed = await partner('GET', '/api/co/meetings');
  assert.equal(listed.body.series.length, 1, 'the rule');
  assert.equal(listed.body.meetings.length, 1, 'and the one occurrence actually in the diary');
  assert.equal(listed.body.meetings[0].attendee_count, 2);
});

test('the register exports as a spreadsheet, and respects who may see what', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const manager = client(env, await cookieFor(2, 'practice_manager'));

  await partner('POST', '/api/co/letters', { type: 'incoming', subject: 'Ordinary', noWorkflow: true });
  await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Restricted matter', confidentiality: 'restricted', noWorkflow: true,
  });

  const full = await partner('GET', '/api/co/export');
  assert.match(full.body, /Restricted matter/);

  const partial = await manager('GET', '/api/co/export');
  assert.match(partial.body, /Ordinary/);
  assert.ok(!partial.body.includes('Restricted matter'), 'the export is not a way round the register');
});

test('the dashboard counts what is late and what is coming', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const registered = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Late one', noWorkflow: true,
  });
  env.DB.sqlite.prepare("UPDATE co_letters SET due_at = '2020-01-01T00:00:00Z' WHERE id = ?")
    .run(registered.body.letter.id);

  const overview = await partner('GET', '/api/co/reports/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.overdue, 1);
  assert.equal(overview.body.statuses.registered, 1);
  assert.equal(overview.body.turnaround.closed, 0);
  assert.equal(overview.body.turnaround.averageDays, null, 'nothing has closed, so there is no average');
});

test('productivity reports on people without inventing numbers for a quiet week', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const report = await partner('GET', '/api/co/reports/productivity?from=2026-01-01&to=2026-12-31');
  assert.equal(report.status, 200);
  assert.equal(report.body.people.length, 3);

  const ama = report.body.people.find((p) => p.name === 'Ama Serwaa');
  assert.equal(ama.averageHours, null, 'no completed routes means no average, not zero');
  assert.equal(ama.clearance, null);
  assert.equal(ama.openNow, 0);
});

test('activity and retention answer without a database of history behind them', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'One', channel: 'post', noWorkflow: true,
  });

  const activity = await partner('GET', '/api/co/reports/activity?from=2000-01-01&to=2099-12-31');
  assert.equal(activity.status, 200);
  assert.equal(activity.body.summary.registered, 1);
  assert.equal(activity.body.summary.closed, 0);
  assert.equal(activity.body.summary.averageDays, null, 'nothing closed, so no average');
  assert.equal(activity.body.channels.find((c) => c.channel === 'post').n, 1);

  const retention = await partner('GET', '/api/co/reports/retention');
  assert.equal(retention.status, 200);
  assert.deepEqual(retention.body.letters, [], 'nothing registered today is past its keeping period');

  const departments = await partner('GET', '/api/co/reports/departments');
  assert.equal(departments.status, 200);
  assert.ok(departments.body.departments.length >= 6);
  assert.equal(departments.body.departments[0].avg_hours, null);
});

test('an action point raised off a restricted letter does not leak its subject', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const restricted = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Suspected irregularity at Kwame Foods',
    confidentiality: 'restricted', noWorkflow: true,
  });
  await partner('POST', '/api/co/tasks', {
    title: 'Reply on the irregularity', letterId: restricted.body.letter.id, assigneeUserId: 1,
  });
  await partner('POST', '/api/co/tasks', { title: 'Ordinary thing', assigneeUserId: 1 });

  const theirs = await clerk('GET', '/api/co/tasks');
  assert.deepEqual(theirs.body.tasks.map((t) => t.title), ['Ordinary thing'],
    'the register hides the letter; the action point list must not hand it back');

  const partners = await partner('GET', '/api/co/tasks');
  assert.equal(partners.body.tasks.length, 2);
});

test('somebody else\'s action point is not yours to edit', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));

  const task = await partner('POST', '/api/co/tasks', {
    title: 'Partner’s own action', assigneeUserId: 1,
  });
  const meddling = await clerk('PUT', `/api/co/tasks/${task.body.task.id}`, { title: 'Something else' });
  assert.equal(meddling.status, 403);

  const mine = await partner('POST', '/api/co/tasks', { title: 'Clerk’s action', assigneeUserId: 3 });
  const own = await clerk('PUT', `/api/co/tasks/${mine.body.task.id}`, { status: 'done' });
  assert.equal(own.status, 200, 'but your own always is');
});

test('setup hands back the whole practice, including its workflow steps', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));

  const setup = await partner('GET', '/api/co/setup');
  assert.equal(setup.status, 200);
  assert.equal(setup.body.settings.refDigits, 4);
  assert.deepEqual(setup.body.settings.workingDays, [1, 2, 3, 4, 5]);

  const tax = setup.body.workflows.find((w) => w.name === 'Incoming tax correspondence');
  assert.equal(tax.steps.length, 2);
  assert.equal(tax.steps[0].to_department_name, 'Tax');
  assert.equal(tax.steps[1].to_permission, 'co_oversight');

  // And a clerk cannot see any of it.
  const clerk = client(env, await cookieFor(3, 'registry_clerk'));
  assert.equal((await clerk('GET', '/api/co/setup')).status, 403);
});

test('a workflow still carrying letters cannot be deleted, only switched off', async () => {
  const env = environment();
  const partner = client(env, await cookieFor(1, 'partner'));
  const category = env.DB.sqlite.prepare(
    "SELECT id FROM co_categories WHERE name = 'Tax — assessments and queries'",
  ).get();

  await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'In flight', categoryId: category.id,
  });

  const workflow = env.DB.sqlite.prepare(
    "SELECT id FROM co_workflows WHERE name = 'Incoming tax correspondence'",
  ).get();

  const deleted = await partner('DELETE', `/api/co/setup/workflows/${workflow.id}`);
  assert.equal(deleted.status, 400);
  assert.match(deleted.body.error, /part-way through/);

  const switchedOff = await partner('PUT', `/api/co/setup/workflows/${workflow.id}`, {
    name: 'Incoming tax correspondence', active: false, steps: [],
  });
  assert.equal(switchedOff.status, 200);
});

/**
 * A bucket, in memory.
 *
 * Enough of the R2 interface for the three calls the attachment handlers make.
 * Holding the raw bytes is the point: the test below reads them back out and
 * checks the plaintext is genuinely not in there.
 */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) { objects.set(key, { value: new Uint8Array(value), options }); },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { arrayBuffer: async () => stored.value.buffer.slice(stored.value.byteOffset, stored.value.byteOffset + stored.value.byteLength) };
    },
    async delete(key) { objects.delete(key); },
  };
}

async function upload(env, cookie, letterId, { name = 'assessment.pdf', type = 'application/pdf', body = 'scanned letter' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([body], { type }), name);
  form.append('letterId', String(letterId));
  const response = await worker.fetch(
    new Request('https://cms.example.com/api/co/attachments', { method: 'POST', headers: { Cookie: cookie }, body: form }),
    env, { waitUntil: () => {} },
  );
  return { status: response.status, body: await response.json() };
}

test('an attachment goes into the bucket encrypted and comes back out readable', async () => {
  const env = environment();
  env.FILES = bucket();
  const cookie = await cookieFor(1, 'partner');
  const partner = client(env, cookie);

  const letter = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'With a scan', noWorkflow: true,
  });

  const secret = 'the client has understated turnover by 400,000';
  const attached = await upload(env, cookie, letter.body.letter.id, { body: secret });
  assert.equal(attached.status, 201);
  assert.equal(attached.body.attachment.name, 'assessment.pdf');
  assert.ok(attached.body.attachment.sha256, 'the plaintext fingerprint is recorded');

  // What is actually sitting in the bucket is not the document.
  const [stored] = [...env.FILES.objects.values()];
  const raw = new TextDecoder().decode(stored.value);
  assert.ok(!raw.includes(secret), 'a leaked bucket object must not be a leaked document');
  assert.ok(stored.value.length > secret.length, 'ciphertext carries its IV and tag');

  // And it comes back through the Worker as the file it was.
  const download = await worker.fetch(
    new Request(`https://cms.example.com/api/co/attachments/${attached.body.attachment.id}`, { headers: { Cookie: cookie } }),
    env, { waitUntil: () => {} },
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'application/pdf');
  assert.equal(await download.text(), secret);
});

test('a file on a restricted letter is not downloadable by somebody who cannot see it', async () => {
  const env = environment();
  env.FILES = bucket();
  const partnerCookie = await cookieFor(1, 'partner');
  const clerkCookie = await cookieFor(3, 'registry_clerk');
  const partner = client(env, partnerCookie);

  const letter = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Restricted', confidentiality: 'restricted', noWorkflow: true,
  });
  const attached = await upload(env, partnerCookie, letter.body.letter.id);

  const refused = await worker.fetch(
    new Request(`https://cms.example.com/api/co/attachments/${attached.body.attachment.id}`, { headers: { Cookie: clerkCookie } }),
    env, { waitUntil: () => {} },
  );
  assert.equal(refused.status, 404, 'the same answer as a file that does not exist');
});

test('a sealed letter takes no more attachments, because they are part of what was signed', async () => {
  const env = environment();
  env.FILES = bucket();
  const cookie = await cookieFor(1, 'partner');
  const partner = client(env, cookie);

  const letter = await partner('POST', '/api/co/letters', {
    type: 'outgoing', subject: 'Signed letter', noWorkflow: true,
  });
  await partner('POST', `/api/co/letters/${letter.body.letter.id}/sign`, { name: 'Ama Serwaa' });

  const late = await upload(env, cookie, letter.body.letter.id);
  assert.equal(late.status, 400);
  assert.match(late.body.error, /sealed and signed/);
});

test('a kind of file nobody attaches to a letter is refused by name', async () => {
  const env = environment();
  env.FILES = bucket();
  const cookie = await cookieFor(1, 'partner');
  const partner = client(env, cookie);

  const letter = await partner('POST', '/api/co/letters', {
    type: 'incoming', subject: 'Anything', noWorkflow: true,
  });
  const refused = await upload(env, cookie, letter.body.letter.id, {
    name: 'run.sh', type: 'application/x-sh', body: 'rm -rf /',
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /cannot be attached/);
});

test('file storage that has not been set up says so instead of failing obscurely', async () => {
  const env = environment(); // no FILES binding
  const refused = await upload(env, await cookieFor(1, 'partner'), 1);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /R2 bucket and bind it as FILES/);
});
