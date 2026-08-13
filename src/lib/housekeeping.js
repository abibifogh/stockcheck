import { round, sum } from '../util/stats.js';
import { addDays, diffDays, rangeDays } from '../util/dates.js';

/**
 * The dorm bed check: what was found, where, and what it means.
 *
 * The other two stores in this system count things that cost money. This one
 * counts findings, and there are only ever four of them:
 *
 *   untagged     — a bed is occupied and carries no name tag. Somebody is
 *                  sleeping in it and nothing says who. This is the finding the
 *                  whole system was built for, so everything is ranked by it.
 *   unexpected   — a bed the roster called free was found occupied. Either the
 *                  front desk did not record a booking, or nobody sold that bed
 *                  at all.
 *   emptyBooked  — a bed the roster called occupied was found empty. Usually a
 *                  guest who left early; occasionally a bed sold twice.
 *   unchecked    — nobody answered for the bed. Reported as loudly as the rest,
 *                  because a room quietly skipped every Tuesday looks exactly
 *                  like a room with no problems.
 *
 * A finding is only ever derived from what was recorded on the day: a check
 * carries its own snapshot of what was expected of that bed, so editing the
 * roster today cannot rewrite what last week's round found.
 *
 * ---------------------------------------------------------------------------
 * A roster day is a night.
 *
 * The roster for day D says who should be in each bed on the night of D. Two
 * checks look at that night, and they are on either side of it:
 *
 *   the evening check of D      — the plan, before anybody sleeps in it
 *   the morning check of D + 1  — what actually happened to it
 *
 * So the morning check is judged against yesterday's roster, not today's. This
 * matters because bookings move all day: a bed cancelled at noon is free
 * tonight but somebody was in it last night, and judging this morning's check
 * against tonight's roster would report a guest who paid as a stranger.
 *
 * The housekeeping round sits in the gap — last night's guests are leaving,
 * tonight's have not arrived — so it is judged only where the two nights agree.
 * A bed both nights call free, found occupied, is still worth knowing about;
 * everything else at that hour is just the changeover.
 */

// A bed that keeps turning up untagged is a different problem from a bed that
// did it once, so the report needs a floor before it calls something a pattern.
const REPEAT_THRESHOLD = 2;

/**
 * The three checks in a day, in the order they happen.
 *
 * Reception opens up and walks the dorms; housekeeping walks them again on the
 * room round; reception walks them once more before closing. Three different
 * people, three different reasons for looking, and — the point of it — three
 * chances for a bed found wrong in the morning to be put right before the day
 * ends.
 *
 * `from` and `to` are what the shift is expected to happen between. Nothing is
 * enforced by them: a check recorded late is worth far more than one not
 * recorded at all. They decide which round the screen opens on, and they let a
 * report say a round was missed.
 */
export const SLOTS = [
  {
    key: 'morning',
    label: 'Morning check',
    short: 'Morning',
    by: 'Reception',
    from: '08:00',
    detail: 'First thing, as reception opens up',
  },
  {
    key: 'housekeeping',
    label: 'Housekeeping round',
    short: 'Housekeeping',
    by: 'Housekeeping',
    from: '10:00',
    detail: 'While the rooms are being done',
  },
  {
    key: 'evening',
    label: 'Evening check',
    short: 'Evening',
    by: 'Reception',
    from: '20:00',
    to: '22:00',
    detail: 'Last thing, before reception closes',
  },
];

export const SLOT_KEYS = SLOTS.map((s) => s.key);

export function isSlot(value) {
  return SLOT_KEYS.includes(value);
}

export function slotOf(key) {
  return SLOTS.find((s) => s.key === key) ?? SLOTS[0];
}

/**
 * Which check somebody opening the screen right now most likely means.
 *
 * Rounded generously in both directions: a morning check started at half past
 * seven is still the morning check, and one finished at midday still is too. The
 * housekeeper can always tap another round; this only decides which one they
 * find already open.
 */
export function slotForTime(hour) {
  if (hour < 10) return 'morning';
  if (hour < 18) return 'housekeeping';
  return 'evening';
}

export async function loadDataset(db) {
  const [rooms, beds, rounds, checks, roster, settings] = await Promise.all([
    db.prepare('SELECT * FROM hk_rooms ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM hk_beds ORDER BY room_id, sort_order, label').all(),
    db.prepare('SELECT * FROM hk_rounds ORDER BY day').all(),
    db.prepare('SELECT * FROM hk_checks ORDER BY day, id').all(),
    db.prepare('SELECT * FROM hk_roster ORDER BY day').all(),
    db.prepare('SELECT key, value FROM settings').all(),
  ]);

  return makeDataset({
    rooms: rooms.results ?? [],
    beds: beds.results ?? [],
    rounds: rounds.results ?? [],
    checks: checks.results ?? [],
    roster: roster.results ?? [],
    settings: settings.results ?? [],
  });
}

export function makeDataset(raw) {
  const settings = Object.fromEntries((raw.settings ?? []).map((r) => [r.key, r.value]));
  const rooms = raw.rooms ?? [];
  const beds = raw.beds ?? [];
  const checks = raw.checks ?? [];

  const bedById = new Map(beds.map((b) => [b.id, b]));
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const bedsByRoom = new Map();
  for (const bed of beds) {
    if (!bedsByRoom.has(bed.room_id)) bedsByRoom.set(bed.room_id, []);
    bedsByRoom.get(bed.room_id).push(bed);
  }

  // Two indexes, because two questions get asked constantly and a linear scan
  // for either would show on a property with a hundred beds and a year of
  // history: what one round found, and everything a day found across its three.
  //
  // A check carries its own slot, so neither index has to join back through the
  // round to know which of the three it belongs to.
  const byRound = new Map(); // 'day|slot' -> bed -> check
  const byDay = new Map();   // day -> bed -> [check, ...] in slot order
  for (const check of checks) {
    const slot = check.slot || 'morning';
    const key = `${check.day}|${slot}`;
    if (!byRound.has(key)) byRound.set(key, new Map());
    byRound.get(key).set(check.bed_id, check);

    if (!byDay.has(check.day)) byDay.set(check.day, new Map());
    const perBed = byDay.get(check.day);
    if (!perBed.has(check.bed_id)) perBed.set(check.bed_id, []);
    perBed.get(check.bed_id).push(check);
  }
  for (const perBed of byDay.values()) {
    for (const list of perBed.values()) {
      list.sort((a, b) => SLOT_KEYS.indexOf(a.slot || 'morning') - SLOT_KEYS.indexOf(b.slot || 'morning'));
    }
  }

  // The roster, night by night. Days with no rows are not filled in here: a
  // reader asks for a night and gets the nearest one at or before it, so a
  // roster nobody rewrote on Sunday still governs Sunday night.
  const rosterByDay = new Map();
  for (const row of raw.roster ?? []) {
    if (!rosterByDay.has(row.day)) rosterByDay.set(row.day, new Map());
    rosterByDay.get(row.day).set(row.bed_id, row);
  }
  const rosterDays = [...rosterByDay.keys()].sort();

  return {
    settings,
    timezone: settings.timezone || 'Africa/Accra',
    propertyName: settings.property_name || 'Hostel',
    rosterByDay,
    rosterDays,
    rooms,
    roomById,
    activeRooms: rooms.filter((r) => r.active),
    beds,
    bedById,
    bedsByRoom,
    activeBeds: beds.filter((b) => b.active && roomById.get(b.room_id)?.active),
    rounds: raw.rounds ?? [],
    roundByKey: new Map((raw.rounds ?? []).map((r) => [`${r.day}|${r.slot || 'morning'}`, r])),
    checks,
    byRound,
    byDay,
    recordedDays: [...byDay.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------
// Which night a check is looking at
// ---------------------------------------------------------------------------

/**
 * The roster day (the night) each of the three checks is judged against.
 *
 * The morning check reports on the night that has just ended, so it looks
 * backwards. The evening check reports on the night about to begin. The
 * housekeeping round falls between the two and is given both.
 */
export function rosterNightsFor(day, slot) {
  const previous = addDays(day, -1);
  if (slot === 'evening') return { nights: [day], governing: day };
  if (slot === 'housekeeping') return { nights: [previous, day], governing: previous };
  return { nights: [previous], governing: previous };
}

/**
 * What a bed was expected to be, given the roster on either side of a check.
 *
 * `previous` and `tonight` are what the two nights say: 'free', 'occupied', or
 * null for a bed nobody is tracking. The answer is what the check will be
 * judged against, and null means "do not judge this one".
 *
 * The changeover round is the interesting case. At eleven in the morning
 * last night's guest may have gone and tonight's has certainly not arrived, so
 * a bed that changes hands today can legitimately be found either way. Only
 * where both nights agree is there anything to be surprised by.
 */
export function expectedFor(slot, previous, tonight) {
  const prev = previous ?? null;
  const now = tonight ?? null;
  if (slot === 'morning') return prev;
  if (slot === 'evening') return now;
  return prev === now ? prev : null;
}

/**
 * The roster as it stood for one night, carried forward.
 *
 * A night nobody wrote a roster for is governed by the last one that was
 * written: bookings run over several nights, and treating a missed morning as
 * "nobody is expected anywhere" would quietly switch the reporting off.
 */
export function rosterOn(ds, day) {
  if (ds.rosterByDay.has(day)) return { day, rows: ds.rosterByDay.get(day), carried: false };

  let nearest = null;
  for (const d of ds.rosterDays) {
    if (d <= day) nearest = d;
    else break;
  }
  if (!nearest) return { day: null, rows: new Map(), carried: false };
  return { day: nearest, rows: ds.rosterByDay.get(nearest), carried: true };
}

/**
 * Everything a screen needs to know about what was expected of one bed at one
 * check: the answer, where it came from, and whether that night is settled.
 */
export function expectationFor(ds, day, slot, bedId) {
  const { nights, governing } = rosterNightsFor(day, slot);
  const previous = rosterOn(ds, nights[0]);
  const tonight = nights.length > 1 ? rosterOn(ds, nights[1]) : previous;

  const prevRow = previous.rows.get(bedId) ?? null;
  const nowRow = tonight.rows.get(bedId) ?? null;
  const source = slot === 'evening' ? nowRow : prevRow;

  return {
    state: expectedFor(slot, prevRow?.expected_state ?? null, nowRow?.expected_state ?? null),
    note: source?.expected_note ?? null,
    night: governing,
    from: slot === 'evening' ? tonight.day : previous.day,
    carried: slot === 'evening' ? tonight.carried : previous.carried,
    confirmed: Boolean(source?.confirmed_at),
  };
}

// ---------------------------------------------------------------------------
// Reading a single check
// ---------------------------------------------------------------------------

/**
 * What one recorded bed amounts to.
 *
 * `name_tag` is deliberately three-valued. A free bed was never asked the
 * question, and treating that silence as "no tag" would put every empty bed in
 * the property on the list of things to go and fix.
 */
export function findingsFor(check) {
  if (!check) return { untagged: false, unexpected: false, emptyBooked: false };
  const occupied = check.state === 'occupied';
  return {
    untagged: occupied && check.name_tag === 0,
    unexpected: occupied && check.expected_state === 'free',
    emptyBooked: !occupied && check.expected_state === 'occupied',
  };
}

/** True when a check found anything at all worth a manager's attention. */
export function hasFinding(check) {
  const f = findingsFor(check);
  return f.untagged || f.unexpected || f.emptyBooked;
}

/**
 * The single worst thing about a bed, for anything that can only show one
 * colour — a heatmap cell, a room chip, a row highlight.
 *
 * An untagged bed outranks a surprise occupant, which outranks an empty booked
 * bed, which outranks a bed nobody looked at. The order is the order somebody
 * should walk upstairs about them.
 */
export function severityOf(check) {
  if (!check) return 'unchecked';
  const f = findingsFor(check);
  if (f.untagged) return 'untagged';
  if (f.unexpected) return 'unexpected';
  if (f.emptyBooked) return 'empty_booked';
  return 'clear';
}

const SEVERITY_RANK = {
  clear: 0, unchecked: 1, empty_booked: 2, unexpected: 3, untagged: 4,
};

export function worstOf(severities) {
  let worst = 'clear';
  for (const s of severities) {
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Roll a list of checks into the numbers every screen shows.
 *
 * `expected` is passed in rather than derived, because the interesting figure
 * is almost always "of the beds that should have been checked", and only the
 * caller knows whether that means one room, one day or a whole quarter.
 */
export function tally(checks, expected = null) {
  let occupied = 0;
  let free = 0;
  let tagged = 0;
  let untagged = 0;
  let unexpected = 0;
  let emptyBooked = 0;

  for (const check of checks) {
    if (check.state === 'occupied') {
      occupied += 1;
      if (check.name_tag === 1) tagged += 1;
      if (check.name_tag === 0) untagged += 1;
    } else {
      free += 1;
    }
    const f = findingsFor(check);
    if (f.unexpected) unexpected += 1;
    if (f.emptyBooked) emptyBooked += 1;
  }

  const checked = checks.length;
  const issues = untagged + unexpected + emptyBooked;

  return {
    checked,
    expected,
    unchecked: expected == null ? null : Math.max(0, expected - checked),
    coverage: expected ? round((checked / expected) * 100, 1) : null,
    occupied,
    free,
    occupancy: checked ? round((occupied / checked) * 100, 1) : null,
    tagged,
    untagged,
    // Of the beds with somebody in them, how many said who. The figure a
    // manager is actually chasing, and the one that belongs on a wall.
    tagRate: occupied ? round((tagged / occupied) * 100, 1) : null,
    unexpected,
    emptyBooked,
    issues,
    clean: checked - issues,
  };
}

/** The last of the three rounds that anybody actually recorded on a day. */
function lastRoundWith(ds, day) {
  const done = SLOT_KEYS.filter((slot) => ds.byRound.has(`${day}|${slot}`));
  return done.at(-1) ?? 'morning';
}

/** Every check made on a day, across all three rounds. */
function checksOn(ds, day) {
  return [...(ds.byDay.get(day)?.values() ?? [])].flat();
}

/** What one round found: day plus which of the three checks. */
function checksInRound(ds, day, slot) {
  return [...(ds.byRound.get(`${day}|${slot}`)?.values() ?? [])];
}

function roundFor(ds, day, slot) {
  return ds.roundByKey.get(`${day}|${slot}`) ?? null;
}

/**
 * Whether a finding was still there at the end of the day.
 *
 * The whole reason for checking three times is that somebody puts things right
 * between them. A bed untagged in the morning and tagged by the evening was
 * dealt with; the same bed untagged in all three was not. Only the second kind
 * should keep a manager awake, so the reports separate them.
 *
 * Judged on the last round that actually answered for the bed, whichever that
 * was — a day whose evening check never happened is judged on the housekeeping
 * round rather than pretending the morning's finding was fixed.
 */
export function endOfDayFor(ds, day, bedId) {
  const list = ds.byDay.get(day)?.get(bedId) ?? [];
  return list.length ? list[list.length - 1] : null;
}

function checksIn(ds, from, to) {
  return ds.checks.filter((c) => c.day >= from && c.day <= to);
}

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------

/**
 * The state of every room and bed on one day.
 *
 * This is what the check screen draws itself from and what the email is built
 * out of, so it includes beds nobody has answered for yet — a round is a
 * checklist, and a checklist that hides its unfinished lines is a worse
 * checklist.
 */
export function dayReport(ds, day, slot = 'morning') {
  const round_ = roundFor(ds, day, slot);
  const onDay = ds.byRound.get(`${day}|${slot}`) ?? new Map();

  const rooms = ds.activeRooms.map((room) => {
    const beds = (ds.bedsByRoom.get(room.id) ?? []).filter((b) => b.active);
    const bedRows = beds.map((bed) => {
      const check = onDay.get(bed.id) ?? null;
      // What this round is judged against, which for the morning is last
      // night's roster rather than tonight's.
      const expected = expectationFor(ds, day, slot, bed.id);
      return {
        bedId: bed.id,
        label: bed.label,
        expectedState: expected.state,
        expectedNote: expected.note,
        expectedFrom: expected.night,
        expectedConfirmed: expected.confirmed,
        state: check?.state ?? null,
        nameTag: check?.name_tag ?? null,
        note: check?.note ?? null,
        checkedBy: check?.checked_by ?? null,
        at: check?.at ?? null,
        // The check's own snapshot, not the bed's — see the migration.
        wasExpected: check?.expected_state ?? null,
        severity: severityOf(check),
        findings: findingsFor(check),
      };
    });

    const checks = bedRows.filter((b) => b.state).map((b) => ({
      state: b.state,
      name_tag: b.nameTag,
      expected_state: b.wasExpected,
    }));

    return {
      roomId: room.id,
      name: room.name,
      block: room.block ?? null,
      note: room.note ?? null,
      beds: bedRows,
      totals: tally(checks, beds.length),
      severity: worstOf(bedRows.map((b) => b.severity)),
    };
  });

  const allChecks = [...onDay.values()];
  const expected = ds.activeBeds.length;

  const nights = rosterNightsFor(day, slot);

  return {
    day,
    slot,
    slotLabel: slotOf(slot).label,
    // Which night this round is reporting on, so a screen can say so rather
    // than leaving somebody to work out why the morning looks backwards.
    night: nights.governing,
    nights: nights.nights,
    round: round_
      ? {
          id: round_.id,
          submittedAt: round_.submitted_at,
          submittedBy: round_.submitted_by,
          note: round_.note,
          startedAt: round_.started_at,
        }
      : null,
    submitted: Boolean(round_?.submitted_at),
    totals: tally(allChecks, expected),
    rooms,
    // The list somebody walks upstairs with, ordered worst first.
    findings: rooms.flatMap((room) => room.beds
      .filter((bed) => bed.severity !== 'clear' && bed.severity !== 'unchecked')
      .map((bed) => ({
        roomId: room.roomId,
        room: room.name,
        block: room.block,
        bedId: bed.bedId,
        bed: bed.label,
        severity: bed.severity,
        note: bed.note,
        checkedBy: bed.checkedBy,
        expectedNote: bed.expectedNote,
      })))
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    notes: rooms.flatMap((room) => room.beds
      .filter((bed) => bed.note)
      .map((bed) => ({ room: room.name, bed: bed.label, note: bed.note, by: bed.checkedBy }))),
    people: peopleFrom(allChecks),
  };
}

function peopleFrom(checks) {
  const people = new Map();
  for (const check of checks) {
    const name = check.checked_by || 'Not recorded';
    if (!people.has(name)) people.set(name, []);
    people.get(name).push(check);
  }
  return [...people.entries()]
    .map(([name, list]) => ({
      name,
      checks: list.length,
      days: new Set(list.map((c) => c.day)).size,
      untaggedFound: list.filter((c) => findingsFor(c).untagged).length,
      unexpectedFound: list.filter((c) => findingsFor(c).unexpected).length,
    }))
    .sort((a, b) => b.checks - a.checks);
}

// ---------------------------------------------------------------------------
// A period
// ---------------------------------------------------------------------------

/**
 * Everything for a range of days, with the range immediately before it for
 * comparison — the same shape the maintenance report uses, so a manager who
 * reads one already knows how to read the other.
 */
export function periodReport(ds, from, to) {
  const days = rangeDays(from, to);
  const length = days.length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(length - 1));

  const bedCount = ds.activeBeds.length;
  const current = tally(checksIn(ds, from, to), bedCount * length || null);
  const previous = tally(checksIn(ds, prevFrom, prevTo), bedCount * length || null);

  const series = days.map((day) => {
    const dayChecks = checksOn(ds, day);
    const t = tally(dayChecks, bedCount || null);
    return {
      day,
      checked: t.checked,
      occupied: t.occupied,
      untagged: t.untagged,
      unexpected: t.unexpected,
      emptyBooked: t.emptyBooked,
      issues: t.issues,
      coverage: t.coverage,
      tagRate: t.tagRate,
      rounds: SLOT_KEYS.filter((key) => roundFor(ds, day, key)?.submitted_at).length,
    };
  });

  const rooms = roomBreakdown(ds, from, to, days);
  const beds = bedBreakdown(ds, from, to, days);

  return {
    from,
    to,
    days: length,
    roundsSubmitted: days.reduce(
      (n, d) => n + SLOT_KEYS.filter((key) => roundFor(ds, d, key)?.submitted_at).length, 0,
    ),
    roundsExpected: days.length * SLOT_KEYS.length,
    daysChecked: days.filter((d) => (ds.byDay.get(d)?.size ?? 0) > 0).length,
    bySlot: SLOT_KEYS.map((key) => {
      const inSlot = checksIn(ds, from, to).filter((c) => (c.slot || 'morning') === key);
      return {
        slot: key,
        ...slotOf(key),
        ...tally(inSlot, bedCount * length || null),
        rounds: days.filter((d) => roundFor(ds, d, key)).length,
        submitted: days.filter((d) => roundFor(ds, d, key)?.submitted_at).length,
        people: peopleFrom(inSlot).slice(0, 5),
      };
    }),
    resolution: resolutionOver(ds, days),
    bedCount,
    roomCount: ds.activeRooms.length,
    current,
    previous: { ...previous, from: prevFrom, to: prevTo },
    deltas: {
      untagged: delta(previous.untagged, current.untagged),
      unexpected: delta(previous.unexpected, current.unexpected),
      issues: delta(previous.issues, current.issues),
      tagRate: pointDelta(previous.tagRate, current.tagRate),
      coverage: pointDelta(previous.coverage, current.coverage),
      occupancy: pointDelta(previous.occupancy, current.occupancy),
    },
    series,
    rooms,
    beds,
    repeats: beds.filter((b) => b.untagged >= REPEAT_THRESHOLD),
    slots: SLOTS,
    heatmap: heatmap(ds, days),
    people: peopleFrom(checksIn(ds, from, to)),
    notes: checksIn(ds, from, to)
      .filter((c) => c.note)
      .slice(-100)
      .reverse()
      .map((c) => ({
        day: c.day,
        room: ds.roomById.get(ds.bedById.get(c.bed_id)?.room_id)?.name ?? 'Unknown room',
        bed: ds.bedById.get(c.bed_id)?.label ?? `#${c.bed_id}`,
        note: c.note,
        by: c.checked_by,
        severity: severityOf(c),
      })),
    alerts: alertsFor(ds, {
      from, to, days: length, current, rooms, beds, series,
      resolution: resolutionOver(ds, days),
    }),
  };
}

/** Percentage change. Null rather than zero when there is nothing to compare. */
function delta(before, after) {
  if (before == null || after == null || !before) return null;
  return round(((after - before) / before) * 100, 1);
}

/**
 * A difference in percentage points, for figures that are themselves
 * percentages. "Tag compliance rose 12%" and "rose 12 points" are different
 * claims, and only one of them is what the reader is looking at.
 */
function pointDelta(before, after) {
  if (before == null || after == null) return null;
  return round(after - before, 1);
}

function roomBreakdown(ds, from, to, days) {
  return ds.activeRooms.map((room) => {
    const beds = (ds.bedsByRoom.get(room.id) ?? []).filter((b) => b.active);
    const bedIds = new Set(beds.map((b) => b.id));
    const checks = checksIn(ds, from, to).filter((c) => bedIds.has(c.bed_id));
    const t = tally(checks, beds.length * days.length || null);

    const daysWithIssues = new Set(checks.filter(hasFinding).map((c) => c.day));
    const lastChecked = checks.length ? checks[checks.length - 1].day : null;

    return {
      roomId: room.id,
      name: room.name,
      block: room.block ?? null,
      bedCount: beds.length,
      ...t,
      daysWithIssues: daysWithIssues.size,
      // Findings per bed per day, so a twelve-bed dorm and a four-bed room can
      // sit in the same ranking without the big room always winning.
      issueRate: t.checked ? round(t.issues / t.checked, 3) : null,
      lastChecked,
      neverChecked: !checks.length,
    };
  }).sort((a, b) => b.untagged - a.untagged || b.issues - a.issues || a.name.localeCompare(b.name));
}

function bedBreakdown(ds, from, to) {
  const inRange = checksIn(ds, from, to);
  const groups = new Map();
  for (const check of inRange) {
    if (!groups.has(check.bed_id)) groups.set(check.bed_id, []);
    groups.get(check.bed_id).push(check);
  }

  return [...groups.entries()].map(([bedId, checks]) => {
    const bed = ds.bedById.get(bedId);
    const room = bed ? ds.roomById.get(bed.room_id) : null;
    const t = tally(checks, checks.length);
    const untaggedDays = checks.filter((c) => findingsFor(c).untagged).map((c) => c.day);

    return {
      bedId,
      label: bed?.label ?? `#${bedId}`,
      roomId: room?.id ?? null,
      room: room?.name ?? 'Unknown room',
      block: room?.block ?? null,
      checks: t.checked,
      occupied: t.occupied,
      untagged: t.untagged,
      unexpected: t.unexpected,
      emptyBooked: t.emptyBooked,
      issues: t.issues,
      tagRate: t.tagRate,
      untaggedDays,
      lastUntagged: untaggedDays.at(-1) ?? null,
    };
  }).sort((a, b) => b.untagged - a.untagged || b.issues - a.issues);
}

/**
 * Was it put right before the day was out?
 *
 * The reason for checking three times rather than once is that somebody fixes
 * things in between. So the number that matters is not how many findings there
 * were — it is how many were still there when the last person walked away.
 *
 * A bed only counts as resolved if a later round actually looked at it again.
 * Silence is not a fix, and a day whose evening check never happened must not
 * read as a day where everything got sorted out.
 */
export function resolutionOver(ds, days) {
  let found = 0;
  let fixed = 0;
  let unresolved = 0;
  let neverRechecked = 0;
  const lingering = [];

  for (const day of days) {
    const perBed = ds.byDay.get(day);
    if (!perBed) continue;

    for (const [bedId, list] of perBed) {
      const first = list.findIndex(hasFinding);
      if (first === -1) continue;
      found += 1;

      const last = list[list.length - 1];
      if (first === list.length - 1) {
        // Found by the last round that looked. Nobody had the chance to fix it.
        neverRechecked += 1;
        unresolved += 1;
      } else if (hasFinding(last)) {
        unresolved += 1;
      } else {
        fixed += 1;
        continue;
      }

      const bed = ds.bedById.get(bedId);
      lingering.push({
        day,
        bedId,
        bed: bed?.label ?? `#${bedId}`,
        roomId: bed?.room_id ?? null,
        room: ds.roomById.get(bed?.room_id)?.name ?? 'Unknown room',
        firstSeen: list[first].slot || 'morning',
        lastSeen: last.slot || 'morning',
        severity: severityOf(last),
        rechecked: first !== list.length - 1,
      });
    }
  }

  return {
    found,
    fixed,
    unresolved,
    // Found by the day's last round, so nobody got the chance to put it right.
    neverRechecked,
    fixRate: found ? round((fixed / found) * 100, 1) : null,
    lingering: lingering
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, 40),
  };
}

/**
 * Room by day, one cell each, coloured by the worst thing found in that room
 * that day.
 *
 * This is the panel that answers the question the owner actually asked — how
 * each room has been behaving over a period — in one glance. A table of the
 * same numbers is more precise and nobody reads it.
 */
export function heatmap(ds, days) {
  return {
    days,
    rows: ds.activeRooms.map((room) => {
      const beds = (ds.bedsByRoom.get(room.id) ?? []).filter((b) => b.active);
      return {
        roomId: room.id,
        name: room.name,
        block: room.block ?? null,
        cells: days.map((day) => {
          const onDay = ds.byDay.get(day);
          // The worst thing found in that room that day, whichever round found
          // it — one square cannot hold three answers.
          const checks = beds.flatMap((bed) => onDay?.get(bed.id) ?? []);
          if (!checks.length) {
            return {
              day, severity: 'unchecked', untagged: 0, issues: 0, unresolved: 0,
              checked: 0, beds: beds.length, rounds: 0,
            };
          }

          // A bed answered for in all three rounds is still one bed. Counting
          // the checks instead would report a twelve-bed dorm as thirty-six.
          const seen = new Set(checks.map((c) => c.bed_id));
          const t = tally(checks, null);
          // What was still wrong when the last round to see it walked away.
          const closing = beds
            .map((bed) => endOfDayFor(ds, day, bed.id))
            .filter(Boolean);

          return {
            day,
            severity: worstOf([
              ...checks.map(severityOf),
              ...(seen.size < beds.length ? ['unchecked'] : []),
            ]),
            untagged: t.untagged,
            issues: t.issues,
            unresolved: closing.filter(hasFinding).length,
            checked: seen.size,
            beds: beds.length,
            rounds: new Set(checks.map((c) => c.slot || 'morning')).size,
          };
        }),
      };
    }),
  };
}

/**
 * What needs somebody's attention, ordered by how bad it is rather than by how
 * recent — a list sorted by anything else gets skimmed.
 */
function alertsFor(ds, { from, to, days, current, rooms, beds, series, resolution }) {
  const alerts = [];

  if (resolution?.unresolved) {
    alerts.push({
      level: 'high',
      kind: 'unresolved',
      title: `${resolution.unresolved} ${resolution.unresolved === 1 ? 'bed was' : 'beds were'} still wrong at the end of the day`,
      detail: `Out of ${resolution.found} found across the period, ${resolution.fixed} `
        + `${resolution.fixed === 1 ? 'was' : 'were'} put right before the last check`
        + `${resolution.neverRechecked ? `, and ${resolution.neverRechecked} `
          + `${resolution.neverRechecked === 1 ? 'was' : 'were'} found by the last round of the day, `
          + 'so nobody had the chance' : ''}. `
        + 'Checking three times only helps if somebody acts between them.',
    });
  }

  if (current.untagged) {
    alerts.push({
      level: 'high',
      kind: 'untagged',
      title: `${current.untagged} occupied ${current.untagged === 1 ? 'bed had' : 'beds had'} no name tag`,
      detail: `Out of ${current.occupied} occupied ${current.occupied === 1 ? 'bed' : 'beds'} checked `
        + `in this period — ${current.tagRate == null ? '—' : `${current.tagRate}%`} of them were labelled. `
        + 'Each one is somebody sleeping in a bed nothing identifies.',
    });
  }

  if (current.unexpected) {
    alerts.push({
      level: 'high',
      kind: 'unexpected',
      title: `${current.unexpected} ${current.unexpected === 1 ? 'bed was' : 'beds were'} occupied when the roster said free`,
      detail: 'Either the booking never reached the front desk, or the bed was never sold. '
        + 'Both are worth knowing before the guest checks out.',
    });
  }

  const repeats = beds.filter((b) => b.untagged >= REPEAT_THRESHOLD);
  for (const bed of repeats.slice(0, 5)) {
    alerts.push({
      level: 'warn',
      kind: 'repeat_bed',
      roomId: bed.roomId,
      bedId: bed.bedId,
      title: `${bed.room} · ${bed.label} was found untagged ${bed.untagged} times`,
      detail: `Across ${new Set(bed.untaggedDays).size} separate days in this period. `
        + 'The same bed failing repeatedly is usually a habit on one shift rather than an accident.',
    });
  }

  // A room nobody has walked is indistinguishable from a room with nothing
  // wrong, and only one of those is good news.
  const never = rooms.filter((r) => r.neverChecked);
  if (never.length) {
    alerts.push({
      level: never.length === rooms.length ? 'info' : 'warn',
      kind: 'never_checked',
      title: `${never.length} ${never.length === 1 ? 'room was' : 'rooms were'} never checked in this period`,
      detail: `${never.slice(0, 6).map((r) => r.name).join(', ')}`
        + `${never.length > 6 ? `, and ${never.length - 6} more` : ''}. `
        + 'A room with no findings and a room nobody opened look identical on every other panel.',
    });
  }

  const missedDays = series.filter((s) => !s.checked).length;
  if (missedDays && missedDays < days) {
    alerts.push({
      level: 'warn',
      kind: 'missed_days',
      title: `No check at all was recorded on ${missedDays} of the ${days} days`,
      detail: 'The gaps drag every rate on this page around, because a day with no check '
        + 'counts as neither good nor bad.',
    });
  }

  // A round that keeps being skipped is worth naming: it is nearly always one
  // shift rather than a general slide, and it has somebody's name on it.
  const perSlot = SLOT_KEYS.map((key) => ({
    slot: key,
    label: slotOf(key).label,
    by: slotOf(key).by,
    done: rangeDays(from, to).filter((d) => roundFor(ds, d, key)).length,
  }));
  for (const slot of perSlot) {
    const missed = days - slot.done;
    if (missed < Math.max(2, days * 0.34)) continue;
    alerts.push({
      level: 'warn',
      kind: 'missed_round',
      title: `The ${slot.label.toLowerCase()} was not done on ${missed} of the ${days} days`,
      detail: `${slot.by} record this one. A round that is skipped this often is a rota `
        + 'problem rather than a system problem, and the days it covers are unwatched.',
    });
  }

  if (current.emptyBooked) {
    alerts.push({
      level: 'info',
      kind: 'empty_booked',
      title: `${current.emptyBooked} booked ${current.emptyBooked === 1 ? 'bed was' : 'beds were'} found empty`,
      detail: 'Usually a guest who left early. Worth a glance at the register if it keeps happening '
        + 'in the same room.',
    });
  }

  const worst = rooms.filter((r) => r.issues > 0).slice(0, 3);
  for (const room of worst) {
    if (!room.untagged) continue;
    alerts.push({
      level: 'warn',
      kind: 'room',
      roomId: room.roomId,
      title: `${room.name} accounts for ${room.untagged} of the untagged beds`,
      detail: `${room.issues} ${room.issues === 1 ? 'finding' : 'findings'} across `
        + `${room.daysWithIssues} ${room.daysWithIssues === 1 ? 'day' : 'days'}, from `
        + `${room.checked} bed ${room.checked === 1 ? 'check' : 'checks'}.`,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// One room, over time
// ---------------------------------------------------------------------------

/** Everything ever found in one room — the question a manager asks by name. */
export function roomDetail(ds, roomId, from, to) {
  const room = ds.roomById.get(roomId);
  if (!room) return null;

  const beds = (ds.bedsByRoom.get(roomId) ?? []).filter((b) => b.active);
  const bedIds = new Set(beds.map((b) => b.id));
  const all = ds.checks.filter((c) => bedIds.has(c.bed_id));
  const inRange = all.filter((c) => c.day >= from && c.day <= to);
  const days = rangeDays(from, to);

  return {
    room: {
      id: room.id, name: room.name, block: room.block ?? null, note: room.note ?? null,
    },
    from,
    to,
    bedCount: beds.length,
    totals: tally(inRange, beds.length * days.length || null),
    lifetime: tally(all, null),
    firstChecked: all.length ? all[0].day : null,
    lastChecked: all.length ? all[all.length - 1].day : null,
    beds: beds.map((bed) => {
      const checks = inRange.filter((c) => c.bed_id === bed.id);
      const t = tally(checks, days.length);
      // Tonight's roster, which is what "Roster now" means on this screen.
      const tonight = rosterOn(ds, to).rows.get(bed.id) ?? null;
      return {
        bedId: bed.id,
        label: bed.label,
        expectedState: tonight?.expected_state ?? null,
        expectedNote: tonight?.expected_note ?? null,
        ...t,
        lastCheck: checks.at(-1)
          ? {
              day: checks.at(-1).day,
              state: checks.at(-1).state,
              nameTag: checks.at(-1).name_tag,
              severity: severityOf(checks.at(-1)),
            }
          : null,
      };
    }),
    series: days.map((day) => {
      const checks = inRange.filter((c) => c.day === day);
      const t = tally(checks, beds.length);
      return {
        day,
        checked: t.checked,
        occupied: t.occupied,
        untagged: t.untagged,
        unexpected: t.unexpected,
        issues: t.issues,
      };
    }),
    history: inRange.slice(-200).reverse().map((c) => ({
      day: c.day,
      bed: ds.bedById.get(c.bed_id)?.label ?? `#${c.bed_id}`,
      state: c.state,
      nameTag: c.name_tag,
      expected: c.expected_state,
      severity: severityOf(c),
      note: c.note,
      by: c.checked_by,
      at: c.at,
    })),
  };
}

/**
 * A whole day: its three rounds side by side, and what was still wrong at the
 * end of it.
 *
 * This is the shape a manager thinks in. "Were the dorms checked today, by
 * whom, and is anything still outstanding" is one question, and answering it
 * with three separate reports would make them do the joining up themselves.
 */
export function dayOverview(ds, day) {
  const rounds = SLOT_KEYS.map((slot) => {
    const round_ = roundFor(ds, day, slot);
    const checks = checksInRound(ds, day, slot);
    return {
      ...slotOf(slot),
      slot,
      started: Boolean(round_),
      submitted: Boolean(round_?.submitted_at),
      submittedAt: round_?.submitted_at ?? null,
      submittedBy: round_?.submitted_by ?? null,
      note: round_?.note ?? null,
      totals: tally(checks, ds.activeBeds.length || null),
      people: peopleFrom(checks),
    };
  });

  // What the last round to see each bed left behind. This is the day's real
  // answer: everything else is how it got there.
  const closing = ds.activeBeds
    .map((bed) => ({ bed, check: endOfDayFor(ds, day, bed.id) }))
    .filter((x) => x.check);

  const outstanding = closing
    .filter((x) => hasFinding(x.check))
    .map(({ bed, check }) => ({
      bedId: bed.id,
      bed: bed.label,
      roomId: bed.room_id,
      room: ds.roomById.get(bed.room_id)?.name ?? 'Unknown room',
      severity: severityOf(check),
      slot: check.slot || 'morning',
      slotLabel: slotOf(check.slot || 'morning').short,
      note: check.note,
      checkedBy: check.checked_by,
    }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return {
    day,
    rounds,
    roundsSubmitted: rounds.filter((r) => r.submitted).length,
    // Judged on the last look each bed got, so a bed fixed by the evening does
    // not go on the list and one nobody came back to does.
    closing: tally(closing.map((x) => x.check), ds.activeBeds.length || null),
    outstanding,
    resolution: resolutionOver(ds, [day]),
  };
}

// ---------------------------------------------------------------------------
// The landing screen
// ---------------------------------------------------------------------------

/** Where the dorms stand today, and what the last month looked like. */
export function overview(ds, today) {
  const dayView = dayOverview(ds, today);
  // The rooms strip is drawn from the whole day rather than one round: a bed
  // put right at ten o'clock should not still be showing red at eight in the
  // evening.
  const todayReport = dayReport(ds, today, lastRoundWith(ds, today));
  const last30 = periodReport(ds, addDays(today, -29), today);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const month = periodReport(ds, monthFrom, today);

  // The last round anybody actually recorded, which on a quiet morning is
  // yesterday's — showing an empty "today" with no explanation reads as a
  // broken screen rather than an unstarted round.
  const lastDay = ds.recordedDays.at(-1) ?? null;

  return {
    today,
    lastCheckedDay: lastDay,
    daysSinceCheck: lastDay ? diffDays(lastDay, today) : null,
    todayTotals: dayView.closing,
    todayRounds: dayView.rounds.map((r) => ({
      slot: r.slot, label: r.label, short: r.short, by: r.by,
      started: r.started, submitted: r.submitted, submittedBy: r.submittedBy,
      checked: r.totals.checked, expected: r.totals.expected,
      untagged: r.totals.untagged, unexpected: r.totals.unexpected,
    })),
    todaySubmitted: dayView.roundsSubmitted === SLOT_KEYS.length,
    roundsSubmittedToday: dayView.roundsSubmitted,
    roundsPerDay: SLOT_KEYS.length,
    todayFindings: dayView.outstanding.slice(0, 12),
    todayResolution: dayView.resolution,
    rooms: todayReport.rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      block: room.block,
      severity: room.severity,
      checked: room.totals.checked,
      beds: room.beds.length,
      untagged: room.totals.untagged,
      unexpected: room.totals.unexpected,
      occupied: room.totals.occupied,
    })),
    headline: {
      untagged30: last30.current.untagged,
      unexpected30: last30.current.unexpected,
      tagRate30: last30.current.tagRate,
      coverage30: last30.current.coverage,
      occupancy30: last30.current.occupancy,
      monthUntagged: month.current.untagged,
      monthDelta: month.deltas.untagged,
      roundsThisMonth: month.roundsSubmitted,
      repeatBeds: last30.repeats.length,
    },
    alerts: last30.alerts.slice(0, 8),
    worstRooms: last30.rooms.filter((r) => r.issues > 0).slice(0, 8),
    repeats: last30.repeats.slice(0, 8),
    series: last30.series,
    recentRounds: [...ds.rounds].slice(-10).reverse().map((r) => {
      const t = tally(checksOn(ds, r.day), ds.activeBeds.length);
      return {
        day: r.day,
        submittedAt: r.submitted_at,
        submittedBy: r.submitted_by,
        checked: t.checked,
        expected: t.expected,
        untagged: t.untagged,
        unexpected: t.unexpected,
        issues: t.issues,
        coverage: t.coverage,
      };
    }),
  };
}

/** Rows for the CSV export: one line per bed check, flattened. */
export function exportRows(ds, from, to) {
  const rows = [[
    'Date', 'Room', 'Block', 'Bed', 'State', 'Name tag', 'Expected', 'Finding', 'Note', 'Checked by', 'Recorded at',
  ]];

  const label = {
    untagged: 'occupied, no name tag',
    unexpected: 'occupied but rostered free',
    empty_booked: 'empty but rostered occupied',
    clear: '',
  };

  for (const check of checksIn(ds, from, to)) {
    const bed = ds.bedById.get(check.bed_id);
    const room = bed ? ds.roomById.get(bed.room_id) : null;
    rows.push([
      check.day,
      room?.name ?? '',
      room?.block ?? '',
      bed?.label ?? `#${check.bed_id}`,
      check.state,
      check.state === 'occupied' ? (check.name_tag === 1 ? 'yes' : 'no') : '',
      check.expected_state ?? '',
      label[severityOf(check)] ?? '',
      check.note ?? '',
      check.checked_by ?? '',
      check.at ?? '',
    ]);
  }

  return rows;
}

/** Total findings across a period, used by the email subject line. */
export function issueCount(report) {
  return sum([report.current.untagged, report.current.unexpected, report.current.emptyBooked]);
}
