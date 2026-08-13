import { addDays, diffDays } from '../util/dates.js';
import { announce, readSettings } from './notify.js';
import { isMissingTable } from './http.js';

/**
 * Scheduled stock counts.
 *
 * A schedule says "count the parts store every 30 days, and ask these people".
 * When the day arrives the system opens a task and tells them; when somebody
 * records a count, the task closes itself and the schedule rolls forward.
 *
 * The arithmetic here is deliberately pure and separate from the database, so
 * "when is this next due" can be tested without a Worker, a clock, or a cron.
 */

/**
 * The next due date after a schedule fires.
 *
 * Rolls forward from the date that was due rather than from today, so a count
 * done three days late does not push every future count three days later. But
 * a schedule left unattended for months catches up to the present instead of
 * firing a dozen missed counts at once — nobody counts the store twelve times
 * to make up for a quiet quarter.
 */
export function nextDue(due, everyDays, today) {
  // A period of zero or less is not a schedule; fall back to the monthly
  // default rather than to "every day", which would bury people in tasks.
  const asked = Math.round(Number(everyDays));
  const step = Number.isFinite(asked) && asked >= 1 ? asked : 30;
  let next = addDays(due, step);
  if (today && diffDays(today, next) < 0) {
    // Behind: jump forward in whole steps until it lands on or after today.
    const behind = diffDays(next, today);
    next = addDays(next, Math.ceil(behind / step) * step);
  }
  return next;
}

/** Which active schedules have come round on or before `today`. */
export function dueSchedules(schedules, today) {
  return (schedules ?? []).filter((s) => (
    (s.active == null || Number(s.active) === 1) && s.next_due && s.next_due <= today
  ));
}

/**
 * Open a task for every schedule that has come round, and tell the people
 * asked to do it.
 *
 * Safe to call as often as you like: the task table has a unique key on
 * (schedule, due day), so a cron firing twice or an admin opening the screen
 * cannot produce two tasks or two rounds of email for the same count.
 */
export async function openDueTasks(db, env, today) {
  try {
    const settings = await readSettings(db);
    const rows = await db.prepare('SELECT * FROM mx_stocktake_schedules WHERE active = 1').all();
    const due = dueSchedules(rows.results ?? [], today);
    if (!due.length) return { opened: 0, tasks: [] };

    const opened = [];
    for (const schedule of due) {
      const created = await db.prepare(
        `INSERT INTO mx_stocktake_tasks (schedule_id, name, due_day)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (schedule_id, due_day) DO NOTHING
         RETURNING id`,
      ).bind(schedule.id, schedule.name, schedule.next_due).first();

      // Roll the schedule forward whether or not the task was new, so a
      // schedule can never get stuck firing the same day forever.
      await db.prepare('UPDATE mx_stocktake_schedules SET next_due = ? WHERE id = ?')
        .bind(nextDue(schedule.next_due, schedule.every_days, today), schedule.id)
        .run();

      if (!created?.id) continue;
      opened.push({ id: created.id, name: schedule.name, dueDay: schedule.next_due });

      if (settings.notify_stocktake_due === '0') continue;
      await tellAssignees(db, env, schedule, schedule.next_due);
    }

    return { opened: opened.length, tasks: opened };
  } catch (err) {
    if (isMissingTable(err)) return { opened: 0, tasks: [], pendingMigration: true };
    throw err;
  }
}

/**
 * Notify the named people, and everyone who runs the store.
 *
 * The named people get it because they were asked; the store's managers get it
 * because a count nobody does is their problem, not the system's.
 */
async function tellAssignees(db, env, schedule, dueDay) {
  const title = `Stock count due today: ${schedule.name}`;
  const body = `${schedule.name} is due on ${dueDay}.`
    + (schedule.note ? `\n\n${schedule.note}` : '')
    + '\n\nOpen Maintenance → Stock, enter what is on the shelf, and submit. '
    + 'An administrator accepts the figures afterwards.';

  const people = await db.prepare(
    `SELECT u.id, u.name FROM mx_stocktake_assignees a
       JOIN users u ON u.id = a.user_id
      WHERE a.schedule_id = ? AND u.active = 1`,
  ).bind(schedule.id).all();

  for (const person of people.results ?? []) {
    await db.prepare(
      `INSERT INTO notifications (kind, title, body, link, user_id)
       VALUES ('stocktake_due', ?1, ?2, '#/mx-stock', ?3)`,
    ).bind(title, body, person.id).run().catch(() => {});
  }

  const asked = people.results ?? [];
  await announce(db, env, {
    kind: 'stocktake_due',
    audience: 'mx_stock',
    // Named people are emailed whether or not they hold the stock permission —
    // being asked to count is the reason they need to know, not their access.
    alsoUserIds: asked.map((p) => p.id),
    title,
    body: asked.length ? `${body}\n\nAsked to count: ${asked.map((p) => p.name).join(', ')}.` : body,
    link: '#/mx-stock',
    linkLabel: 'Open the parts store',
  }).catch(() => {});
}

/**
 * Close any open task that a count on this day satisfies.
 *
 * Counting is the point of the task, so recording one is what completes it —
 * there is no separate "mark as done" for somebody to forget.
 */
export async function closeDueTasks(db, day, who, itemsCounted) {
  try {
    const rows = await db.prepare(
      "SELECT id, schedule_id FROM mx_stocktake_tasks WHERE status = 'open' AND due_day <= ?",
    ).bind(day).all();
    const tasks = rows.results ?? [];
    if (!tasks.length) return 0;

    for (const task of tasks) {
      await db.prepare(
        `UPDATE mx_stocktake_tasks
            SET status = 'done', completed_at = datetime('now'),
                completed_by = ?1, items_counted = ?2
          WHERE id = ?3`,
      ).bind(who ?? null, Number(itemsCounted) || 0, task.id).run();

      if (task.schedule_id) {
        await db.prepare('UPDATE mx_stocktake_schedules SET last_done = ? WHERE id = ?')
          .bind(day, task.schedule_id).run();
      }
    }
    return tasks.length;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
}
