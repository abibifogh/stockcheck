import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLOTS, defaultSlotFor, slotAllowsRole, slotClosedReason, slotForTime, slotsForRole,
  visibleSlots, withinWindow,
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

test('the hours follow the shift, not the day being recorded', () => {
  // The afternoon desk cannot fill in yesterday's morning check either.
  // Catching up on another shift's round is how one person's guess becomes
  // another person's record — and the manager is the way it gets put right.
  const late = { hour: 22, role: 'receptionist', canManage: false };
  assert.match(slotClosedReason('morning', late), /between 06:00 and 14:00/);
  assert.match(slotClosedReason('morning', late), /housekeeping manager/);
  assert.equal(slotClosedReason('evening', late), null, 'their own round, any day');
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

// ------------------------------------------------------------ what is shown --

test('a receptionist is not shown the housekeeping round at all', () => {
  const keys = slotsForRole('receptionist').map((s) => s.key);
  assert.deepEqual(keys, ['morning', 'evening']);
});

test('a housekeeper still sees reception’s rounds', () => {
  // They cannot be stopped from reading what the other shift found, and on a
  // small property they may well be the one covering it.
  assert.deepEqual(slotsForRole('housekeeper').map((s) => s.key),
    ['morning', 'housekeeping', 'evening']);
});

test('a manager sees all three whatever their role', () => {
  assert.equal(slotsForRole('receptionist', { canManage: true }).length, 3);
  assert.equal(slotsForRole('housekeeping_manager').length, 3);
  assert.equal(slotsForRole('admin').length, 3);
});

test('what a role may ever record is wider than what it is shown', () => {
  // Reception's two rounds name nobody, so either receptionist may record
  // either one in principle. The clock is what narrows it to the one in hand.
  assert.deepEqual(slotsForRole('receptionist').map((s) => s.key), ['morning', 'evening']);
  assert.deepEqual(visibleSlots('receptionist', { hour: 20 }).map((s) => s.key), ['evening']);
});

// ------------------------------------------------- one tab, the one in hand --

test('a receptionist sees only the round the clock is in', () => {
  // The one who comes in at three has no use for the morning check: another
  // shift walked it, it is very likely already submitted, and a tab holding
  // somebody else's finished round invites "corrections" to work they did not do.
  assert.deepEqual(visibleSlots('receptionist', { hour: 9 }).map((s) => s.key), ['morning']);
  assert.deepEqual(visibleSlots('receptionist', { hour: 15 }).map((s) => s.key), ['evening']);
  assert.deepEqual(visibleSlots('receptionist', { hour: 23 }).map((s) => s.key), ['evening']);
});

test('a housekeeper sees theirs, whatever the hour', () => {
  for (const hour of [7, 13, 19]) {
    assert.deepEqual(visibleSlots('housekeeper', { hour }).map((s) => s.key),
      ['housekeeping'], `at ${hour}`);
  }
});

test('a past day is bounded the same way as today', () => {
  // Yesterday's morning check belongs to the morning shift, whichever day it
  // is being looked at. The afternoon desk never sees it — which is the point:
  // a finished round with somebody else's name on it is not theirs to tidy.
  assert.deepEqual(visibleSlots('receptionist', { hour: 15 }).map((s) => s.key), ['evening']);
  assert.deepEqual(visibleSlots('receptionist', { hour: 9 }).map((s) => s.key), ['morning']);
});

test('a manager sees all three, at any hour and on any day', () => {
  assert.equal(visibleSlots('receptionist', { hour: 9, canManage: true }).length, 3);
  assert.equal(visibleSlots('housekeeping_manager', { hour: 9, canManage: true }).length, 3);
  // And is refused nothing, which is how another shift's round gets corrected.
  for (const slot of ['morning', 'housekeeping', 'evening']) {
    assert.equal(slotClosedReason(slot, { hour: 3, role: 'receptionist', canManage: true }), null);
  }
});
