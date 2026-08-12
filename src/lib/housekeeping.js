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
 */

// A bed that keeps turning up untagged is a different problem from a bed that
// did it once, so the report needs a floor before it calls something a pattern.
const REPEAT_THRESHOLD = 2;

export async function loadDataset(db) {
  const [rooms, beds, rounds, checks, settings] = await Promise.all([
    db.prepare('SELECT * FROM hk_rooms ORDER BY sort_order, name').all(),
    db.prepare('SELECT * FROM hk_beds ORDER BY room_id, sort_order, label').all(),
    db.prepare('SELECT * FROM hk_rounds ORDER BY day').all(),
    db.prepare('SELECT * FROM hk_checks ORDER BY day, id').all(),
    db.prepare('SELECT key, value FROM settings').all(),
  ]);

  return makeDataset({
    rooms: rooms.results ?? [],
    beds: beds.results ?? [],
    rounds: rounds.results ?? [],
    checks: checks.results ?? [],
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

  // day -> bed -> check. Every screen asks "what happened to this bed on this
  // day" at least once per bed, and a linear scan per question would show on a
  // property with a hundred beds and a year of history.
  const byDay = new Map();
  for (const check of checks) {
    if (!byDay.has(check.day)) byDay.set(check.day, new Map());
    byDay.get(check.day).set(check.bed_id, check);
  }

  return {
    settings,
    timezone: settings.timezone || 'Africa/Accra',
    propertyName: settings.property_name || 'Hostel',
    rooms,
    roomById,
    activeRooms: rooms.filter((r) => r.active),
    beds,
    bedById,
    bedsByRoom,
    activeBeds: beds.filter((b) => b.active && roomById.get(b.room_id)?.active),
    rounds: raw.rounds ?? [],
    roundByDay: new Map((raw.rounds ?? []).map((r) => [r.day, r])),
    checks,
    byDay,
    recordedDays: [...byDay.keys()].sort(),
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

function checksOn(ds, day) {
  return [...(ds.byDay.get(day)?.values() ?? [])];
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
export function dayReport(ds, day) {
  const round_ = ds.roundByDay.get(day) ?? null;
  const onDay = ds.byDay.get(day) ?? new Map();

  const rooms = ds.activeRooms.map((room) => {
    const beds = (ds.bedsByRoom.get(room.id) ?? []).filter((b) => b.active);
    const bedRows = beds.map((bed) => {
      const check = onDay.get(bed.id) ?? null;
      return {
        bedId: bed.id,
        label: bed.label,
        expectedState: bed.expected_state ?? null,
        expectedNote: bed.expected_note ?? null,
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

  return {
    day,
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
      submitted: Boolean(ds.roundByDay.get(day)?.submitted_at),
    };
  });

  const rooms = roomBreakdown(ds, from, to, days);
  const beds = bedBreakdown(ds, from, to, days);

  return {
    from,
    to,
    days: length,
    roundsSubmitted: days.filter((d) => ds.roundByDay.get(d)?.submitted_at).length,
    daysChecked: days.filter((d) => (ds.byDay.get(d)?.size ?? 0) > 0).length,
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
    alerts: alertsFor(ds, { from, to, days: length, current, rooms, beds, series }),
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
          const checks = beds.map((bed) => onDay?.get(bed.id)).filter(Boolean);
          if (!checks.length) {
            return { day, severity: 'unchecked', untagged: 0, issues: 0, checked: 0, beds: beds.length };
          }
          const t = tally(checks, beds.length);
          return {
            day,
            severity: worstOf([
              ...checks.map(severityOf),
              ...(checks.length < beds.length ? ['unchecked'] : []),
            ]),
            untagged: t.untagged,
            issues: t.issues,
            checked: t.checked,
            beds: beds.length,
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
function alertsFor(ds, { from, to, days, current, rooms, beds, series }) {
  const alerts = [];

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
      title: `No round was recorded on ${missedDays} of the ${days} days`,
      detail: 'The gaps drag every rate on this page around, because a day with no check '
        + 'counts as neither good nor bad.',
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
      return {
        bedId: bed.id,
        label: bed.label,
        expectedState: bed.expected_state ?? null,
        expectedNote: bed.expected_note ?? null,
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

// ---------------------------------------------------------------------------
// The landing screen
// ---------------------------------------------------------------------------

/** Where the dorms stand today, and what the last month looked like. */
export function overview(ds, today) {
  const todayReport = dayReport(ds, today);
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
    todayTotals: todayReport.totals,
    todaySubmitted: todayReport.submitted,
    todayFindings: todayReport.findings.slice(0, 12),
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
