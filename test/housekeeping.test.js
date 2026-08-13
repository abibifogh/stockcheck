import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLOTS, dayOverview, dayReport, exportRows, findingsFor, makeDataset, overview,
  periodReport, resolutionOver, roomDetail, severityOf, slotForTime, tally, worstOf,
} from '../src/lib/housekeeping.js';

const ROOMS = [
  { id: 1, name: 'Dorm A', block: 'Ground floor', sort_order: 10, note: null, active: 1 },
  { id: 2, name: 'Dorm B', block: 'Ground floor', sort_order: 20, note: null, active: 1 },
  { id: 3, name: 'Dorm C', block: 'First floor', sort_order: 30, note: null, active: 1 },
];

const BEDS = [
  { id: 1, room_id: 1, label: 'Bed 1', sort_order: 10, expected_state: 'occupied', expected_note: 'Ama', active: 1 },
  { id: 2, room_id: 1, label: 'Bed 2', sort_order: 20, expected_state: 'free', expected_note: null, active: 1 },
  { id: 3, room_id: 1, label: 'Bed 3', sort_order: 30, expected_state: null, expected_note: null, active: 1 },
  { id: 4, room_id: 2, label: 'Bed 1', sort_order: 10, expected_state: null, expected_note: null, active: 1 },
  { id: 5, room_id: 2, label: 'Bed 2', sort_order: 20, expected_state: null, expected_note: null, active: 1 },
  { id: 6, room_id: 3, label: 'Bed 1', sort_order: 10, expected_state: null, expected_note: null, active: 1 },
];

let nextId = 1;

/**
 * One recorded bed. `expected` is the snapshot the round took, which is
 * deliberately independent of what the bed says today.
 */
const check = (day, bedId, state, nameTag, extra = {}) => ({
  id: nextId++,
  round_id: Number(day.replace(/-/g, '').slice(-4)),
  day,
  slot: 'morning',
  bed_id: bedId,
  state,
  name_tag: state === 'occupied' ? (nameTag ? 1 : 0) : null,
  expected_state: null,
  note: null,
  checked_by: 'Akosua',
  at: `${day} 09:00:00`,
  ...extra,
});

function build(overrides = {}) {
  return makeDataset({
    rooms: ROOMS,
    beds: BEDS,
    rounds: [],
    checks: [],
    settings: [{ key: 'timezone', value: 'Africa/Accra' }, { key: 'property_name', value: 'The Hostel' }],
    ...overrides,
  });
}

// ------------------------------------------------------------- the findings --

test('an occupied bed with no name tag is the finding; a free bed never is', () => {
  assert.deepEqual(
    findingsFor(check('2026-08-10', 1, 'occupied', false)),
    { untagged: true, unexpected: false, emptyBooked: false },
  );

  // The follow-up question is never asked of an empty bed, and its silence
  // must not be read as "no tag" — that would put every empty bed in the
  // property on the list of things to go and fix.
  const free = check('2026-08-10', 1, 'free');
  assert.equal(free.name_tag, null);
  assert.equal(findingsFor(free).untagged, false);
});

test('a bed rostered free but found occupied is flagged, tag or no tag', () => {
  const tagged = check('2026-08-10', 2, 'occupied', true, { expected_state: 'free' });
  assert.deepEqual(findingsFor(tagged), { untagged: false, unexpected: true, emptyBooked: false });
  assert.equal(severityOf(tagged), 'unexpected');

  const untagged = check('2026-08-10', 2, 'occupied', false, { expected_state: 'free' });
  // Both are true, and the worse of the two is what the bed is shown as.
  assert.deepEqual(findingsFor(untagged), { untagged: true, unexpected: true, emptyBooked: false });
  assert.equal(severityOf(untagged), 'untagged');
});

test('a bed rostered occupied but found empty is reported, more gently', () => {
  const empty = check('2026-08-10', 1, 'free', null, { expected_state: 'occupied' });
  assert.equal(findingsFor(empty).emptyBooked, true);
  assert.equal(severityOf(empty), 'empty_booked');
});

test('a bed nobody answered for outranks a clean one', () => {
  assert.equal(severityOf(null), 'unchecked');
  assert.equal(worstOf(['clear', 'unchecked']), 'unchecked');
  assert.equal(worstOf(['unchecked', 'unexpected']), 'unexpected');
  assert.equal(worstOf(['unexpected', 'untagged', 'clear']), 'untagged');
  assert.equal(worstOf(['clear', 'clear']), 'clear');
});

test('the findings come from what the round recorded, not from the roster today', () => {
  // Bed 2 says "should be free" now. The check taken last week recorded that
  // it was expected occupied, and that is what last week found.
  const ds = build({
    checks: [check('2026-08-10', 2, 'occupied', true, { expected_state: 'occupied' })],
  });

  const report = dayReport(ds, '2026-08-10');
  assert.equal(report.totals.unexpected, 0);
  assert.equal(report.findings.length, 0);
});

// -------------------------------------------------------------- the counting --

test('tag compliance is measured against occupied beds, not against every bed', () => {
  const t = tally([
    check('2026-08-10', 1, 'occupied', true),
    check('2026-08-10', 2, 'occupied', false),
    check('2026-08-10', 3, 'free'),
    check('2026-08-10', 4, 'free'),
  ], 6);

  assert.equal(t.checked, 4);
  assert.equal(t.occupied, 2);
  assert.equal(t.untagged, 1);
  // One of the two occupied beds carried a tag — not one of the four checked.
  assert.equal(t.tagRate, 50);
  assert.equal(t.occupancy, 50);
});

test('beds nobody answered for are counted, not quietly dropped', () => {
  const t = tally([check('2026-08-10', 1, 'free')], 6);
  assert.equal(t.unchecked, 5);
  assert.equal(t.coverage, 16.7);
});

test('with nothing expected, coverage has nothing to be a fraction of', () => {
  const t = tally([check('2026-08-10', 1, 'free')]);
  assert.equal(t.coverage, null);
  assert.equal(t.unchecked, null);
});

// ------------------------------------------------------------------ one day --

test('a day lists every bed, including the ones still unanswered', () => {
  const ds = build({
    rounds: [{ id: 1, day: '2026-08-10', submitted_at: null, submitted_by: null, note: null }],
    checks: [
      check('2026-08-10', 1, 'occupied', false, { expected_state: 'occupied', note: 'bag on the bed' }),
      check('2026-08-10', 2, 'occupied', true, { expected_state: 'free' }),
      check('2026-08-10', 3, 'free', null, { expected_state: null }),
    ],
  });

  const report = dayReport(ds, '2026-08-10');

  assert.equal(report.submitted, false);
  assert.equal(report.totals.checked, 3);
  assert.equal(report.totals.unchecked, 3); // Dorm B and Dorm C untouched
  assert.equal(report.rooms.length, 3);

  const dormA = report.rooms.find((r) => r.name === 'Dorm A');
  assert.equal(dormA.beds.length, 3);
  assert.equal(dormA.severity, 'untagged');

  const dormC = report.rooms.find((r) => r.name === 'Dorm C');
  assert.equal(dormC.severity, 'unchecked');
  assert.equal(dormC.beds[0].state, null);

  // Worst first, so the list is walked in the order somebody should act on it.
  assert.deepEqual(report.findings.map((f) => f.severity), ['untagged', 'unexpected']);
  assert.equal(report.findings[0].bed, 'Bed 1');
  assert.equal(report.notes.length, 1);
  assert.equal(report.notes[0].note, 'bag on the bed');
  assert.equal(report.people[0].name, 'Akosua');
  assert.equal(report.people[0].untaggedFound, 1);
});

test('a submitted round says who submitted it', () => {
  const ds = build({
    rounds: [{
      id: 1, day: '2026-08-10', submitted_at: '2026-08-10 10:15:00',
      submitted_by: 'Akosua', note: 'second floor closed for painting',
    }],
    checks: [check('2026-08-10', 1, 'free')],
  });

  const report = dayReport(ds, '2026-08-10');
  assert.equal(report.submitted, true);
  assert.equal(report.round.submittedBy, 'Akosua');
  assert.equal(report.round.note, 'second floor closed for painting');
});

// ------------------------------------------------------------------ a period --

test('a period counts findings, compares against the period before, and finds repeats', () => {
  const ds = build({
    checks: [
      // The week before: one untagged bed.
      check('2026-08-01', 1, 'occupied', false),
      check('2026-08-01', 2, 'occupied', true),
      // This week: bed 1 untagged three times, which makes it a pattern.
      check('2026-08-08', 1, 'occupied', false),
      check('2026-08-09', 1, 'occupied', false),
      check('2026-08-10', 1, 'occupied', false),
      check('2026-08-10', 2, 'occupied', true),
      check('2026-08-10', 4, 'occupied', true, { expected_state: 'free' }),
    ],
  });

  const report = periodReport(ds, '2026-08-08', '2026-08-14');

  assert.equal(report.days, 7);
  assert.equal(report.current.untagged, 3);
  assert.equal(report.current.unexpected, 1);
  assert.equal(report.previous.from, '2026-08-01');
  assert.equal(report.previous.to, '2026-08-07');
  assert.equal(report.previous.untagged, 1);
  assert.equal(report.deltas.untagged, 200); // one to three

  assert.equal(report.repeats.length, 1);
  assert.equal(report.repeats[0].label, 'Bed 1');
  assert.equal(report.repeats[0].untagged, 3);
  assert.equal(report.repeats[0].lastUntagged, '2026-08-10');

  // Dorm C was never walked in this period, and says so rather than showing
  // as a room with nothing wrong.
  const dormC = report.rooms.find((r) => r.name === 'Dorm C');
  assert.equal(dormC.neverChecked, true);
  assert.equal(dormC.untagged, 0);
  assert.ok(report.alerts.some((a) => a.kind === 'never_checked'));
  assert.ok(report.alerts.some((a) => a.kind === 'untagged'));
  assert.ok(report.alerts.some((a) => a.kind === 'repeat_bed'));
});

test('tag compliance moves in points, not in percent of a percent', () => {
  const ds = build({
    checks: [
      // Before: one of two occupied beds tagged — 50%.
      check('2026-08-01', 1, 'occupied', true),
      check('2026-08-01', 2, 'occupied', false),
      // After: two of two — 100%, which is 50 points better.
      check('2026-08-08', 1, 'occupied', true),
      check('2026-08-08', 2, 'occupied', true),
    ],
  });

  const report = periodReport(ds, '2026-08-08', '2026-08-14');
  assert.equal(report.previous.tagRate, 50);
  assert.equal(report.current.tagRate, 100);
  assert.equal(report.deltas.tagRate, 50);
});

test('the heatmap gives every room a cell for every day', () => {
  const ds = build({
    checks: [
      check('2026-08-08', 1, 'occupied', false),
      check('2026-08-08', 2, 'free'),
      check('2026-08-08', 3, 'free'),
      check('2026-08-09', 4, 'free'),
      check('2026-08-09', 5, 'free'),
    ],
  });

  const report = periodReport(ds, '2026-08-08', '2026-08-10');
  assert.equal(report.heatmap.days.length, 3);
  assert.equal(report.heatmap.rows.length, 3);

  const dormA = report.heatmap.rows.find((r) => r.name === 'Dorm A');
  assert.equal(dormA.cells[0].severity, 'untagged');
  assert.equal(dormA.cells[0].untagged, 1);
  assert.equal(dormA.cells[1].severity, 'unchecked');

  // Dorm B was fully walked on the second day and nothing was found.
  const dormB = report.heatmap.rows.find((r) => r.name === 'Dorm B');
  assert.equal(dormB.cells[1].severity, 'clear');
  assert.equal(dormB.cells[1].checked, 2);
});

test('a part-checked room reads as unchecked rather than clean', () => {
  // Two of Dorm A's three beds answered for, both fine. The room is not clean:
  // somebody still has to open the third bed.
  const ds = build({
    checks: [check('2026-08-08', 1, 'free'), check('2026-08-08', 2, 'free')],
  });

  const report = periodReport(ds, '2026-08-08', '2026-08-08');
  const dormA = report.heatmap.rows.find((r) => r.name === 'Dorm A');
  assert.equal(dormA.cells[0].severity, 'unchecked');
  assert.equal(dormA.cells[0].checked, 2);
  assert.equal(dormA.cells[0].beds, 3);
});

// -------------------------------------------------------------- a room, alone --

test('a room carries its own history, bed by bed', () => {
  const ds = build({
    checks: [
      check('2026-08-08', 1, 'occupied', false),
      check('2026-08-09', 1, 'occupied', true),
      check('2026-08-09', 2, 'free'),
      // Another room's checks must not leak into this one.
      check('2026-08-09', 4, 'occupied', false),
    ],
  });

  const detail = roomDetail(ds, 1, '2026-08-08', '2026-08-10');
  assert.equal(detail.room.name, 'Dorm A');
  assert.equal(detail.bedCount, 3);
  assert.equal(detail.totals.checked, 3);
  assert.equal(detail.totals.untagged, 1);
  assert.equal(detail.lastChecked, '2026-08-09');

  const bed1 = detail.beds.find((b) => b.label === 'Bed 1');
  assert.equal(bed1.checked, 2);
  assert.equal(bed1.untagged, 1);
  assert.equal(bed1.tagRate, 50);
  assert.equal(bed1.lastCheck.day, '2026-08-09');
  assert.equal(bed1.expectedNote, 'Ama');

  // Newest first, and only this room's.
  assert.equal(detail.history.length, 3);
  assert.equal(detail.history[0].day, '2026-08-09');
  assert.equal(roomDetail(ds, 99, '2026-08-08', '2026-08-10'), null);
});

// ------------------------------------------------------------------ overview --

test('the overview knows when the last round actually was', () => {
  const ds = build({
    rounds: [{ id: 1, day: '2026-08-08', submitted_at: '2026-08-08 10:00:00', submitted_by: 'Akosua', note: null }],
    checks: [check('2026-08-08', 1, 'occupied', false)],
  });

  const view = overview(ds, '2026-08-10');
  assert.equal(view.lastCheckedDay, '2026-08-08');
  assert.equal(view.daysSinceCheck, 2);
  assert.equal(view.todayTotals.checked, 0);
  assert.equal(view.todaySubmitted, false);
  assert.equal(view.headline.untagged30, 1);
  assert.equal(view.recentRounds[0].day, '2026-08-08');
  assert.equal(view.recentRounds[0].untagged, 1);
});

// -------------------------------------------------------------------- export --

test('the export writes one line per bed, naming the finding in words', () => {
  const ds = build({
    checks: [
      check('2026-08-08', 1, 'occupied', false, { note: 'nothing on the frame' }),
      check('2026-08-08', 2, 'free'),
    ],
  });

  const rows = exportRows(ds, '2026-08-08', '2026-08-08');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 6), ['Date', 'Room', 'Block', 'Bed', 'State', 'Name tag']);

  const [, first, second] = rows;
  assert.equal(first[1], 'Dorm A');
  assert.equal(first[4], 'occupied');
  assert.equal(first[5], 'no');
  assert.equal(first[7], 'occupied, no name tag');
  assert.equal(first[8], 'nothing on the frame');

  // A free bed leaves the name tag column empty rather than writing "no".
  assert.equal(second[4], 'free');
  assert.equal(second[5], '');
  assert.equal(second[7], '');
});


// ------------------------------------------------------------- three a day --

const at = (slot) => (day, bedId, state, nameTag, extra = {}) =>
  check(day, bedId, state, nameTag, { slot, ...extra });

const morning = at('morning');
const housekeeping = at('housekeeping');
const evening = at('evening');

test('the clock picks the round somebody most likely means', () => {
  assert.equal(slotForTime(8), 'morning');
  assert.equal(slotForTime(9), 'morning');
  assert.equal(slotForTime(11), 'housekeeping');
  assert.equal(slotForTime(15), 'housekeeping');
  assert.equal(slotForTime(20), 'evening');
  assert.equal(slotForTime(23), 'evening');
  assert.deepEqual(SLOTS.map((s) => s.key), ['morning', 'housekeeping', 'evening']);
});

test('the three rounds of a day are separate reports, each with its own answers', () => {
  const ds = build({
    rounds: [
      { id: 1, day: '2026-08-10', slot: 'morning', submitted_at: '2026-08-10 08:30', submitted_by: 'Yaw' },
      { id: 2, day: '2026-08-10', slot: 'housekeeping', submitted_at: null, submitted_by: null },
    ],
    checks: [
      morning('2026-08-10', 1, 'occupied', false),
      housekeeping('2026-08-10', 1, 'occupied', true),
    ],
  });

  const am = dayReport(ds, '2026-08-10', 'morning');
  assert.equal(am.totals.untagged, 1, 'the morning found it');
  assert.equal(am.submitted, true);
  assert.equal(am.round.submittedBy, 'Yaw');

  const hk = dayReport(ds, '2026-08-10', 'housekeeping');
  assert.equal(hk.totals.untagged, 0, 'housekeeping found it fixed');
  assert.equal(hk.submitted, false, 'started but not submitted');

  const pm = dayReport(ds, '2026-08-10', 'evening');
  assert.equal(pm.totals.checked, 0, 'the evening round has not happened');
  assert.equal(pm.round, null);
});

test('a finding put right later in the day counts as fixed, not as a problem', () => {
  const ds = build({
    checks: [
      morning('2026-08-10', 1, 'occupied', false),   // found untagged
      housekeeping('2026-08-10', 1, 'occupied', true), // and tagged by the time housekeeping looked
      evening('2026-08-10', 1, 'occupied', true),
    ],
  });

  const r = resolutionOver(ds, ['2026-08-10']);
  assert.equal(r.found, 1);
  assert.equal(r.fixed, 1);
  assert.equal(r.unresolved, 0);
  assert.equal(r.fixRate, 100);
  assert.equal(r.lingering.length, 0);
});

test('a finding nobody dealt with is what the day is judged on', () => {
  const ds = build({
    checks: [
      morning('2026-08-10', 1, 'occupied', false),
      housekeeping('2026-08-10', 1, 'occupied', false),
      evening('2026-08-10', 1, 'occupied', false),
    ],
  });

  const r = resolutionOver(ds, ['2026-08-10']);
  assert.equal(r.found, 1);
  assert.equal(r.fixed, 0);
  assert.equal(r.unresolved, 1);
  assert.equal(r.neverRechecked, 0, 'two later rounds did look at it');
  assert.equal(r.lingering[0].bed, 'Bed 1');
  assert.equal(r.lingering[0].firstSeen, 'morning');
  assert.equal(r.lingering[0].lastSeen, 'evening');
});

test('a finding by the last round of the day is not counted as anybody ignoring it', () => {
  // Found by the evening check, so there was no later round to fix it in.
  const ds = build({
    checks: [
      morning('2026-08-10', 1, 'free'),
      evening('2026-08-10', 1, 'occupied', false),
    ],
  });

  const r = resolutionOver(ds, ['2026-08-10']);
  assert.equal(r.found, 1);
  assert.equal(r.unresolved, 1);
  assert.equal(r.neverRechecked, 1, 'nobody had the chance');
  assert.equal(r.lingering[0].rechecked, false);
});

test('silence is not a fix — a bed nobody looked at again stays unresolved', () => {
  const ds = build({
    checks: [
      morning('2026-08-10', 1, 'occupied', false),
      // The other rounds happened, but never answered for bed 1.
      housekeeping('2026-08-10', 2, 'free'),
      evening('2026-08-10', 2, 'free'),
    ],
  });

  const r = resolutionOver(ds, ['2026-08-10']);
  assert.equal(r.unresolved, 1);
  assert.equal(r.neverRechecked, 1);
});

test('a whole day reads as three rounds and one outstanding list', () => {
  const ds = build({
    rounds: [
      { id: 1, day: '2026-08-10', slot: 'morning', submitted_at: '2026-08-10 08:30', submitted_by: 'Yaw' },
      { id: 2, day: '2026-08-10', slot: 'housekeeping', submitted_at: '2026-08-10 11:00', submitted_by: 'Akosua' },
      { id: 3, day: '2026-08-10', slot: 'evening', submitted_at: '2026-08-10 21:00', submitted_by: 'Kofi' },
    ],
    checks: [
      morning('2026-08-10', 1, 'occupied', false),
      housekeeping('2026-08-10', 1, 'occupied', true),
      evening('2026-08-10', 1, 'occupied', true),
      morning('2026-08-10', 2, 'occupied', false),
      evening('2026-08-10', 2, 'occupied', false),
    ],
  });

  const view = dayOverview(ds, '2026-08-10');
  assert.equal(view.rounds.length, 3);
  assert.deepEqual(view.rounds.map((r) => r.submittedBy), ['Yaw', 'Akosua', 'Kofi']);
  assert.equal(view.roundsSubmitted, 3);

  // Bed 1 was fixed; bed 2 never was. Only bed 2 is outstanding.
  assert.equal(view.outstanding.length, 1);
  assert.equal(view.outstanding[0].bed, 'Bed 2');
  assert.equal(view.outstanding[0].slot, 'evening', 'judged on the last look it got');
  assert.equal(view.closing.untagged, 1, 'one bed untagged at close, not two');
  assert.equal(view.resolution.fixed, 1);
  assert.equal(view.resolution.unresolved, 1);
});

test('a period reports each round separately, and who does it', () => {
  const ds = build({
    rounds: [
      { id: 1, day: '2026-08-10', slot: 'morning', submitted_at: '2026-08-10 08:30', submitted_by: 'Yaw' },
      { id: 2, day: '2026-08-10', slot: 'evening', submitted_at: '2026-08-10 21:00', submitted_by: 'Kofi' },
    ],
    checks: [
      morning('2026-08-10', 1, 'occupied', false, { checked_by: 'Yaw' }),
      evening('2026-08-10', 1, 'occupied', false, { checked_by: 'Kofi' }),
    ],
  });

  const report = periodReport(ds, '2026-08-10', '2026-08-10');
  const bySlot = Object.fromEntries(report.bySlot.map((s) => [s.slot, s]));

  assert.equal(bySlot.morning.untagged, 1);
  assert.equal(bySlot.morning.submitted, 1);
  assert.equal(bySlot.morning.people[0].name, 'Yaw');
  assert.equal(bySlot.evening.people[0].name, 'Kofi');
  assert.equal(bySlot.housekeeping.rounds, 0, 'housekeeping did not walk that day');
  assert.equal(bySlot.housekeeping.checked, 0);

  assert.equal(report.roundsSubmitted, 2);
  assert.equal(report.roundsExpected, 3);
  assert.equal(report.resolution.unresolved, 1);
});

test('a bed checked three times is still one bed on the heatmap', () => {
  const ds = build({
    checks: [
      morning('2026-08-10', 1, 'free'),
      housekeeping('2026-08-10', 1, 'free'),
      evening('2026-08-10', 1, 'free'),
    ],
  });

  const report = periodReport(ds, '2026-08-10', '2026-08-10');
  const dormA = report.heatmap.rows.find((r) => r.name === 'Dorm A');
  assert.equal(dormA.cells[0].checked, 1, 'one bed answered for, not three');
  assert.equal(dormA.cells[0].beds, 3);
  assert.equal(dormA.cells[0].rounds, 3);
  assert.equal(dormA.cells[0].severity, 'unchecked', 'two of its beds were never looked at');
});
