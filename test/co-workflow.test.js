import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  advanceWorkflow, autoWorkflowFor, escalationTarget, runSweep, startWorkflow,
} from '../src/lib/co-workflow.js';
import { delegateFor, nowStamp } from '../src/lib/correspondence.js';

/**
 * Workflow, escalation and the sweep.
 *
 * The behaviour worth pinning down is the behaviour a plausible implementation
 * gets wrong: a step that opens one route per person in a department, an
 * escalation that quietly moves the work to a partner, a sweep that sends the
 * same reminder every hour, and a rejection that carries on to the next step
 * anyway.
 */

const env = { DOC_SECRET: 'test-secret', SESSION_SECRET: 'session' };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/correspondence-database.sql', 'utf8'));

  for (const [id, name, role] of [
    [1, 'Ama Serwaa', 'partner'], [2, 'Kofi Owusu', 'practice_manager'],
    [3, 'Efua Blay', 'practice_staff'], [4, 'Yaw Boateng', 'practice_staff'],
  ]) {
    sqlite.prepare('INSERT INTO users (id, name, role) VALUES (?, ?, ?)').run(id, name, role);
  }
  // Kofi runs Tax.
  sqlite.prepare("UPDATE co_departments SET head_user_id = 2 WHERE code = 'TAX'").run();

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

const ama = { id: 1, name: 'Ama Serwaa' };

async function aLetter(db, overrides = {}) {
  return db.prepare(
    `INSERT INTO co_letters (ref, type, subject, status, created_by, created_by_name, category_id)
     VALUES (?1, ?2, ?3, 'registered', 1, 'Ama Serwaa', ?4) RETURNING *`,
  ).bind(
    overrides.ref ?? 'TAX-2026-0001',
    overrides.type ?? 'incoming',
    overrides.subject ?? 'Assessment for 2025',
    overrides.category_id ?? null,
  ).first();
}

/** A two-step workflow: Tax deals with it, then a partner approves. */
async function aWorkflow(db, { appliesType = null, categoryId = null } = {}) {
  const tax = await db.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").first();
  const workflow = await db.prepare(
    `INSERT INTO co_workflows (name, applies_type, applies_category_id)
     VALUES ('Tax review', ?1, ?2) RETURNING *`,
  ).bind(appliesType, categoryId).first();

  await db.prepare(
    `INSERT INTO co_workflow_steps (workflow_id, seq, name, action, to_department_id, sla_hours)
     VALUES (?1, 1, 'Tax to deal with it', 'action', ?2, 48)`,
  ).bind(workflow.id, tax.id).run();
  await db.prepare(
    `INSERT INTO co_workflow_steps (workflow_id, seq, name, action, to_user_id, sla_hours)
     VALUES (?1, 2, 'Partner approval', 'approve', 1, 24)`,
  ).bind(workflow.id).run();

  return workflow;
}

// ---------------------------------------------------------------------------

test('a step opens exactly one route, even when it goes to a whole department', async () => {
  const db = database();
  const letter = await aLetter(db);
  const workflow = await aWorkflow(db);

  await startWorkflow(db, env, letter, workflow.id, ama);

  const routes = (await db.prepare('SELECT * FROM co_routes WHERE letter_id = ?').bind(letter.id).all()).results;
  assert.equal(routes.length, 1,
    'one route per person in Tax would mean five people each thinking the other four had it');
  assert.equal(routes[0].to_department_id != null, true);
  assert.equal(routes[0].to_user_id, null, 'nobody has claimed it yet');
  assert.equal(routes[0].to_name, 'Tax');
  assert.equal(routes[0].status, 'pending');
  assert.ok(routes[0].due_at, 'and it has a deadline');
});

test('a blocking step puts the letter into awaiting approval, an ordinary one does not', async () => {
  const db = database();
  const letter = await aLetter(db);
  const workflow = await aWorkflow(db);
  await startWorkflow(db, env, letter, workflow.id, ama);

  const afterStepOne = await db.prepare('SELECT status FROM co_letters WHERE id = ?').bind(letter.id).first();
  assert.equal(afterStepOne.status, 'in_progress');

  const route = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ?').bind(letter.id).first();
  await db.prepare("UPDATE co_routes SET status = 'completed' WHERE id = ?").bind(route.id).run();
  await advanceWorkflow(db, env, letter, { ...route, decision: null }, ama);

  const afterStepTwo = await db.prepare('SELECT status FROM co_letters WHERE id = ?').bind(letter.id).first();
  assert.equal(afterStepTwo.status, 'awaiting_approval', 'step two asks for approval');
});

test('completing a step opens the next one, and the last one finishes the run', async () => {
  const db = database();
  const letter = await aLetter(db, { type: 'outgoing' });
  const workflow = await aWorkflow(db);
  await startWorkflow(db, env, letter, workflow.id, ama);

  const first = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ? ORDER BY seq').bind(letter.id).first();
  await advanceWorkflow(db, env, letter, { ...first, decision: null }, ama);

  const routes = (await db.prepare('SELECT * FROM co_routes WHERE letter_id = ? ORDER BY seq').bind(letter.id).all()).results;
  assert.equal(routes.length, 2);
  assert.equal(routes[1].action, 'approve');
  assert.equal(routes[1].to_user_id, 1, 'and it went to the named partner');

  const ended = await advanceWorkflow(db, env, letter, { ...routes[1], decision: 'approved' }, ama);
  assert.equal(ended.ended, 'completed');

  const run = await db.prepare('SELECT * FROM co_workflow_runs WHERE letter_id = ?').bind(letter.id).first();
  assert.equal(run.status, 'completed');

  const after = await db.prepare('SELECT status FROM co_letters WHERE id = ?').bind(letter.id).first();
  assert.equal(after.status, 'approved', 'an approved outgoing letter is ready to send, not closed');
});

test('an incoming letter that finishes its workflow is closed rather than approved', async () => {
  const db = database();
  const letter = await aLetter(db, { type: 'incoming' });
  const workflow = await aWorkflow(db);
  await startWorkflow(db, env, letter, workflow.id, ama);

  const first = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ? ORDER BY seq').bind(letter.id).first();
  await advanceWorkflow(db, env, letter, { ...first, decision: null }, ama);
  const second = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ? ORDER BY seq DESC').bind(letter.id).first();
  await advanceWorkflow(db, env, letter, { ...second, decision: 'approved' }, ama);

  const after = await db.prepare('SELECT status, closed_at FROM co_letters WHERE id = ?').bind(letter.id).first();
  assert.equal(after.status, 'closed');
  assert.ok(after.closed_at);
});

test('a rejection stops the run where it stands and does not open the next step', async () => {
  const db = database();
  const letter = await aLetter(db);
  const workflow = await aWorkflow(db);
  await startWorkflow(db, env, letter, workflow.id, ama);

  const first = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ?').bind(letter.id).first();
  const result = await advanceWorkflow(
    db, env, letter, { ...first, decision: 'rejected', comment: 'the figures are wrong' }, ama,
  );

  assert.equal(result.ended, 'rejected');
  const routes = (await db.prepare('SELECT * FROM co_routes WHERE letter_id = ?').bind(letter.id).all()).results;
  assert.equal(routes.length, 1, 'no second step was opened');

  const run = await db.prepare('SELECT status FROM co_workflow_runs WHERE letter_id = ?').bind(letter.id).first();
  assert.equal(run.status, 'rejected');

  const after = await db.prepare('SELECT status FROM co_letters WHERE id = ?').bind(letter.id).first();
  assert.equal(after.status, 'in_progress', 'back with whoever wrote it — the only person who can act on "no"');
});

test('a letter already in a workflow does not start a second one', async () => {
  const db = database();
  const letter = await aLetter(db);
  const workflow = await aWorkflow(db);

  assert.ok(await startWorkflow(db, env, letter, workflow.id, ama));
  assert.equal(await startWorkflow(db, env, letter, workflow.id, ama), null);

  const runs = (await db.prepare('SELECT * FROM co_workflow_runs WHERE letter_id = ?').bind(letter.id).all()).results;
  assert.equal(runs.length, 1);
});

test('a workflow with no steps is refused rather than leaving a letter nowhere', async () => {
  const db = database();
  const letter = await aLetter(db);
  const empty = await db.prepare("INSERT INTO co_workflows (name) VALUES ('Empty') RETURNING *").first();

  assert.equal(await startWorkflow(db, env, letter, empty.id, ama), null);
  const runs = (await db.prepare('SELECT * FROM co_workflow_runs').all()).results;
  assert.equal(runs.length, 0, 'a run with no first step is a letter marked in progress with nobody holding it');
});

test('the category decides which workflow starts, and beats a match on the kind', async () => {
  const db = database();
  const tax = await db.prepare("SELECT id FROM co_categories WHERE prefix = 'TAX'").first();

  await db.prepare("INSERT INTO co_workflows (name, applies_type) VALUES ('Anything incoming', 'incoming')").run();
  const specific = await aWorkflow(db, { categoryId: tax.id });

  const matched = await autoWorkflowFor(db, { type: 'incoming', category_id: tax.id });
  assert.equal(matched.id, specific.id,
    '"every tax assessment goes through the tax review" is the more specific statement');

  const general = await autoWorkflowFor(db, { type: 'incoming', category_id: null });
  assert.equal(general.name, 'Anything incoming');

  assert.equal(await autoWorkflowFor(db, { type: 'memo', category_id: null }), null);
});

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

test('a route addressed to a department escalates to its head', async () => {
  const db = database();
  const tax = await db.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").first();
  assert.equal(await escalationTarget(db, { to_department_id: tax.id }), 2, 'Kofi runs Tax');
});

test('a route addressed to a person escalates to the head of their department', async () => {
  const db = database();
  const tax = await db.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").first();
  await db.prepare('INSERT INTO co_staff (user_id, department_id) VALUES (3, ?)').bind(tax.id).run();

  assert.equal(await escalationTarget(db, { to_user_id: 3 }), 2);
});

test('a head of department does not escalate to themselves', async () => {
  const db = database();
  const tax = await db.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").first();
  await db.prepare('INSERT INTO co_staff (user_id, department_id) VALUES (2, ?)').bind(tax.id).run();

  assert.equal(await escalationTarget(db, { to_user_id: 2 }), null,
    'telling somebody they are late to themselves is not an escalation');
});

test('escalation tells somebody; it never reassigns the work', async () => {
  const db = database();
  const letter = await aLetter(db);
  const tax = await db.prepare("SELECT id FROM co_departments WHERE code = 'TAX'").first();

  // A route that fell due two days ago, with the grace period long past.
  const overdue = new Date(Date.now() - 48 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_routes (letter_id, to_user_id, to_department_id, to_name, action, due_at, status)
     VALUES (?1, 3, ?2, 'Efua Blay', 'action', ?3, 'pending')`,
  ).bind(letter.id, tax.id, overdue).run();

  const result = await runSweep(db, env, new Date());
  assert.equal(result.escalated, 1);

  const route = await db.prepare('SELECT * FROM co_routes WHERE letter_id = ?').bind(letter.id).first();
  assert.equal(route.to_user_id, 3, 'still Efua\'s — moving it would give the head forty items and Efua none');
  assert.equal(route.status, 'pending');
  assert.equal(route.escalated_to, 2, 'and Kofi has been told');
  assert.ok(route.escalated_at);
});

test('the sweep is idempotent: running it again escalates nothing twice', async () => {
  const db = database();
  const letter = await aLetter(db);
  const overdue = new Date(Date.now() - 48 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_routes (letter_id, to_user_id, to_name, action, due_at, status)
     VALUES (?1, 3, 'Efua Blay', 'action', ?2, 'pending')`,
  ).bind(letter.id, overdue).run();

  const first = await runSweep(db, env, new Date());
  const second = await runSweep(db, env, new Date());

  assert.equal(first.escalated, 1);
  assert.equal(second.escalated, 0, 'a cron that fires twice must not escalate twice');

  const notices = (await db.prepare("SELECT * FROM app_notices WHERE kind = 'co_escalation'").all()).results;
  assert.equal(notices.length, 1);
});

test('a reminder goes out once, ahead of the deadline, and not after it has passed', async () => {
  const db = database();
  const letter = await aLetter(db);
  // Due in 6 hours; the default lead time is 24, so this is inside the window.
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_routes (letter_id, to_user_id, to_name, action, due_at, status)
     VALUES (?1, 3, 'Efua Blay', 'action', ?2, 'pending')`,
  ).bind(letter.id, soon).run();

  assert.equal((await runSweep(db, env, new Date())).reminded, 1);
  assert.equal((await runSweep(db, env, new Date())).reminded, 0);
});

test('an information route is neither chased nor escalated', async () => {
  const db = database();
  const letter = await aLetter(db);
  const overdue = new Date(Date.now() - 96 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_routes (letter_id, to_user_id, to_name, action, due_at, status)
     VALUES (?1, 3, 'Efua Blay', 'information', ?2, 'pending')`,
  ).bind(letter.id, overdue).run();

  const result = await runSweep(db, env, new Date());
  assert.equal(result.escalated, 0, 'nothing was asked of them, so nothing is late');
  assert.equal(result.reminded, 0);
});

test('a completed route is left alone however late it was', async () => {
  const db = database();
  const letter = await aLetter(db);
  const overdue = new Date(Date.now() - 96 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_routes (letter_id, to_user_id, to_name, action, due_at, status, completed_at)
     VALUES (?1, 3, 'Efua Blay', 'action', ?2, 'completed', ?3)`,
  ).bind(letter.id, overdue, nowStamp()).run();

  assert.equal((await runSweep(db, env, new Date())).escalated, 0);
});

test('the sweep can be switched off without removing the cron', async () => {
  const db = database();
  db.sqlite.prepare("UPDATE settings SET value = '0' WHERE key = 'co_sweep_enabled'").run();
  const result = await runSweep(db, env, new Date());
  assert.equal(result.skipped, true);
});

// ---------------------------------------------------------------------------
// Cover
// ---------------------------------------------------------------------------

test('somebody away has a delegate; somebody back does not', async () => {
  const db = database();
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  await db.prepare('INSERT INTO co_staff (user_id, away_until, delegate_user_id) VALUES (3, ?, 4)')
    .bind(future).run();
  assert.equal(await delegateFor(db, 3), 4);

  await db.prepare('UPDATE co_staff SET away_until = ? WHERE user_id = 3').bind(past).run();
  assert.equal(await delegateFor(db, 3), null, 'they are back — it is theirs again');

  assert.equal(await delegateFor(db, 4), null, 'nobody is covering for anyone else');
  assert.equal(await delegateFor(db, null), null);
});

// ---------------------------------------------------------------------------
// Recurring meetings
// ---------------------------------------------------------------------------

test('the sweep keeps one occurrence of a standing meeting in the diary, and only one', async () => {
  const db = database();
  const started = new Date(Date.now() - 21 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const series = await db.prepare(
    `INSERT INTO co_meetings (title, starts_at, recurrence, is_series, organiser_user_id, organiser_name)
     VALUES ('Partners meeting', ?1, 'weekly', 1, 1, 'Ama Serwaa') RETURNING *`,
  ).bind(started).first();
  await db.prepare(
    'INSERT INTO co_meeting_attendees (meeting_id, user_id, name) VALUES (?1, 2, \'Kofi Owusu\')',
  ).bind(series.id).run();

  const first = await runSweep(db, env, new Date());
  assert.equal(first.occurrencesCreated, 1);

  const occurrences = (await db.prepare(
    'SELECT * FROM co_meetings WHERE series_id = ?',
  ).bind(series.id).all()).results;
  assert.equal(occurrences.length, 1);
  assert.ok(new Date(occurrences[0].starts_at) > new Date(), 'and it is in the future');
  assert.equal(occurrences[0].is_series, 0);

  // The standing invitation travels with the series.
  const invited = (await db.prepare(
    'SELECT * FROM co_meeting_attendees WHERE meeting_id = ?',
  ).bind(occurrences[0].id).all()).results;
  assert.equal(invited.length, 1);
  assert.equal(invited[0].user_id, 2);

  const second = await runSweep(db, env, new Date());
  assert.equal(second.occurrencesCreated, 0, 'one ahead, not a year of rows that go wrong when the time changes');
});

test('a series past its end date stops producing occurrences', async () => {
  const db = database();
  const started = new Date(Date.now() - 60 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ended = new Date(Date.now() - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  await db.prepare(
    `INSERT INTO co_meetings (title, starts_at, recurrence, recurrence_until, is_series)
     VALUES ('Year-end planning', ?1, 'weekly', ?2, 1)`,
  ).bind(started, ended).run();

  assert.equal((await runSweep(db, env, new Date())).occurrencesCreated, 0);
});

test('an action point falling due is reminded once', async () => {
  const db = database();
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_tasks (title, assignee_user_id, assignee_name, due_at, status)
     VALUES ('Write to the Registrar', 3, 'Efua Blay', ?1, 'open')`,
  ).bind(soon).run();

  assert.equal((await runSweep(db, env, new Date())).tasksReminded, 1);
  assert.equal((await runSweep(db, env, new Date())).tasksReminded, 0);

  const notices = (await db.prepare("SELECT * FROM app_notices WHERE kind = 'co_task_due'").all()).results;
  assert.equal(notices.length, 1);
  assert.ok(notices[0].title.includes('Write to the Registrar'));
});

test('a completed action point is not chased', async () => {
  const db = database();
  const soon = new Date(Date.now() + 6 * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  await db.prepare(
    `INSERT INTO co_tasks (title, due_at, status) VALUES ('Already done', ?1, 'done')`,
  ).bind(soon).run();

  assert.equal((await runSweep(db, env, new Date())).tasksReminded, 0);
});
