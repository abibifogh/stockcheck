import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { createNotice, listNotices, markSeen, roundNotice } from '../src/lib/notices.js';

/**
 * The bell. Every submitted check sends an email and records one of these, and
 * the second is the one that still works when the first does not.
 */

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));
  return {
    prepare(sql) {
      const st = { sql, binds: [] };
      st.bind = (...a) => { st.binds = a; return st; };
      st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
      st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
      st.run = async () => sqlite.prepare(sql).run(...st.binds);
      return st;
    },
  };
}

test('a notice is recorded and comes back unread', async () => {
  const db = database();
  await createNotice(db, { kind: 'hk_round', title: 'Morning check submitted by Yaw', body: '24 beds checked.' });

  const { notices, unread, latestId } = await listNotices(db, 7);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Morning check submitted by Yaw');
  assert.equal(notices[0].unread, true);
  assert.equal(unread, 1);
  assert.ok(latestId > 0);
});

test('reading is per person, and one person reading does not read for everyone', async () => {
  const db = database();
  await createNotice(db, { kind: 'hk_round', title: 'Morning check' });
  await createNotice(db, { kind: 'hk_round', title: 'Evening check' });

  const before = await listNotices(db, 7);
  await markSeen(db, 7, before.latestId);

  assert.equal((await listNotices(db, 7)).unread, 0, 'the reader has caught up');
  assert.equal((await listNotices(db, 8)).unread, 2, 'and nobody else has');
});

test('acknowledging never moves backwards', async () => {
  const db = database();
  await createNotice(db, { kind: 'hk_round', title: 'One' });
  const first = await listNotices(db, 7);
  await markSeen(db, 7, first.latestId);

  await createNotice(db, { kind: 'hk_round', title: 'Two' });
  // A stale page acknowledging an older id must not resurrect what was read.
  await markSeen(db, 7, 1);

  const after = await listNotices(db, 7);
  assert.equal(after.unread, 1, 'only the new one is unread');
  assert.equal(after.notices[0].title, 'Two');
});

test('the newest is first, because that is what the bell shows', async () => {
  const db = database();
  for (const title of ['One', 'Two', 'Three']) await createNotice(db, { kind: 'hk_round', title });
  const { notices } = await listNotices(db, 7);
  assert.deepEqual(notices.map((n) => n.title), ['Three', 'Two', 'One']);
});

test('a notice is never allowed to fail the thing that caused it', async () => {
  const broken = { prepare() { throw new Error('no such table: app_notices'); } };
  assert.equal(await createNotice(broken, { kind: 'hk_round', title: 'Morning' }), null);
  assert.deepEqual(await listNotices(broken, 1), {
    notices: [], unread: 0, latestId: 0, lastSeen: 0, unavailable: true,
  });
});

// --------------------------------------------------------------- wording --

test('a round notice leads with the number somebody has to act on', () => {
  const bad = roundNotice({
    slotLabel: 'Morning check', day: '2026-08-13', submittedBy: 'Yaw',
    totals: { checked: 24, untagged: 2, unexpected: 1, unchecked: 0 },
  });
  assert.equal(bad.level, 'high', 'an untagged bed is the whole point of the system');
  assert.match(bad.title, /Morning check submitted by Yaw/);
  assert.match(bad.body, /2 without a name tag/);
  assert.match(bad.body, /1 occupied unexpectedly/);
  assert.equal(bad.link, '#/hk-report?from=2026-08-13&to=2026-08-13');

  const clean = roundNotice({
    slotLabel: 'Evening check', day: '2026-08-13', submittedBy: 'Kofi',
    totals: { checked: 24, untagged: 0, unexpected: 0, unchecked: 0 },
  });
  assert.equal(clean.level, 'info');
  assert.match(clean.body, /nothing to deal with/);

  // Unexpected occupancy without an untagged bed is a warning, not an alarm.
  const odd = roundNotice({
    slotLabel: 'Morning check', day: '2026-08-13',
    totals: { checked: 24, untagged: 0, unexpected: 1, unchecked: 3 },
  });
  assert.equal(odd.level, 'warn');
  assert.match(odd.body, /3 beds not checked/);
});

test('a resubmitted round says so, so nobody reads it as a second check', () => {
  const notice = roundNotice({
    slotLabel: 'Morning check', day: '2026-08-13', submittedBy: 'Yaw',
    totals: { checked: 24, untagged: 0 }, resubmission: true,
  });
  assert.match(notice.title, /submitted again/);
});

// --------------------------------------------------- addressed notices --

/**
 * The audience filter runs in JavaScript, because `audience` may not exist on
 * a database that has not run the upgrade and a query naming a missing column
 * fails outright. That is fine; what was not fine was asking SQL for the
 * newest twenty and filtering afterwards, so a notice addressed to somebody
 * fell off the end behind twenty addressed elsewhere.
 *
 * An approval waiting on an administrator is exactly the notice that goes
 * quiet that way, and nothing looks wrong while it does.
 */
test('an addressed notice is not pushed off the bell by unrelated ones', async () => {
  const db = database();

  // One approval, then a day of hourly sweeps addressed to somebody else.
  await createNotice(db, {
    kind: 'mx_adjustment',
    audience: 'users',
    title: 'A part issue is waiting to be removed',
  });
  for (let i = 0; i < 40; i += 1) {
    await createNotice(db, { kind: 'tool_overdue', audience: 'tools', title: `Drill ${i} is late` });
  }

  const { notices, unread } = await listNotices(db, 7, 20, ['users']);

  assert.equal(notices.length, 1, 'the one addressed to them');
  assert.equal(notices[0].title, 'A part issue is waiting to be removed');
  assert.equal(unread, 1, 'and the badge agrees with the list it opens');
});

test('an unaddressed notice still reaches everybody', async () => {
  // Every row written before audiences existed has none, and those were for
  // the whole hotel.
  const db = database();
  await createNotice(db, { kind: 'hk_round', title: 'Morning check submitted' });

  const { notices } = await listNotices(db, 7, 20, ['tools']);
  assert.equal(notices.length, 1);
});

test('the badge counts what is addressed to them, not what fits on the page', async () => {
  const db = database();
  for (let i = 0; i < 30; i += 1) {
    await createNotice(db, { kind: 'mx_adjustment', audience: 'users', title: `Request ${i}` });
  }

  const { notices, unread } = await listNotices(db, 7, 10, ['users']);

  assert.equal(notices.length, 10, 'a page of ten');
  assert.equal(unread, 30, 'but thirty are waiting, and the bell says so');
});
