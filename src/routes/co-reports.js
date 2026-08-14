/**
 * Dashboards and reporting.
 *
 * The numbers a practice is actually asked for: how much came in, how much went
 * out, how long it took, what is late, and who is carrying it. Every figure is
 * computed in SQL from the register rather than kept in a running total, so
 * there is nothing to get out of step and nothing to rebuild.
 *
 * One rule runs through all of it: turnaround is measured from registration to
 * close, and a letter still open has no turnaround. Averaging in the ones that
 * have not finished would make a backlog look like fast work.
 */

import { csvResponse, json } from '../lib/http.js';
import { OVERSIGHT, nowStamp, visibilityClause } from '../lib/correspondence.js';

/**
 * The dashboard.
 *
 * Confidentiality applies to every count on this page: a manager who cannot see
 * a restricted letter should not be able to infer it from a total that jumped.
 */
export async function overview(ctx) {
  const { db, session } = ctx;
  const visible = visibilityClause(session);
  const now = nowStamp();
  const weekAhead = new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const scoped = (clause) => `
    SELECT COUNT(*) AS n FROM co_letters l
     WHERE ${visible.sql} AND l.archived = 0 AND ${clause}`;

  const [
    byStatus, byType, overdue, dueSoon, openRoutes, unclaimed,
    turnaround, monthly, byDepartment, tasks, upcoming, deadlines,
  ] = await Promise.all([
    db.prepare(`SELECT l.status, COUNT(*) AS n FROM co_letters l
                 WHERE ${visible.sql} AND l.archived = 0 GROUP BY l.status`).bind(...visible.binds).all(),

    db.prepare(`SELECT l.type, COUNT(*) AS n,
                       SUM(CASE WHEN l.status NOT IN ('closed','cancelled') THEN 1 ELSE 0 END) AS open
                  FROM co_letters l WHERE ${visible.sql} AND l.archived = 0 GROUP BY l.type`)
      .bind(...visible.binds).all(),

    db.prepare(scoped("l.due_at IS NOT NULL AND l.due_at < ? AND l.status NOT IN ('closed','cancelled')"))
      .bind(...visible.binds, now).first(),

    db.prepare(scoped("l.due_at IS NOT NULL AND l.due_at BETWEEN ? AND ? AND l.status NOT IN ('closed','cancelled')"))
      .bind(...visible.binds, now, weekAhead).first(),

    db.prepare(`SELECT COUNT(*) AS n FROM co_routes r JOIN co_letters l ON l.id = r.letter_id
                 WHERE ${visible.sql} AND r.status IN ('pending','acknowledged')`)
      .bind(...visible.binds).first(),

    db.prepare(`SELECT COUNT(*) AS n FROM co_routes r JOIN co_letters l ON l.id = r.letter_id
                 WHERE ${visible.sql} AND r.status = 'pending' AND r.to_user_id IS NULL`)
      .bind(...visible.binds).first(),

    // Turnaround in days, over the letters that actually finished.
    db.prepare(`SELECT
                  COUNT(*) AS closed,
                  AVG(julianday(l.closed_at) - julianday(l.created_at)) AS avg_days,
                  MAX(julianday(l.closed_at) - julianday(l.created_at)) AS worst_days
                 FROM co_letters l
                WHERE ${visible.sql} AND l.closed_at IS NOT NULL AND l.status = 'closed'`)
      .bind(...visible.binds).first(),

    db.prepare(`SELECT strftime('%Y-%m', l.created_at) AS month, l.type, COUNT(*) AS n
                  FROM co_letters l
                 WHERE ${visible.sql} AND l.created_at >= date('now', '-12 months')
                 GROUP BY month, l.type ORDER BY month`).bind(...visible.binds).all(),

    db.prepare(`SELECT d.id, d.name,
                       COUNT(r.id) AS open_routes,
                       SUM(CASE WHEN r.due_at < ? THEN 1 ELSE 0 END) AS overdue
                  FROM co_departments d
                  LEFT JOIN co_routes r ON r.to_department_id = d.id AND r.status IN ('pending','acknowledged')
                 WHERE d.active = 1
                 GROUP BY d.id, d.name ORDER BY d.sort_order`).bind(now).all(),

    db.prepare(`SELECT status, COUNT(*) AS n FROM co_tasks GROUP BY status`).all(),

    db.prepare(`SELECT id, title, starts_at, location FROM co_meetings
                 WHERE is_series = 0 AND status = 'scheduled' AND starts_at >= ?
                 ORDER BY starts_at LIMIT 5`).bind(now).all(),

    db.prepare(`SELECT c.id, c.ref, c.title, c.statutory_due, c.status, p.name AS party_name,
                       julianday(c.statutory_due) - julianday('now') AS days_left
                  FROM co_cases c LEFT JOIN co_parties p ON p.id = c.party_id
                 WHERE c.statutory_due IS NOT NULL AND c.status NOT IN ('completed','archived')
                 ORDER BY c.statutory_due LIMIT 12`).all(),
  ]);

  const taskCounts = Object.fromEntries((tasks.results ?? []).map((r) => [r.status, r.n]));
  const openTasks = (taskCounts.open ?? 0) + (taskCounts.in_progress ?? 0) + (taskCounts.blocked ?? 0);
  const doneTasks = taskCounts.done ?? 0;

  return json({
    statuses: Object.fromEntries((byStatus.results ?? []).map((r) => [r.status, r.n])),
    types: byType.results ?? [],
    overdue: overdue?.n ?? 0,
    dueSoon: dueSoon?.n ?? 0,
    openRoutes: openRoutes?.n ?? 0,
    unclaimed: unclaimed?.n ?? 0,
    turnaround: {
      closed: turnaround?.closed ?? 0,
      averageDays: turnaround?.avg_days == null ? null : Number(turnaround.avg_days.toFixed(1)),
      worstDays: turnaround?.worst_days == null ? null : Number(turnaround.worst_days.toFixed(1)),
    },
    monthly: monthly.results ?? [],
    departments: byDepartment.results ?? [],
    actionPoints: {
      open: openTasks,
      done: doneTasks,
      // The one number a partner asks for: of everything raised, how much is
      // finished. Cancelled points are excluded from both halves — they were
      // never work, and counting them as done flatters the figure.
      progress: openTasks + doneTasks ? Math.round((doneTasks / (openTasks + doneTasks)) * 100) : null,
      byStatus: taskCounts,
    },
    upcomingMeetings: upcoming.results ?? [],
    deadlines: deadlines.results ?? [],
  });
}

/**
 * Who is carrying what, and how quickly they turn it round.
 *
 * Deliberately narrow about what it claims. "Average hours to complete" is the
 * time from a route being opened to it being completed — not a measure of
 * effort, and not comparable between somebody reviewing engagement letters and
 * somebody answering Revenue queries. It is here because a partner asking "is
 * anything stuck with anyone" needs a place to look, not because it is a
 * performance score.
 */
export async function productivity(ctx) {
  const { db, url } = ctx;
  const from = url.searchParams.get('from') || '1900-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';

  const rows = await db.prepare(
    `SELECT u.id, u.name, u.role, d.name AS department,
            (SELECT COUNT(*) FROM co_letters l
              WHERE l.created_by = u.id AND date(l.created_at) BETWEEN ?1 AND ?2) AS registered,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_user_id = u.id AND date(r.created_at) BETWEEN ?1 AND ?2) AS received,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_user_id = u.id AND r.status = 'completed'
                AND date(r.completed_at) BETWEEN ?1 AND ?2) AS completed,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_user_id = u.id AND r.status IN ('pending','acknowledged')) AS open_now,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_user_id = u.id AND r.status IN ('pending','acknowledged')
                AND r.due_at < datetime('now')) AS overdue_now,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_user_id = u.id AND r.escalated_at IS NOT NULL
                AND date(r.escalated_at) BETWEEN ?1 AND ?2) AS escalated,
            (SELECT AVG((julianday(r.completed_at) - julianday(r.created_at)) * 24)
               FROM co_routes r
              WHERE r.to_user_id = u.id AND r.status = 'completed'
                AND date(r.completed_at) BETWEEN ?1 AND ?2) AS avg_hours,
            (SELECT COUNT(*) FROM co_tasks t
              WHERE t.assignee_user_id = u.id AND t.status = 'done'
                AND date(t.completed_at) BETWEEN ?1 AND ?2) AS tasks_done,
            (SELECT COUNT(*) FROM co_tasks t
              WHERE t.assignee_user_id = u.id AND t.status IN ('open','in_progress','blocked')) AS tasks_open,
            (SELECT COALESCE(SUM(t.hours), 0) FROM co_tasks t
              WHERE t.assignee_user_id = u.id AND date(t.completed_at) BETWEEN ?1 AND ?2) AS hours
       FROM users u
       LEFT JOIN co_staff s ON s.user_id = u.id
       LEFT JOIN co_departments d ON d.id = s.department_id
      WHERE u.active = 1
      ORDER BY u.name`,
  ).bind(from, to).all();

  const people = (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    department: r.department,
    registered: r.registered,
    received: r.received,
    completed: r.completed,
    openNow: r.open_now,
    overdueNow: r.overdue_now,
    escalated: r.escalated,
    averageHours: r.avg_hours == null ? null : Number(Number(r.avg_hours).toFixed(1)),
    tasksDone: r.tasks_done,
    tasksOpen: r.tasks_open,
    hours: Number(r.hours ?? 0),
    // Completed against received in the same window. Above 100% means they
    // cleared a backlog; below means one is building. It is a direction, not
    // a grade, and the screen says so.
    clearance: r.received ? Math.round((r.completed / r.received) * 100) : null,
  }));

  return json({ from, to, people });
}

/** The same numbers by department, which is how a practice is actually run. */
export async function byDepartment(ctx) {
  const { db, url } = ctx;
  const from = url.searchParams.get('from') || '1900-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';

  const rows = await db.prepare(
    `SELECT d.id, d.name, u.name AS head,
            (SELECT COUNT(*) FROM co_letters l
              WHERE l.department_id = d.id AND date(l.created_at) BETWEEN ?1 AND ?2) AS letters,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_department_id = d.id AND date(r.created_at) BETWEEN ?1 AND ?2) AS routed,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_department_id = d.id AND r.status IN ('pending','acknowledged')) AS open_now,
            (SELECT COUNT(*) FROM co_routes r
              WHERE r.to_department_id = d.id AND r.status IN ('pending','acknowledged')
                AND r.due_at < datetime('now')) AS overdue_now,
            (SELECT AVG((julianday(r.completed_at) - julianday(r.created_at)) * 24)
               FROM co_routes r
              WHERE r.to_department_id = d.id AND r.status = 'completed'
                AND date(r.completed_at) BETWEEN ?1 AND ?2) AS avg_hours
       FROM co_departments d
       LEFT JOIN users u ON u.id = d.head_user_id
      WHERE d.active = 1 ORDER BY d.sort_order, d.name`,
  ).bind(from, to).all();

  return json({
    from,
    to,
    departments: (rows.results ?? []).map((r) => ({
      ...r,
      avg_hours: r.avg_hours == null ? null : Number(Number(r.avg_hours).toFixed(1)),
    })),
  });
}

/**
 * How the register moved over a period: volume, closure, and where it went.
 *
 * The client breakdown is the one partners reach for — a client generating
 * forty letters a quarter is either a large engagement or a problem, and the
 * two look different next to the fee.
 */
export async function activity(ctx) {
  const { db, url, session } = ctx;
  const visible = visibilityClause(session);
  const from = url.searchParams.get('from') || '1900-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';
  const binds = [...visible.binds, from, to];

  const [byCategory, byParty, byChannel, closure] = await Promise.all([
    db.prepare(`SELECT COALESCE(cat.name, 'Uncategorised') AS name, COUNT(*) AS n
                  FROM co_letters l LEFT JOIN co_categories cat ON cat.id = l.category_id
                 WHERE ${visible.sql} AND date(l.created_at) BETWEEN ? AND ?
                 GROUP BY name ORDER BY n DESC`).bind(...binds).all(),

    db.prepare(`SELECT p.id, p.name, COUNT(*) AS n,
                       SUM(CASE WHEN l.type = 'incoming' THEN 1 ELSE 0 END) AS incoming,
                       SUM(CASE WHEN l.type = 'outgoing' THEN 1 ELSE 0 END) AS outgoing
                  FROM co_letters l JOIN co_parties p ON p.id = l.party_id
                 WHERE ${visible.sql} AND date(l.created_at) BETWEEN ? AND ?
                 GROUP BY p.id, p.name ORDER BY n DESC LIMIT 25`).bind(...binds).all(),

    db.prepare(`SELECT COALESCE(l.channel, 'not recorded') AS channel, COUNT(*) AS n
                  FROM co_letters l
                 WHERE ${visible.sql} AND date(l.created_at) BETWEEN ? AND ?
                 GROUP BY channel ORDER BY n DESC`).bind(...binds).all(),

    db.prepare(`SELECT COUNT(*) AS registered,
                       SUM(CASE WHEN l.status = 'closed' THEN 1 ELSE 0 END) AS closed,
                       SUM(CASE WHEN l.status NOT IN ('closed','cancelled')
                                 AND l.due_at < datetime('now') THEN 1 ELSE 0 END) AS overdue,
                       AVG(CASE WHEN l.closed_at IS NOT NULL
                                THEN julianday(l.closed_at) - julianday(l.created_at) END) AS avg_days
                  FROM co_letters l
                 WHERE ${visible.sql} AND date(l.created_at) BETWEEN ? AND ?`).bind(...binds).first(),
  ]);

  return json({
    from,
    to,
    summary: {
      registered: closure?.registered ?? 0,
      closed: closure?.closed ?? 0,
      overdue: closure?.overdue ?? 0,
      averageDays: closure?.avg_days == null ? null : Number(closure.avg_days.toFixed(1)),
      closureRate: closure?.registered
        ? Math.round((closure.closed / closure.registered) * 100) : null,
    },
    categories: byCategory.results ?? [],
    parties: byParty.results ?? [],
    channels: byChannel.results ?? [],
  });
}

/**
 * Files past their retention period.
 *
 * Nothing is deleted automatically. A retention policy says how long something
 * must be kept, not how quickly it must be destroyed, and a system that quietly
 * removed audit files on their seventh birthday would eventually remove one
 * somebody needed. This lists them; a person decides.
 */
export async function retention(ctx) {
  const { db, session } = ctx;
  if (!session.permissions.includes(OVERSIGHT) && !session.permissions.includes('co_setup')) {
    return json({ letters: [], note: 'Retention review is for partners and practice administrators.' });
  }

  const rows = await db.prepare(
    `SELECT l.id, l.ref, l.subject, l.created_at, l.status, l.archived,
            cat.name AS category, cat.retention_years,
            CAST(julianday('now') - julianday(l.created_at) AS INTEGER) / 365 AS years_held
       FROM co_letters l
       JOIN co_categories cat ON cat.id = l.category_id
      WHERE julianday('now') - julianday(l.created_at) > cat.retention_years * 365
      ORDER BY l.created_at LIMIT 500`,
  ).all();

  return json({ letters: rows.results ?? [] });
}

/** The whole audit trail across the register, for an inspection visit. */
export async function exportTrail(ctx) {
  const { db, url, session } = ctx;
  const visible = visibilityClause(session);
  const from = url.searchParams.get('from') || '1900-01-01';
  const to = url.searchParams.get('to') || '2999-12-31';

  const rows = await db.prepare(
    `SELECT l.ref, e.at, e.actor, e.action, e.detail, e.hash
       FROM co_events e JOIN co_letters l ON l.id = e.letter_id
      WHERE ${visible.sql} AND date(e.at) BETWEEN ? AND ?
      ORDER BY e.id LIMIT 20000`,
  ).bind(...visible.binds, from, to).all();

  const header = ['Reference', 'When', 'Who', 'What', 'Detail', 'Entry hash'];
  const body = (rows.results ?? []).map((r) => [r.ref, r.at, r.actor, r.action, r.detail, r.hash]);

  return csvResponse(`audit-trail-${from}-to-${to}.csv`, [header, ...body]);
}
