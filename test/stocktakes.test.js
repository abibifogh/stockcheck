import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dueSchedules, nextDue } from '../src/lib/stocktakes.js';

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
