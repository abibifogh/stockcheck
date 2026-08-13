import {
  badRequest, csvResponse, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import {
  dayReport, exportRows, loadDataset, overview as overviewReport, periodReport, roomDetail,
} from '../lib/housekeeping.js';
import { notifyRoundSubmitted } from '../lib/email.js';
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

/** Can this person see what the front desk expects of a bed? */
function seesRoster(ctx) {
  return ctx.session.permissions.includes('hk_reports')
    || ctx.session.permissions.includes('hk_setup');
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

  const report = dayReport(ds, day);
  const roster = seesRoster(ctx);

  return json({
    day,
    today,
    propertyName: ds.propertyName,
    submitted: report.submitted,
    round: report.round,
    totals: report.totals,
    canSeeRoster: roster,
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
    recent: [...ds.rounds].slice(-7).reverse().map((r) => ({
      day: r.day,
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
      `SELECT b.id, b.label, b.expected_state,
              CASE WHEN b.active = 1 AND r.active = 1 THEN 1 ELSE 0 END AS active
         FROM hk_beds b JOIN hk_rooms r ON r.id = b.room_id`,
    ).all(),
    ctx.db.prepare("SELECT value FROM settings WHERE key = 'timezone'").all(),
  ]);
  const bedById = new Map((bedRows.results ?? []).map((b) => [b.id, b]));

  const today = todayIn(settingRows.results?.[0]?.value || 'Africa/Accra');
  const day = readDay(body.day, today);

  if (day > today) throw badRequest('That date is in the future.');
  if (diffDays(day, today) > 60) {
    throw badRequest('That day is more than two months ago and can no longer be recorded.');
  }

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
      // The roster as it stands right now, frozen onto the check. Editing the
      // roster tomorrow must not change what today's round found.
      expected: bed.expected_state ?? null,
      note: str(entry.note, 'Note', { max: 300, fallback: '' }) || null,
    });
  }

  // The round is created on first save rather than by a "start round" button:
  // one less thing for somebody standing in a doorway to remember.
  await ctx.db.prepare(
    `INSERT INTO hk_rounds (day) VALUES (?1)
     ON CONFLICT(day) DO UPDATE SET updated_at = datetime('now')`,
  ).bind(day).run();

  const round = await ctx.db.prepare('SELECT * FROM hk_rounds WHERE day = ?').bind(day).first();

  try {
    await ctx.db.batch(clean.map((c) => ctx.db.prepare(
      `INSERT INTO hk_checks (round_id, day, bed_id, state, name_tag, expected_state, note, checked_by, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
       ON CONFLICT(round_id, bed_id) DO UPDATE SET
         state          = ?4,
         name_tag       = ?5,
         expected_state = ?6,
         note           = ?7,
         checked_by     = ?8,
         at             = datetime('now')`,
    ).bind(
      round.id, day, c.bedId, c.state, c.nameTag, c.expected, c.note, ctx.session.user.name,
    )));
  } catch (err) {
    rethrowConstraint(err, { foreignKey: 'One of those beds is no longer on the list.' });
    throw err;
  }

  await audit(ctx, 'hk.check', day, {
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
       FROM hk_checks WHERE day = ?`,
  ).bind(day).first();

  return json({
    ok: true,
    day,
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
export async function submitRound(ctx, day) {
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const ds = await loadDataset(ctx.db);
  const report = dayReport(ds, day);

  const round = ds.roundByDay.get(day);
  if (!round) throw badRequest('Nothing has been recorded for that day yet.');
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
        WHERE day = ?1`,
    ).bind(day, ctx.session.user.name, note),
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      `${ctx.session.user.name} (${ctx.session.user.role})`,
      resubmission ? 'hk.round.resubmit' : 'hk.round.submit',
      day,
      JSON.stringify({
        checked: report.totals.checked,
        expected: report.totals.expected,
        untagged: report.totals.untagged,
        unexpected: report.totals.unexpected,
      }),
    ),
  ]);

  // The email must never be able to hold up, or fail, somebody pressing Submit
  // in a corridor. Whether a mail provider is having a bad morning is not the
  // housekeeper's problem.
  const task = notifyRoundSubmitted(ctx.db, ctx.env, {
    day,
    submittedBy: ctx.session.user.name,
    resubmission,
  });
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
  else await task.catch(() => {});

  return json({
    ok: true,
    day,
    submitted: true,
    resubmission,
    totals: report.totals,
    findings: report.findings.length,
  });
}

export async function getDay(ctx) {
  const ds = await loadDataset(ctx.db);
  const day = readDay(ctx.url.searchParams.get('day'), todayIn(ds.timezone));
  return json(dayReport(ds, day));
}

export async function listRounds(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 30, 200);
  const rows = await ctx.db.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM hk_checks c WHERE c.round_id = r.id) AS checks,
            (SELECT COUNT(*) FROM hk_checks c WHERE c.round_id = r.id
               AND c.state = 'occupied' AND c.name_tag = 0) AS untagged
       FROM hk_rounds r
      ORDER BY r.day DESC
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

/**
 * Set what the front desk expects of each bed tonight.
 *
 * Kept as a bulk save because it is filled in the way it is read — a whole room
 * at a time, off a booking sheet — and because a roster half-applied is a
 * roster that invents surprises where there are none.
 */
export async function saveRoster(ctx) {
  const body = await readJson(ctx.request);
  const entries = Array.isArray(body.beds) ? body.beds : [];
  if (!entries.length) throw badRequest('Nothing to save.');
  if (entries.length > 500) throw badRequest('That is more than 500 beds in one save.');

  const statements = entries.map((entry) => {
    const bedId = Number(entry.bedId);
    if (!Number.isFinite(bedId) || bedId <= 0) throw badRequest('A bed was not recognised.');

    // Three states, and the third one matters: a bed nobody is tracking raises
    // no expectation, which is different from a bed expected to be empty.
    const expected = entry.expected === 'occupied' ? 'occupied'
      : entry.expected === 'free' ? 'free'
        : null;

    return ctx.db.prepare(
      'UPDATE hk_beds SET expected_state = ?2, expected_note = ?3 WHERE id = ?1',
    ).bind(bedId, expected, str(entry.note, 'Note', { max: 120, fallback: '' }) || null);
  });

  await ctx.db.batch(statements);
  await audit(ctx, 'hk.roster.save', null, { beds: entries.length });
  return json({ ok: true, saved: entries.length });
}
