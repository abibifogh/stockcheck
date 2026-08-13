import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLOTS, defaultSlotFor, slotAllowsRole, slotClosedReason, slotForTime, withinWindow,
} from '../src/lib/housekeeping.js';

/**
 * Whose round it is, and when.
 *
 * Two rules that answer two different worries: a housekeeping round somebody
 * else filled in says nothing about whether the rooms were walked, and a
 * morning check recorded at five in the morning is not a morning check.
 */

// ------------------------------------------------------------- whose round --

test('the housekeeping round belongs to housekeeping', () => {
  assert.equal(slotAllowsRole('housekeeping', 'housekeeper'), true);
  assert.equal(slotAllowsRole('housekeeping', 'receptionist'), false);
  // Somebody has to be able to cover, and to correct what was recorded.
  assert.equal(slotAllowsRole('housekeeping', 'housekeeping_manager'), true);
  assert.equal(slotAllowsRole('housekeeping', 'admin'), true);
  // And nobody from another part of the system, whatever they hold.
  assert.equal(slotAllowsRole('housekeeping', 'cook'), false);
});

test('reception’s two rounds name nobody', () => {
  // Deliberately open: a check nobody was allowed to record is worse than one
  // recorded by the wrong shift, and a sick receptionist has to be coverable.
  for (const slot of ['morning', 'evening']) {
    for (const role of ['receptionist', 'housekeeper', 'admin']) {
      assert.equal(slotAllowsRole(slot, role), true, `${role} on ${slot}`);
    }
  }
});

// -------------------------------------------------------------- the hours --

test('the morning check runs from six until two', () => {
  assert.equal(withinWindow('morning', 5), false, 'before it opens');
  assert.equal(withinWindow('morning', 6), true);
  assert.equal(withinWindow('morning', 13), true);
  assert.equal(withinWindow('morning', 14), true, 'the two o’clock hour is still the morning round');
  assert.equal(withinWindow('morning', 15), false);
});

test('the afternoon check runs from two until midnight', () => {
  assert.equal(withinWindow('evening', 13), false);
  assert.equal(withinWindow('evening', 14), true);
  assert.equal(withinWindow('evening', 23), true, 'right up to 23:59');
});

test('the housekeeping round has no hours at all', () => {
  // It is the housekeepers' own and nobody else can record it, so there is
  // nobody to keep out — and finishing the rooms late should never mean not
  // recording them.
  for (let hour = 0; hour < 24; hour += 1) {
    assert.equal(withinWindow('housekeeping', hour), true, `at ${hour}`);
  }
});

// ------------------------------------------------------- what opens by now --

test('the clock picks between reception’s two rounds, and never theirs', () => {
  assert.equal(slotForTime(6), 'morning');
  assert.equal(slotForTime(13), 'morning');
  assert.equal(slotForTime(14), 'evening');
  assert.equal(slotForTime(23), 'evening');
  // The housekeeping round is chosen by who is asking, not by when.
  assert.ok(!['housekeeping'].includes(slotForTime(11)));
});

test('a housekeeper opens on their own round whatever the hour', () => {
  for (const hour of [7, 11, 15, 22]) {
    assert.equal(defaultSlotFor(hour, 'housekeeper'), 'housekeeping', `at ${hour}`);
  }
  assert.equal(defaultSlotFor(9, 'receptionist'), 'morning');
  assert.equal(defaultSlotFor(16, 'receptionist'), 'evening');
  // A manager is not walking a round, so they get the one the property is in.
  assert.equal(defaultSlotFor(9, 'housekeeping_manager'), 'morning');
});

// ------------------------------------------------------------ the refusal --

test('the refusal says which rule it is, in words somebody can act on', () => {
  const desk = { hour: 11, role: 'receptionist', canManage: false, today: true };

  assert.match(slotClosedReason('housekeeping', desk), /recorded by housekeeping/);
  assert.equal(slotClosedReason('morning', desk), null, 'eleven is inside the morning window');
  assert.match(slotClosedReason('evening', desk), /between 14:00 and 23:59/);
  assert.match(slotClosedReason('morning', { ...desk, hour: 16 }), /between 06:00 and 14:00/);
});

test('a manager is never locked out of the record', () => {
  const boss = { hour: 3, role: 'housekeeping_manager', canManage: true, today: true };
  for (const slot of ['morning', 'housekeeping', 'evening']) {
    assert.equal(slotClosedReason(slot, boss), null, slot);
  }
});

test('the hours do not apply to catching up on yesterday', () => {
  // A round recorded late is worth far more than one never recorded at all, and
  // yesterday's morning check cannot be done between six and two today.
  const late = { hour: 22, role: 'receptionist', canManage: false, today: false };
  assert.equal(slotClosedReason('morning', late), null);
  // Whose round it is does not expire, though.
  assert.match(slotClosedReason('housekeeping', late), /recorded by housekeeping/);
});

test('every round says its own hours, and only the middle one names a shift', () => {
  const byKey = Object.fromEntries(SLOTS.map((s) => [s.key, s]));
  assert.equal(byKey.morning.from, '06:00');
  assert.equal(byKey.morning.to, '14:00');
  assert.equal(byKey.evening.from, '14:00');
  assert.equal(byKey.evening.to, '23:59');
  assert.equal(byKey.housekeeping.from, undefined);
  assert.deepEqual(byKey.housekeeping.roles, ['housekeeper', 'housekeeping_manager', 'admin']);
  assert.equal(byKey.morning.roles, undefined);
  assert.equal(byKey.evening.roles, undefined);
  // The stored key stays `evening` however it is labelled: it is written on
  // every check ever recorded, and renaming it would be renaming the past.
  assert.equal(byKey.evening.label, 'Afternoon check');
});
