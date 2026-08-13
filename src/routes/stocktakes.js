import { badRequest, json, notFound, readJson, str } from '../lib/http.js';
import { addDays, isDay, todayIn } from '../util/dates.js';
import { openDueTasks } from '../lib/stocktakes.js';

/**
 * Scheduled stock counts: who counts the parts store, and how often.
 *
 * The schedule is the standing arrangement; a task is one occurrence of it.
 * Editing a schedule never rewrites tasks that have already been opened, so
 * "we used to count weekly" stays true in the history.
 */

async function timezone(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first();
  return row?.value || 'UTC';
}

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

/** Everything the schedule screen draws: the arrangements, and what is open. */
export async function list(ctx) {
  const today = todayIn(await timezone(ctx.db));

  // Opening the screen is as good a moment as any to notice something is due.
  await openDueTasks(ctx.db, ctx.env, today).catch(() => {});

  const [schedules, assignees, tasks, people] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_stocktake_schedules ORDER BY active DESC, next_due').all(),
    ctx.db.prepare(
      `SELECT a.schedule_id, a.user_id, u.name
         FROM mx_stocktake_assignees a JOIN users u ON u.id = a.user_id`,
    ).all(),
    ctx.db.prepare(
      `SELECT * FROM mx_stocktake_tasks
        ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, due_day DESC LIMIT 60`,
    ).all(),
    // Everybody active is offered: who counts the store is a rota decision,
    // not a permissions one.
    ctx.db.prepare('SELECT id, name, role, permissions FROM users WHERE active = 1 ORDER BY name').all(),
  ]);

  const bySchedule = new Map();
  for (const row of assignees.results ?? []) {
    if (!bySchedule.has(row.schedule_id)) bySchedule.set(row.schedule_id, []);
    bySchedule.get(row.schedule_id).push({ id: row.user_id, name: row.name });
  }

  return json({
    today,
    schedules: (schedules.results ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      everyDays: s.every_days,
      nextDue: s.next_due,
      lastDone: s.last_done,
      note: s.note,
      active: Number(s.active) === 1,
      overdue: Number(s.active) === 1 && s.next_due <= today,
      assignees: bySchedule.get(s.id) ?? [],
    })),
    tasks: (tasks.results ?? []).map((t) => ({
      id: t.id,
      scheduleId: t.schedule_id,
      name: t.name,
      dueDay: t.due_day,
      status: t.status,
      openedAt: t.opened_at,
      completedAt: t.completed_at,
      completedBy: t.completed_by,
      itemsCounted: t.items_counted,
    })),
    people: (people.results ?? []).map((u) => ({ id: u.id, name: u.name, role: u.role })),
  });
}

/** Open tasks addressed to whoever is asking — the strip on the stock screen. */
export async function myTasks(ctx) {
  const today = todayIn(await timezone(ctx.db));
  const rows = await ctx.db.prepare(
    `SELECT t.id, t.name, t.due_day, t.schedule_id
       FROM mx_stocktake_tasks t
       LEFT JOIN mx_stocktake_assignees a ON a.schedule_id = t.schedule_id
      WHERE t.status = 'open' AND (a.user_id = ?1 OR a.user_id IS NULL)
      GROUP BY t.id
      ORDER BY t.due_day`,
  ).bind(ctx.session.user.id ?? 0).all();

  return json({
    today,
    tasks: (rows.results ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      dueDay: t.due_day,
      overdue: t.due_day < today,
    })),
  });
}

function readEveryDays(value) {
  const days = Math.round(Number(value));
  if (!Number.isFinite(days) || days < 1) throw badRequest('How often must be at least one day.');
  if (days > 365) throw badRequest('How often cannot be more than a year.');
  return days;
}

async function setAssignees(db, scheduleId, ids) {
  await db.prepare('DELETE FROM mx_stocktake_assignees WHERE schedule_id = ?').bind(scheduleId).run();
  const wanted = [...new Set((ids ?? []).map(Number).filter(Number.isFinite))];
  if (!wanted.length) return 0;
  await db.batch(wanted.map((id) => db.prepare(
    'INSERT OR IGNORE INTO mx_stocktake_assignees (schedule_id, user_id) VALUES (?, ?)',
  ).bind(scheduleId, id)));
  return wanted.length;
}

export async function create(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 120 });
  const everyDays = readEveryDays(body.everyDays);

  const today = todayIn(await timezone(ctx.db));
  const first = body.nextDue ? str(body.nextDue, 'First count', { max: 10 }) : addDays(today, everyDays);
  if (!isDay(first)) throw badRequest('That first-count date is not valid.');

  const row = await ctx.db.prepare(
    `INSERT INTO mx_stocktake_schedules (name, every_days, next_due, note, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
  ).bind(name, everyDays, first, body.note ?? null, ctx.session.user.name).first();

  const assigned = await setAssignees(ctx.db, row.id, body.assignees);
  await audit(ctx, 'mx.stocktake.create', row.id, { name, everyDays, first, assigned });

  return json({ ok: true, id: row.id });
}

export async function update(ctx, id) {
  const body = await readJson(ctx.request);
  const existing = await ctx.db.prepare('SELECT * FROM mx_stocktake_schedules WHERE id = ?')
    .bind(Number(id)).first();
  if (!existing) throw notFound('That schedule no longer exists.');

  const name = body.name === undefined
    ? existing.name : str(body.name, 'Name', { required: true, max: 120 });
  const everyDays = body.everyDays === undefined
    ? existing.every_days : readEveryDays(body.everyDays);
  const next = body.nextDue === undefined ? existing.next_due : String(body.nextDue);
  if (!isDay(next)) throw badRequest('That next-count date is not valid.');
  const active = body.active === undefined ? existing.active : (body.active ? 1 : 0);

  await ctx.db.prepare(
    `UPDATE mx_stocktake_schedules
        SET name = ?1, every_days = ?2, next_due = ?3, note = ?4, active = ?5
      WHERE id = ?6`,
  ).bind(name, everyDays, next, body.note === undefined ? existing.note : (body.note || null), active, existing.id)
    .run();

  if (body.assignees !== undefined) await setAssignees(ctx.db, existing.id, body.assignees);
  await audit(ctx, 'mx.stocktake.update', existing.id, { name, everyDays, next, active });

  return json({ ok: true });
}

export async function remove(ctx, id) {
  const result = await ctx.db.prepare('DELETE FROM mx_stocktake_schedules WHERE id = ?')
    .bind(Number(id)).run();
  if (!result.meta?.changes) throw notFound('That schedule no longer exists.');
  await audit(ctx, 'mx.stocktake.delete', id, null);
  return json({ ok: true });
}

/**
 * Ask for a count now, without waiting for the schedule.
 *
 * Uses the same task and the same notifications as a due date arriving, so an
 * unplanned count looks exactly like a planned one to whoever has to do it.
 */
export async function runNow(ctx, id) {
  const schedule = await ctx.db.prepare('SELECT * FROM mx_stocktake_schedules WHERE id = ?')
    .bind(Number(id)).first();
  if (!schedule) throw notFound('That schedule no longer exists.');

  const today = todayIn(await timezone(ctx.db));
  await ctx.db.prepare('UPDATE mx_stocktake_schedules SET next_due = ?, active = 1 WHERE id = ?')
    .bind(today, schedule.id).run();

  const result = await openDueTasks(ctx.db, ctx.env, today);
  await audit(ctx, 'mx.stocktake.run_now', schedule.id, { opened: result.opened });

  // Nothing opened means today already has a task for this schedule. Say which
  // kind, because "already asked" and "already counted" call for different
  // next steps.
  let existing = null;
  if (!result.opened) {
    const row = await ctx.db.prepare(
      'SELECT status FROM mx_stocktake_tasks WHERE schedule_id = ? AND due_day = ?',
    ).bind(schedule.id, today).first();
    existing = row?.status ?? 'open';
  }

  return json({ ok: true, opened: result.opened, existing });
}

/** Give up on a task that is not going to happen. */
export async function cancelTask(ctx, id) {
  const result = await ctx.db.prepare(
    "UPDATE mx_stocktake_tasks SET status = 'cancelled', completed_at = datetime('now'), completed_by = ? WHERE id = ? AND status = 'open'",
  ).bind(ctx.session.user.name, Number(id)).run();
  if (!result.meta?.changes) throw notFound('That task is not open.');
  await audit(ctx, 'mx.stocktake.cancel_task', id, null);
  return json({ ok: true });
}

