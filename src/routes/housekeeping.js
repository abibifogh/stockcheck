import {
  badRequest, csvResponse, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import {
  dayOverview, dayReport, defaultSlotFor, expectedFor, exportRows, isSlot,
  loadDataset, overview as overviewReport, periodReport, roomDetail,
  rosterNightsFor, slotClosedReason, slotOf, visibleSlots,
} from '../lib/housekeeping.js';
import { notifyRoundSubmitted } from '../lib/email.js';
import { createNotice, roundNotice } from '../lib/notices.js';
import { addDays, diffDays, isDay, todayIn } from '../util/dates.js';

/**
 * The bed check's API.
 *
 * `saveChecks` is the endpoint that matters. A housekeeper has a phone in one
 * hand, a trolley in the other and eleven rooms to get through before the
 * guests come back, so it accepts a whole room in one request, creates the
 * day's round if nobody has started one, and never asks for anything it can
 * work out for itself.
 */

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action,
    entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

/**
 * Can this person see what the front desk expects of a bed?
 *
 * Not the housekeeper walking the round: being shown the answer before you look
 * is how a check quietly stops being one. Managers reading reports need it to
 * make sense of a finding, and whoever fills the roster in obviously knows it
 * already.
 */
function seesRoster(ctx) {
  return ['hk_reports', 'hk_roster', 'hk_setup']
    .some((p) => ctx.session.permissions.includes(p));
}

/**
 * Which of the three checks a request means.
 *
 * Defaulted from the clock in the property's own timezone rather than the
 * browser's, so a manager looking from another country opens the round the
 * hostel is actually in the middle of.
 */
function hourIn(timezone) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hour12: false,
  }).format(new Date()));
  return Number.isFinite(hour) ? hour : 12;
}

function readSlot(value, timezone, ctx = null) {
  if (isSlot(value)) return value;
  return defaultSlotFor(hourIn(timezone), ctx?.session?.user?.role);
}

/** A manager is correcting the record rather than walking a round. */
function canManageRounds(ctx) {
  return ctx.session.permissions.some((p) => p === 'hk_reports' || p === 'hk_setup');
}

/**
 * Can this person record this round, right now?
 *
 * Two rules, answering two different worries. The housekeeping round is the
 * housekeepers' own — a round reception filled in says nothing about whether
 * anybody walked the rooms. And reception's two rounds have hours, so a check
 * cannot be done at five in the morning and called the morning check.
 *
 * Both are about the shift somebody is on now, not the day being recorded:
 * catching up on another shift's round is how one person's guess becomes
 * another person's record. Both bend for a manager, who is the way anything in
 * somebody else's round gets put right.
 */
function assertCanRecord(ctx, { slot, timezone }) {
  const reason = slotClosedReason(slot, {
    hour: hourIn(timezone),
    role: ctx.session.user.role,
    canManage: canManageRounds(ctx),
  });
  if (reason) throw badRequest(reason);
}

function readDay(value, fallback) {
  if (value == null || value === '') return fallback;
  const day = String(value);
  if (!isDay(day)) throw badRequest('That date is not valid.');
  return day;
}

// ---------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------

/**
 * Everything the check screen needs to draw itself, in one call.
 *
 * What the roster expects of each bed is stripped out for anyone who only holds
 * `hk_check`. It is not a secret worth guarding, but a housekeeper who can see
 * "this bed should be empty" before answering is being handed the answer, and a
 * check that agrees with the roster by construction finds nothing.
 */
export async function bootstrap(ctx) {
  const ds = await loadDataset(ctx.db);
  const today = todayIn(ds.timezone);
  const day = readDay(ctx.url.searchParams.get('day'), today);

  // The round this person is on, and only that one — on whichever day they are
  // looking at. A receptionist has no business with the housekeeping round at
  // any hour, and the one who comes in at three has none with the morning
  // check either, today's or yesterday's: it was another shift, and a tab
  // holding somebody else's finished round is an invitation to "correct" work
  // they did not do. Absent rather than greyed, because there is nothing to
  // explain about a round that was never on offer.
  const canManage = canManageRounds(ctx);
  const mine = visibleSlots(ctx.session.user.role, {
    hour: hourIn(ds.timezone),
    canManage,
  });
  const visible = new Set(mine.map((s) => s.key));

  const asked = readSlot(ctx.url.searchParams.get('slot'), ds.timezone, ctx);
  // Asking for somebody else's round by hand lands on your own rather than on
  // an error: there is nothing to explain, because it was never on offer.
  const slot = visible.has(asked)
    ? asked
    : defaultSlotFor(hourIn(ds.timezone), ctx.session.user.role);

  const report = dayReport(ds, day, slot);
  const overview = dayOverview(ds, day);
  const roster = seesRoster(ctx);

  return json({
    day,
    today,
    slot,
    slots: mine,
    // The other rounds, so the screen can show what has and has not been done
    // today without a second request.
    rounds: overview.rounds.filter((r) => visible.has(r.slot)).map((r) => ({
      slot: r.slot,
      label: r.label,
      short: r.short,
      by: r.by,
      detail: r.detail,
      from: r.from ?? null,
      to: r.to ?? null,
      started: r.started,
      submitted: r.submitted,
      submittedBy: r.submittedBy,
      checked: r.totals.checked,
      expected: r.totals.expected,
      untagged: r.totals.untagged,
      // Why a round cannot be filled in, in the same words the server would
      // refuse it with — so the screen can say so before somebody walks a
      // floor and then finds out.
      closed: slotClosedReason(r.slot, {
        hour: hourIn(ds.timezone),
        role: ctx.session.user.role,
        canManage,
      }),
    })),
    propertyName: ds.propertyName,
    submitted: report.submitted,
    round: report.round,
    totals: report.totals,
    canSeeRoster: roster,
    // Which night this round is judged against. Only sent to somebody who can
    // see the roster in the first place — it is meaningless without it.
    ...(roster ? { night: report.night, nights: report.nights } : {}),
    rooms: report.rooms.map((room) => ({
      roomId: room.roomId,
      name: room.name,
      block: room.block,
      note: room.note,
      totals: room.totals,
      beds: room.beds.map((bed) => ({
        bedId: bed.bedId,
        label: bed.label,
        state: bed.state,
        nameTag: bed.nameTag,
        note: bed.note,
        checkedBy: bed.checkedBy,
        at: bed.at,
        ...(roster
          ? { expectedState: bed.expectedState, expectedNote: bed.expectedNote, severity: bed.severity }
          : {}),
      })),
    })),
    // Recent rounds give the person doing the round a way back into yesterday
    // if they realise they answered something wrongly.
    // The same boundary as the tabs: the afternoon desk gets back to its own
    // earlier rounds, and to nobody else's.
    recent: [...ds.rounds]
      .filter((r) => visible.has(r.slot || 'morning'))
      .slice(-9)
      .reverse()
      .map((r) => ({
        day: r.day,
        slot: r.slot || 'morning',
        slotLabel: slotOf(r.slot || 'morning').short,
        submittedAt: r.submitted_at,
        submittedBy: r.submitted_by,
      })),
  });
}

/**
 * Record answers for one or more beds.
 *
 * Everything goes in one transaction. A half-saved room is worse than an
 * unsaved one: the beds that made it look checked, so nobody goes back for the
 * rest, and the gap becomes permanent.
 */
export async function saveChecks(ctx) {
  const body = await readJson(ctx.request);

  // Deliberately not the whole dataset. This runs every few taps for the length
  // of a round, and it needs two things: the beds, to check the answers against,
  // and the timezone, to know what "today" means here. Reading a year of past
  // checks to write four rows would make the fastest screen in the system the
  // heaviest query in it.
  const [bedRows, settingRows] = await Promise.all([
    // A bed in a closed room is not a bed anybody should be answering for, so
    // the room's own state is folded into the bed's here.
    ctx.db.prepare(
      `SELECT b.id, b.label,
              CASE WHEN b.active = 1 AND r.active = 1 THEN 1 ELSE 0 END AS active
         FROM hk_beds b JOIN hk_rooms r ON r.id = b.room_id`,
    ).all(),
    ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").all(),
  ]);
  const bedById = new Map((bedRows.results ?? []).map((b) => [b.id, b]));

  const timezone = settingRows.results?.[0]?.value || 'Africa/Accra';
  const today = todayIn(timezone);
  const day = readDay(body.day, today);
  const slot = readSlot(body.slot, timezone, ctx);

  if (day > today) throw badRequest('That date is in the future.');
  if (diffDays(day, today) > 60) {
    throw badRequest('That day is more than two months ago and can no longer be recorded.');
  }
  // Whose round it is, and whether it is open. Checked before anything is read
  // or written, so a refused round leaves no trace of having been started.
  assertCanRecord(ctx, { slot, timezone });

  // Which night this round is judged against — last night for the morning,
  // tonight for the evening, both for the round in between.
  const expectedByBed = await expectationsFor(ctx.db, day, slot);

  const entries = Array.isArray(body.checks) ? body.checks : [];
  if (!entries.length) throw badRequest('Nothing was recorded.');
  if (entries.length > 500) throw badRequest('That is more than 500 beds in one save.');

  const clean = [];
  for (const entry of entries) {
    const bedId = Number(entry.bedId);
    const bed = bedById.get(bedId);
    if (!bed || !bed.active) throw badRequest('One of those beds is no longer on the list.');

    const state = entry.state === 'occupied' ? 'occupied' : entry.state === 'free' ? 'free' : null;
    if (!state) throw badRequest('Every bed has to be marked occupied or free.');

    // The follow-up question is only asked of an occupied bed, and is only
    // optional in the sense that an empty bed was never asked it.
    let nameTag = null;
    if (state === 'occupied') {
      if (entry.nameTag !== true && entry.nameTag !== false) {
        throw badRequest(`Say whether ${bed.label} has a name tag.`);
      }
      nameTag = entry.nameTag ? 1 : 0;
    }

    clean.push({
      bedId,
      state,
      nameTag,
      // What the governing night's roster says, frozen onto the check. It can
      // still move until that night is confirmed the following morning — and
      // confirming re-stamps these — but after that it is settled for good.
      expected: expectedByBed.get(bedId) ?? null,
      note: str(entry.note, 'Note', { max: 300, fallback: '' }) || null,
    });
  }

  // The round is created on first save rather than by a "start round" button:
  // one less thing for somebody standing in a doorway to remember.
  await ctx.db.prepare(
    `INSERT INTO hk_rounds (day, slot) VALUES (?1, ?2)
     ON CONFLICT(day, slot) DO UPDATE SET updated_at = datetime('now')`,
  ).bind(day, slot).run();

  const round = await ctx.db.prepare('SELECT * FROM hk_rounds WHERE day = ? AND slot = ?')
    .bind(day, slot).first();

  try {
    await ctx.db.batch(clean.map((c) => ctx.db.prepare(
      `INSERT INTO hk_checks (round_id, day, slot, bed_id, state, name_tag, expected_state, note, checked_by, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
       ON CONFLICT(round_id, bed_id) DO UPDATE SET
         state          = ?5,
         name_tag       = ?6,
         expected_state = ?7,
         note           = ?8,
         checked_by     = ?9,
         at             = datetime('now')`,
    ).bind(
      round.id, day, slot, c.bedId, c.state, c.nameTag, c.expected, c.note, ctx.session.user.name,
    )));
  } catch (err) {
    rethrowConstraint(err, { foreignKey: 'One of those beds is no longer on the list.' });
    throw err;
  }

  await audit(ctx, 'hk.check', `${day} ${slot}`, {
    slot,
    beds: clean.length,
    untagged: clean.filter((c) => c.nameTag === 0).length,
  });

  // Counted straight out of the database rather than from what was just sent,
  // so the progress figure on the phone is the round as it really stands —
  // including whatever a colleague on another floor has been recording.
  const totals = await ctx.db.prepare(
    `SELECT COUNT(*) AS checked,
            SUM(CASE WHEN state = 'occupied' THEN 1 ELSE 0 END) AS occupied,
            SUM(CASE WHEN state = 'occupied' AND name_tag = 0 THEN 1 ELSE 0 END) AS untagged
       FROM hk_checks WHERE day = ? AND slot = ?`,
  ).bind(day, slot).first();

  return json({
    ok: true,
    day,
    slot,
    recorded: clean.length,
    totals: {
      checked: totals?.checked ?? 0,
      occupied: totals?.occupied ?? 0,
      untagged: totals?.untagged ?? 0,
      expected: [...bedById.values()].filter((b) => b.active).length,
    },
    submitted: Boolean(round.submitted_at),
  });
}

/**
 * Finish the day's round.
 *
 * Submitting is what sends the email, so it is deliberately a separate act from
 * saving: a housekeeper part-way through the first floor has not finished
 * anything, and the manager should not be told they have.
 */
export async function submitRound(ctx, day, slot) {
  if (!isDay(day)) throw badRequest('That date is not valid.');
  if (!isSlot(slot)) throw badRequest('That is not one of the day\'s checks.');

  const ds = await loadDataset(ctx.db);
  const report = dayReport(ds, day, slot);
  assertCanRecord(ctx, { slot, timezone: ds.timezone });

  const round = ds.roundByKey.get(`${day}|${slot}`);
  if (!round) throw badRequest('Nothing has been recorded for that check yet.');
  if (!report.totals.checked) throw badRequest('No beds have been answered for yet.');

  const body = await readJson(ctx.request).catch(() => ({}));
  const note = str(body.note, 'Note', { max: 500, fallback: '' }) || null;

  // A partial round can be submitted — a floor that is closed for painting
  // should not hold the whole property hostage — but the gaps travel with it,
  // in the response and in the email, rather than being quietly rounded away.
  const resubmission = Boolean(round.submitted_at);

  await ctx.db.batch([
    ctx.db.prepare(
      `UPDATE hk_rounds SET submitted_at = datetime('now'), submitted_by = ?2, note = ?3,
              updated_at = datetime('now')
        WHERE day = ?1 AND slot = ?4`,
    ).bind(day, ctx.session.user.name, note, slot),
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      `${ctx.session.user.name} (${ctx.session.user.role})`,
      resubmission ? 'hk.round.resubmit' : 'hk.round.submit',
      `${day} ${slot}`,
      JSON.stringify({
        slot,
        checked: report.totals.checked,
        expected: report.totals.expected,
        untagged: report.totals.untagged,
        unexpected: report.totals.unexpected,
      }),
    ),
  ]);

  // Recorded before the email is even attempted, and not in the background: the
  // bell is the one channel that cannot fail on somebody else's infrastructure,
  // so it is the one that must be there by the time the response lands.
  await createNotice(ctx.db, roundNotice({
    slotLabel: slotOf(slot).label,
    day,
    submittedBy: ctx.session.user.name,
    totals: report.totals,
    findings: report.findings.length,
    resubmission,
  }));

  // The email must never be able to hold up, or fail, somebody pressing Submit
  // in a corridor. Whether a mail provider is having a bad morning is not the
  // housekeeper's problem.
  const task = notifyRoundSubmitted(ctx.db, ctx.env, {
    day,
    slot,
    submittedBy: ctx.session.user.name,
    resubmission,
  });
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
  else await task.catch(() => {});

  return json({
    ok: true,
    day,
    slot,
    slotLabel: slotOf(slot).label,
    submitted: true,
    resubmission,
    totals: report.totals,
    findings: report.findings.length,
  });
}

/** A whole day: its three rounds, and what was left outstanding by the last. */
export async function getDay(ctx) {
  const ds = await loadDataset(ctx.db);
  const day = readDay(ctx.url.searchParams.get('day'), todayIn(ds.timezone));
  const slot = ctx.url.searchParams.get('slot');
  return json(isSlot(slot) ? dayReport(ds, day, slot) : dayOverview(ds, day));
}

export async function listRounds(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 30, 200);
  const rows = await ctx.db.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM hk_checks c WHERE c.round_id = r.id) AS checks,
            (SELECT COUNT(*) FROM hk_checks c WHERE c.round_id = r.id
               AND c.state = 'occupied' AND c.name_tag = 0) AS untagged
       FROM hk_rounds r
      ORDER BY r.day DESC, r.id DESC
      LIMIT ?`,
  ).bind(limit).all();
  return json({ rounds: rows.results ?? [] });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function overview(ctx) {
  const ds = await loadDataset(ctx.db);
  return json(overviewReport(ds, todayIn(ds.timezone)));
}

/** A range, defaulting to the last 30 days. */
function readRange(ctx, ds) {
  const q = ctx.url.searchParams;
  const to = q.get('to') || todayIn(ds.timezone);
  const from = q.get('from') || addDays(to, -29);
  if (!isDay(from) || !isDay(to)) throw badRequest('Those dates are not valid.');
  if (from > to) throw badRequest('The start date is after the end date.');
  if (diffDays(from, to) > 730) throw badRequest('That range is longer than two years.');
  return { from, to };
}

export async function report(ctx) {
  const ds = await loadDataset(ctx.db);
  const { from, to } = readRange(ctx, ds);
  return json(periodReport(ds, from, to));
}

export async function roomReport(ctx, id) {
  const ds = await loadDataset(ctx.db);
  const { from, to } = readRange(ctx, ds);
  const detail = roomDetail(ds, Number(id), from, to);
  if (!detail) throw notFound('That room no longer exists.');
  return json(detail);
}

export async function exportCsv(ctx) {
  const ds = await loadDataset(ctx.db);
  const { from, to } = readRange(ctx, ds);
  return csvResponse(`bed-checks-${from}-to-${to}.csv`, exportRows(ds, from, to));
}

// ---------------------------------------------------------------------------
// Setup: rooms, beds and the roster
// ---------------------------------------------------------------------------

export async function listRooms(ctx) {
  const [rooms, beds] = await Promise.all([
    ctx.db.prepare('SELECT * FROM hk_rooms ORDER BY sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM hk_beds ORDER BY room_id, sort_order, label').all(),
  ]);

  const byRoom = new Map();
  for (const bed of beds.results ?? []) {
    if (!byRoom.has(bed.room_id)) byRoom.set(bed.room_id, []);
    byRoom.get(bed.room_id).push(bed);
  }

  return json({
    rooms: (rooms.results ?? []).map((room) => ({ ...room, beds: byRoom.get(room.id) ?? [] })),
  });
}

/**
 * Add a room, and its beds with it.
 *
 * A room with no beds in it is useless to the check screen, and making somebody
 * add "Bed 1" through "Bed 12" one at a time is how a setup screen goes unused.
 */
export async function createRoom(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  const bedCount = num(body.bedCount, 'Number of beds', { min: 0, max: 60, fallback: 0 });
  // Trimmed on the way in, so the separating space is put back here rather than
  // depending on whoever typed the prefix remembering to leave one.
  const prefix = str(body.bedPrefix, 'Bed prefix', { max: 30, fallback: 'Bed' }) || 'Bed';

  let room;
  try {
    room = await ctx.db.prepare(
      'INSERT INTO hk_rooms (name, block, sort_order, note) VALUES (?1, ?2, ?3, ?4) RETURNING *',
    ).bind(
      name,
      str(body.block, 'Block', { max: 60, fallback: '' }) || null,
      num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 100 }),
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
    ).first();
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a room with that name.' });
    throw err;
  }

  const beds = Math.round(bedCount);
  if (beds > 0) {
    const statements = [];
    for (let n = 1; n <= beds; n++) {
      statements.push(ctx.db.prepare(
        'INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order) VALUES (?1, ?2, ?3)',
      ).bind(room.id, `${prefix} ${n}`, n * 10));
    }
    await ctx.db.batch(statements);
  }

  await audit(ctx, 'hk.room.create', room.id, { name, beds });
  return json({ room, beds }, { status: 201 });
}

export async function updateRoom(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });

  try {
    const row = await ctx.db.prepare(
      `UPDATE hk_rooms SET name = ?2, block = ?3, sort_order = ?4, note = ?5, active = ?6
        WHERE id = ?1 RETURNING *`,
    ).bind(
      Number(id), name,
      str(body.block, 'Block', { max: 60, fallback: '' }) || null,
      num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 100 }),
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
      body.active === false ? 0 : 1,
    ).first();
    if (!row) throw notFound('That room no longer exists.');
    await audit(ctx, 'hk.room.update', id, { name });
    return json({ room: row });
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a room with that name.' });
    throw err;
  }
}

/**
 * Retire rather than delete once a room has been checked: deleting would take
 * its history with it, and a month whose findings quietly vanished is worse
 * than a room that is still listed as closed.
 */
export async function deleteRoom(ctx, id) {
  const used = await ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM hk_checks c
       JOIN hk_beds b ON b.id = c.bed_id
      WHERE b.room_id = ?`,
  ).bind(Number(id)).first();

  if (used?.n > 0) {
    await ctx.db.batch([
      ctx.db.prepare('UPDATE hk_rooms SET active = 0 WHERE id = ?').bind(Number(id)),
      ctx.db.prepare('UPDATE hk_beds SET active = 0 WHERE room_id = ?').bind(Number(id)),
    ]);
    await audit(ctx, 'hk.room.retire', id, { history: used.n });
    return json({ ok: true, retired: true });
  }

  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM hk_beds WHERE room_id = ?').bind(Number(id)),
    ctx.db.prepare('DELETE FROM hk_rooms WHERE id = ?').bind(Number(id)),
  ]);
  await audit(ctx, 'hk.room.delete', id, null);
  return json({ ok: true, retired: false });
}

export async function createBed(ctx) {
  const body = await readJson(ctx.request);
  const roomId = Number(body.roomId);
  const label = str(body.label, 'Bed name', { required: true, max: 40 });

  const room = await ctx.db.prepare('SELECT id FROM hk_rooms WHERE id = ?').bind(roomId).first();
  if (!room) throw badRequest('That room no longer exists.');

  try {
    const row = await ctx.db.prepare(
      'INSERT INTO hk_beds (room_id, label, sort_order) VALUES (?1, ?2, ?3) RETURNING *',
    ).bind(roomId, label, num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 500 })).first();
    await audit(ctx, 'hk.bed.create', row.id, { roomId, label });
    return json({ bed: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: 'That room already has a bed with that name.' });
    throw err;
  }
}

export async function updateBed(ctx, id) {
  const body = await readJson(ctx.request);
  const label = str(body.label, 'Bed name', { required: true, max: 40 });

  try {
    const row = await ctx.db.prepare(
      `UPDATE hk_beds SET label = ?2, sort_order = ?3, active = ?4 WHERE id = ?1 RETURNING *`,
    ).bind(
      Number(id), label,
      num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 500 }),
      body.active === false ? 0 : 1,
    ).first();
    if (!row) throw notFound('That bed no longer exists.');
    return json({ bed: row });
  } catch (err) {
    rethrowConstraint(err, { unique: 'That room already has a bed with that name.' });
    throw err;
  }
}

export async function deleteBed(ctx, id) {
  const used = await ctx.db.prepare('SELECT COUNT(*) AS n FROM hk_checks WHERE bed_id = ?')
    .bind(Number(id)).first();

  if (used?.n > 0) {
    await ctx.db.prepare('UPDATE hk_beds SET active = 0 WHERE id = ?').bind(Number(id)).run();
    return json({ ok: true, retired: true });
  }
  await ctx.db.prepare('DELETE FROM hk_beds WHERE id = ?').bind(Number(id)).run();
  return json({ ok: true, retired: false });
}

/**
 * The handful of settings a housekeeping-only site still needs.
 *
 * On the full site these live in the breakfast Setup screen, which a
 * housekeeping deployment does not have — so the two that matter travel with
 * the dorms instead. The property's name is on every screen and on every email;
 * the timezone decides which calendar day a round belongs to, and getting it
 * wrong files the morning's check against yesterday.
 */
export async function updateSettings(ctx) {
  const body = await readJson(ctx.request);
  const statements = [];

  if (body.propertyName !== undefined) {
    statements.push(setting(ctx.db, 'property_name', str(body.propertyName, 'Property name', { max: 100, fallback: '' }) || ''));
  }
  if (body.timezone !== undefined) {
    const zone = str(body.timezone, 'Timezone', { max: 60, fallback: '' }) || 'Africa/Accra';
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
    } catch {
      throw badRequest('That is not a timezone this system recognises.');
    }
    statements.push(setting(ctx.db, 'timezone', zone));
  }

  if (!statements.length) throw badRequest('Nothing to save.');
  await ctx.db.batch(statements);
  await audit(ctx, 'hk.settings.update', null, { keys: statements.length });

  const rows = await ctx.db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('property_name','timezone')",
  ).all();
  return json({ settings: Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value])) });
}

function setting(db, key, value) {
  return db.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  ).bind(key, value);
}

// ---------------------------------------------------------------------------
// The roster, night by night
// ---------------------------------------------------------------------------

/** 'occupied', 'free', or null for a bed nobody is tracking — which is a real answer. */
function readExpected(value) {
  return value === 'occupied' ? 'occupied' : value === 'free' ? 'free' : null;
}

/**
 * The roster as it stood on one night, carried forward from the last night
 * anybody wrote one. Two small queries rather than the whole dataset: this runs
 * on every save of a round.
 */
async function rosterRowsOn(db, day) {
  const exact = await db.prepare('SELECT * FROM hk_roster WHERE day = ?').bind(day).all();
  if (exact.results?.length) {
    return { day, rows: new Map(exact.results.map((r) => [r.bed_id, r])), carried: false };
  }

  const nearest = await db.prepare(
    'SELECT day FROM hk_roster WHERE day <= ? ORDER BY day DESC LIMIT 1',
  ).bind(day).first();
  if (!nearest) return { day: null, rows: new Map(), carried: false };

  const rows = await db.prepare('SELECT * FROM hk_roster WHERE day = ?').bind(nearest.day).all();
  return { day: nearest.day, rows: new Map((rows.results ?? []).map((r) => [r.bed_id, r])), carried: true };
}

/**
 * What each bed is expected to be at one check, by bed id.
 *
 * The rule lives in the analytics layer so the reports and the writes cannot
 * disagree about it; this only fetches the two nights it needs.
 */
async function expectationsFor(db, day, slot) {
  const { nights } = rosterNightsFor(day, slot);
  const previous = await rosterRowsOn(db, nights[0]);
  const tonight = nights.length > 1 ? await rosterRowsOn(db, nights[1]) : previous;

  const out = new Map();
  for (const bedId of new Set([...previous.rows.keys(), ...tonight.rows.keys()])) {
    out.set(bedId, expectedFor(
      slot,
      previous.rows.get(bedId)?.expected_state ?? null,
      tonight.rows.get(bedId)?.expected_state ?? null,
    ));
  }
  return out;
}

/**
 * Re-stamp the checks a night governs.
 *
 * A check freezes what was expected of the bed at the moment it was answered,
 * which is what stops last week's findings moving when tonight's bookings do.
 * But the roster for a night is not final until the next morning — cancellations
 * and walk-ins arrive all day — so while a night is still open, correcting it
 * has to correct the rounds that were judged against it. Otherwise the eight
 * o'clock check is measured against a roster written after it, which is the
 * whole complaint this replaced.
 *
 * Once the night is confirmed nothing calls this for it again, so a settled
 * day stays settled.
 */
async function restampNight(db, night) {
  const next = addDays(night, 1);
  const affected = [
    { day: night, slot: 'evening' },
    { day: next, slot: 'morning' },
    { day: next, slot: 'housekeeping' },
  ];

  let updated = 0;
  for (const { day, slot } of affected) {
    const expected = await expectationsFor(db, day, slot);
    const checks = await db.prepare('SELECT id, bed_id, expected_state FROM hk_checks WHERE day = ? AND slot = ?')
      .bind(day, slot).all();

    const statements = (checks.results ?? [])
      .filter((c) => (c.expected_state ?? null) !== (expected.get(c.bed_id) ?? null))
      .map((c) => db.prepare('UPDATE hk_checks SET expected_state = ?2 WHERE id = ?1')
        .bind(c.id, expected.get(c.bed_id) ?? null));

    if (statements.length) {
      await db.batch(statements);
      updated += statements.length;
    }
  }
  return updated;
}

/**
 * The roster screen's data: last night, tonight, and where each came from.
 *
 * Both nights in one response because they are filled in together — the person
 * writing tonight's roster first says how last night actually ended, and asking
 * them to load two screens to do one job is how the confirming stops happening.
 */
export async function getRoster(ctx) {
  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'Africa/Accra';
  const today = todayIn(timezone);
  const day = readDay(ctx.url.searchParams.get('day'), today);
  const previousDay = addDays(day, -1);

  const [rooms, beds, tonight, lastNight] = await Promise.all([
    ctx.db.prepare('SELECT * FROM hk_rooms WHERE active = 1 ORDER BY sort_order, name').all(),
    ctx.db.prepare(
      `SELECT b.* FROM hk_beds b JOIN hk_rooms r ON r.id = b.room_id
        WHERE b.active = 1 AND r.active = 1 ORDER BY b.room_id, b.sort_order, b.label`,
    ).all(),
    rosterRowsOn(ctx.db, day),
    rosterRowsOn(ctx.db, previousDay),
  ]);

  const byRoom = new Map();
  for (const bed of beds.results ?? []) {
    if (!byRoom.has(bed.room_id)) byRoom.set(bed.room_id, []);
    const now = tonight.rows.get(bed.id) ?? null;
    const was = lastNight.rows.get(bed.id) ?? null;
    byRoom.get(bed.room_id).push({
      bedId: bed.id,
      label: bed.label,
      tonight: now?.expected_state ?? null,
      tonightNote: now?.expected_note ?? null,
      lastNight: was?.expected_state ?? null,
      lastNightNote: was?.expected_note ?? null,
    });
  }

  const confirmedRow = [...lastNight.rows.values()].find((r) => r.confirmed_at);

  return json({
    day,
    previousDay,
    today,
    // A night nobody wrote a roster for is governed by the last one that was
    // written, and the screen says so rather than looking mysteriously full.
    tonightFrom: tonight.carried ? tonight.day : null,
    lastNightFrom: lastNight.carried ? lastNight.day : null,
    lastNightConfirmed: confirmedRow
      ? { at: confirmedRow.confirmed_at, by: confirmedRow.confirmed_by }
      : null,
    rooms: (rooms.results ?? []).map((room) => ({
      roomId: room.id,
      name: room.name,
      block: room.block ?? null,
      beds: byRoom.get(room.id) ?? [],
    })),
  });
}

/**
 * Write a night's roster.
 *
 * Kept as a bulk save because it is filled in the way it is read — a whole room
 * at a time, off a booking sheet — and because a roster half-applied is a
 * roster that invents surprises where there are none.
 *
 * `confirm` closes the night: this is what last night actually came to. After
 * that the night is settled, and only somebody who can set the property up can
 * reopen it, because everything judged against it has already been reported.
 */
export async function saveRoster(ctx) {
  const body = await readJson(ctx.request);
  const entries = Array.isArray(body.beds) ? body.beds : [];
  if (!entries.length) throw badRequest('Nothing to save.');
  if (entries.length > 500) throw badRequest('That is more than 500 beds in one save.');

  const timezone = (await ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'")
    .first())?.value || 'Africa/Accra';
  const day = readDay(body.day, todayIn(timezone));
  const confirm = body.confirm === true;

  const settled = await ctx.db.prepare(
    'SELECT confirmed_at, confirmed_by FROM hk_roster WHERE day = ? AND confirmed_at IS NOT NULL LIMIT 1',
  ).bind(day).first();
  if (settled && !ctx.session.permissions.includes('hk_setup')) {
    throw badRequest(
      `That night was confirmed by ${settled.confirmed_by || 'somebody'} and cannot be changed. `
      + 'A housekeeping manager can reopen it.',
    );
  }

  const who = ctx.session.user.name;
  const statements = entries.map((entry) => {
    const bedId = Number(entry.bedId);
    if (!Number.isFinite(bedId) || bedId <= 0) throw badRequest('A bed was not recognised.');

    // Three states, and the third one matters: a bed nobody is tracking raises
    // no expectation, which is different from a bed expected to be empty.
    const expected = readExpected(entry.expected);
    const note = str(entry.note, 'Note', { max: 120, fallback: '' }) || null;

    return ctx.db.prepare(
      `INSERT INTO hk_roster (day, bed_id, expected_state, expected_note, set_by, updated_at, confirmed_at, confirmed_by)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6, ?7)
       ON CONFLICT(day, bed_id) DO UPDATE SET
         expected_state = ?3,
         expected_note  = ?4,
         set_by         = ?5,
         updated_at     = datetime('now'),
         confirmed_at   = COALESCE(?6, hk_roster.confirmed_at),
         confirmed_by   = COALESCE(?7, hk_roster.confirmed_by)`,
    ).bind(
      day, bedId, expected, note, who,
      confirm ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      confirm ? who : null,
    );
  });

  try {
    await ctx.db.batch(statements);
  } catch (err) {
    rethrowConstraint(err, { foreignKey: 'One of those beds is no longer on the list.' });
    throw err;
  }

  // The rounds judged against this night are brought back into line with it.
  // While the night is open this is what lets a correction reach the check that
  // was recorded before it; on confirmation it is the last time it happens.
  const restamped = await restampNight(ctx.db, day);

  await audit(ctx, confirm ? 'hk.roster.confirm' : 'hk.roster.save', day, {
    beds: entries.length, restamped,
  });
  return json({
    ok: true, day, saved: entries.length, confirmed: confirm, restamped,
  });
}

/**
 * Reopen a night that was confirmed too early.
 *
 * Rare, and deliberately not on the roster screen's main path — but a manager
 * who confirms at nine and hears about a late checkout at ten needs a way back
 * that is not editing the database.
 */
export async function reopenRoster(ctx, day) {
  if (!isDay(day)) throw badRequest('That date is not valid.');
  const result = await ctx.db.prepare(
    'UPDATE hk_roster SET confirmed_at = NULL, confirmed_by = NULL WHERE day = ?',
  ).bind(day).run();

  await audit(ctx, 'hk.roster.reopen', day, null);
  return json({ ok: true, day, beds: result.meta?.changes ?? 0 });
}
