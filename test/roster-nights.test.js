import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dayReport, expectationFor, expectedFor, makeDataset, rosterNightsFor, rosterOn,
} from '../src/lib/housekeeping.js';

/**
 * A roster day is a night.
 *
 * The roster for day D says who should be in each bed on the night of D. The
 * evening check of D is the plan for that night; the morning check of D+1 is
 * what became of it. Both are judged against the same roster, which is the
 * whole point: bookings move all day, and the eight o'clock check must not be
 * measured against a roster written at noon.
 */

const ROOMS = [{ id: 1, name: 'Dorm A', block: null, sort_order: 10, note: null, active: 1 }];
const BEDS = [
  { id: 1, room_id: 1, label: 'Bed 1', sort_order: 10, active: 1 },
  { id: 2, room_id: 1, label: 'Bed 2', sort_order: 20, active: 1 },
  { id: 3, room_id: 1, label: 'Bed 3', sort_order: 30, active: 1 },
];

const roster = (day, bedId, state, extra = {}) => ({
  day, bed_id: bedId, expected_state: state, expected_note: null,
  set_by: 'Ama', updated_at: `${day} 08:00:00`, confirmed_at: null, confirmed_by: null,
  ...extra,
});

const build = (rows, checks = []) => makeDataset({
  rooms: ROOMS, beds: BEDS, rounds: [], checks, roster: rows,
  settings: [{ key: 'timezone', value: 'Africa/Accra' }],
});

// --------------------------------------------------------------- the rule --

test('the morning looks back a night and the evening looks at tonight', () => {
  assert.deepEqual(rosterNightsFor('2026-08-12', 'morning'), {
    nights: ['2026-08-11'], governing: '2026-08-11',
  });
  assert.deepEqual(rosterNightsFor('2026-08-12', 'evening'), {
    nights: ['2026-08-12'], governing: '2026-08-12',
  });
  // The round in the middle straddles the two.
  assert.deepEqual(rosterNightsFor('2026-08-12', 'housekeeping'), {
    nights: ['2026-08-11', '2026-08-12'], governing: '2026-08-11',
  });
});

test('a bed cancelled today was still somebody’s bed last night', () => {
  // This is the case that started all of it. Last night the bed was sold; this
  // morning the guest is still in it; by the time the roster is written the
  // booking has been cancelled for tonight.
  assert.equal(expectedFor('morning', 'occupied', 'free'), 'occupied',
    'the morning check is judged against last night');
  assert.equal(expectedFor('evening', 'occupied', 'free'), 'free',
    'the evening check is judged against tonight');
});

test('a walk-in booked this afternoon is not a surprise tonight', () => {
  assert.equal(expectedFor('evening', 'free', 'occupied'), 'occupied');
  // ...but that same bed, found occupied this morning before the booking
  // existed, still is one.
  assert.equal(expectedFor('morning', 'free', 'occupied'), 'free');
});

test('the changeover round only judges a bed where both nights agree', () => {
  // Eleven in the morning: last night's guest may have gone, tonight's has not
  // arrived. A bed changing hands can honestly be found either way.
  assert.equal(expectedFor('housekeeping', 'occupied', 'free'), null, 'checking out');
  assert.equal(expectedFor('housekeeping', 'free', 'occupied'), null, 'checking in');
  // Where the two nights agree there is still something to be surprised by.
  assert.equal(expectedFor('housekeeping', 'free', 'free'), 'free');
  assert.equal(expectedFor('housekeeping', 'occupied', 'occupied'), 'occupied');
  assert.equal(expectedFor('housekeeping', null, null), null);
});

test('an untracked bed stays untracked whichever way it is read', () => {
  for (const slot of ['morning', 'housekeeping', 'evening']) {
    assert.equal(expectedFor(slot, null, null), null, slot);
  }
  assert.equal(expectedFor('morning', null, 'occupied'), null);
  assert.equal(expectedFor('evening', 'occupied', null), null);
});

// ------------------------------------------------------------ the lookup --

test('a night nobody wrote a roster for is governed by the last one that was', () => {
  const ds = build([roster('2026-08-10', 1, 'occupied')]);

  const carried = rosterOn(ds, '2026-08-13');
  assert.equal(carried.day, '2026-08-10');
  assert.equal(carried.carried, true, 'and it says so, rather than pretending');
  assert.equal(carried.rows.get(1).expected_state, 'occupied');

  const exact = rosterOn(ds, '2026-08-10');
  assert.equal(exact.carried, false);
});

test('a roster written after a night does not reach back to it', () => {
  const ds = build([roster('2026-08-12', 1, 'occupied')]);
  const before = rosterOn(ds, '2026-08-11');
  assert.equal(before.day, null);
  assert.equal(before.rows.size, 0);
});

test('the expectation says which night it came from', () => {
  const ds = build([
    roster('2026-08-11', 1, 'occupied', { confirmed_at: '2026-08-12 08:30:00', confirmed_by: 'Ama' }),
    roster('2026-08-12', 1, 'free'),
  ]);

  const morning = expectationFor(ds, '2026-08-12', 'morning', 1);
  assert.equal(morning.state, 'occupied');
  assert.equal(morning.night, '2026-08-11');
  assert.equal(morning.confirmed, true, 'that night has been closed off');

  const evening = expectationFor(ds, '2026-08-12', 'evening', 1);
  assert.equal(evening.state, 'free');
  assert.equal(evening.night, '2026-08-12');
  assert.equal(evening.confirmed, false, 'tonight is still open — bookings can still move');
});

// ------------------------------------------------------------ the report --

test('one day, two rounds, two different expectations of the same bed', () => {
  const ds = build([
    roster('2026-08-11', 1, 'occupied'),
    roster('2026-08-12', 1, 'free'),
  ]);

  assert.equal(dayReport(ds, '2026-08-12', 'morning').rooms[0].beds[0].expectedState, 'occupied');
  assert.equal(dayReport(ds, '2026-08-12', 'evening').rooms[0].beds[0].expectedState, 'free');
  assert.equal(dayReport(ds, '2026-08-12', 'housekeeping').rooms[0].beds[0].expectedState, null);
});

test('a report names the night it is reporting on', () => {
  const ds = build([roster('2026-08-11', 1, 'occupied')]);
  assert.equal(dayReport(ds, '2026-08-12', 'morning').night, '2026-08-11');
  assert.equal(dayReport(ds, '2026-08-12', 'evening').night, '2026-08-12');
  assert.deepEqual(dayReport(ds, '2026-08-12', 'housekeeping').nights,
    ['2026-08-11', '2026-08-12']);
});

test('the finding still comes from the check, not from the roster as it is now', () => {
  // The snapshot on the check is what a finding is made of. Changing the roster
  // for a night that has been confirmed cannot reach back through it.
  const ds = build(
    [roster('2026-08-11', 1, 'free')],
    [{
      id: 1, round_id: 1, day: '2026-08-12', slot: 'morning', bed_id: 1,
      state: 'occupied', name_tag: 1, expected_state: 'occupied',
      note: null, checked_by: 'Ama', at: '2026-08-12 08:10:00',
    }],
  );

  const bed = dayReport(ds, '2026-08-12', 'morning').rooms[0].beds[0];
  assert.equal(bed.findings.unexpected, false,
    'the check recorded that somebody was expected, and that is what it is judged on');
  assert.equal(bed.expectedState, 'free', 'even though the roster now reads otherwise');
});
