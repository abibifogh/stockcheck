import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dueSchedules, nextDue } from '../src/lib/stocktakes.js';
import { inboxFor, markRead, notify } from '../src/lib/notify.js';

/**
 * Scheduling arithmetic, tested without a database or a clock.
 *
 * The cases that matter are the awkward ones: a count done late, and a
 * schedule nobody touched for months. Both have a wrong answer that looks
 * plausible — drifting the schedule, and firing a dozen missed counts at once.
 */

test('a monthly count rolls forward a month from when it was due', () => {
  assert.equal(nextDue('2026-03-01', 30, '2026-03-01'), '2026-03-31');
});

test('a count done late does not drag the schedule late with it', () => {
  // Due on the 1st, actually done on the 6th. The next one is still 30 days
  // after the 1st, not 30 days after the 6th.
  assert.equal(nextDue('2026-03-01', 30, '2026-03-06'), '2026-03-31');
});

test('a schedule left unattended catches up rather than firing every miss', () => {
  // Due in January, nobody looked until June. One count is now due, not five.
  const next = nextDue('2026-01-05', 30, '2026-06-10');
  assert.ok(next >= '2026-06-10', `${next} should be on or after today`);
  assert.ok(next < '2026-07-10', `${next} should be within one period of today`);
});

test('weekly and quarterly are the same arithmetic', () => {
  assert.equal(nextDue('2026-03-02', 7, '2026-03-02'), '2026-03-09');
  assert.equal(nextDue('2026-03-02', 90, '2026-03-02'), '2026-05-31');
});

test('a nonsense period falls back to monthly, not to every single day', () => {
  assert.equal(nextDue('2026-03-01', 0, '2026-03-01'), '2026-03-31');
  assert.equal(nextDue('2026-03-01', -5, '2026-03-01'), '2026-03-31');
  assert.equal(nextDue('2026-03-01', null, '2026-03-01'), '2026-03-31');
});

test('only active schedules that have come round are due', () => {
  const schedules = [
    { id: 1, active: 1, next_due: '2026-03-01' },   // due
    { id: 2, active: 1, next_due: '2026-03-05' },   // today
    { id: 3, active: 1, next_due: '2026-03-06' },   // not yet
    { id: 4, active: 0, next_due: '2026-01-01' },   // switched off
  ];
  assert.deepEqual(dueSchedules(schedules, '2026-03-05').map((s) => s.id), [1, 2]);
  assert.deepEqual(dueSchedules([], '2026-03-05'), []);
  assert.deepEqual(dueSchedules(undefined, '2026-03-05'), []);
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

/**
 * The smallest thing that behaves like D1 for these queries: enough to prove
 * that a notification reaches the people holding the permission and nobody
 * else, which is the only rule the bell has.
 */
function fakeDb() {
  const notifications = [];
  const reads = new Set();
  const settings = { notify_in_app: '1' };
  let nextId = 1;

  const run = (sql, params) => {
    if (/FROM settings/.test(sql)) {
      return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) };
    }
    if (/INSERT INTO notifications/.test(sql)) {
      const [kind, title, body, link, userId, audience] = params;
      const row = {
        id: nextId++, kind, title, body, link, user_id: userId, audience,
        created_at: '2026-03-05 06:00:00',
      };
      notifications.push(row);
      return row;
    }
    if (/INSERT OR IGNORE INTO notification_reads/.test(sql)) {
      reads.add(`${params[0]}:${params[1]}`);
      return { meta: { changes: 1 } };
    }
    if (/FROM notifications n/.test(sql)) {
      const userId = params[0];
      const audiences = params.slice(1);
      const results = notifications
        .filter((n) => n.user_id === userId || audiences.includes(n.audience))
        .sort((a, b) => b.id - a.id)
        .map((n) => ({ ...n, read_at: reads.has(`${n.id}:${userId}`) ? '2026-03-05' : null }));
      return { results };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  return {
    settings,
    prepare(sql) {
      return {
        bind: (...params) => ({
          all: async () => run(sql, params),
          first: async () => run(sql, params),
          run: async () => run(sql, params),
        }),
        all: async () => run(sql, []),
        first: async () => run(sql, []),
        run: async () => run(sql, []),
      };
    },
    batch: async (statements) => Promise.all(statements.map((s) => s.run())),
  };
}

const manager = { id: 7, role: 'manager' };
const cook = { id: 8, role: 'cook' };

test('a notification reaches the permission it was addressed to, and nobody else', async () => {
  const db = fakeDb();
  await notify(db, {
    kind: 'day_submitted', audience: 'reports', title: 'New breakfast report', link: '#/daily',
  });

  const forManager = await inboxFor(db, manager);
  assert.equal(forManager.notifications.length, 1);
  assert.equal(forManager.unread, 1);

  // A cook holds `entry` only, and costs are the whole reason reports are gated.
  const forCook = await inboxFor(db, cook);
  assert.equal(forCook.notifications.length, 0);
});

test('a notification addressed to one person reaches only them', async () => {
  const db = fakeDb();
  await notify(db, { kind: 'stocktake_due', title: 'Stock count due today', userId: cook.id });

  assert.equal((await inboxFor(db, cook)).notifications.length, 1);
  assert.equal((await inboxFor(db, manager)).notifications.length, 0);
});

test('reading is per person: one manager clearing does not clear another', async () => {
  const db = fakeDb();
  await notify(db, { kind: 'day_submitted', audience: 'reports', title: 'New breakfast report' });

  const other = { id: 9, role: 'manager' };
  assert.equal(await markRead(db, manager), 1);

  assert.equal((await inboxFor(db, manager)).unread, 0);
  assert.equal((await inboxFor(db, other)).unread, 1);
});

test('switching in-app notifications off stops them being recorded at all', async () => {
  const db = fakeDb();
  db.settings.notify_in_app = '0';
  assert.equal(await notify(db, { kind: 'day_submitted', audience: 'reports', title: 'x' }), null);
  assert.equal((await inboxFor(db, manager)).notifications.length, 0);
});

test('marking read twice is not an error, and marks nothing the second time', async () => {
  const db = fakeDb();
  await notify(db, { kind: 'day_submitted', audience: 'reports', title: 'New breakfast report' });
  assert.equal(await markRead(db, manager), 1);
  assert.equal(await markRead(db, manager), 0);
});
