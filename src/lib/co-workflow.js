/**
 * Workflow automation: routing, approvals, escalation and the daily sweep.
 *
 * A workflow is a list of steps held in the database, not in code. Each step
 * says who it goes to, what is being asked of them, how long they have, and who
 * hears about it if that time runs out. Registering a letter in a category with
 * a workflow attached starts it; completing the last step finishes it.
 *
 * The rules, in one place, because every awkward question about this system is
 * really a question about one of them:
 *
 *   A step opens exactly one route.  Even when addressed to a whole department:
 *   the first person to acknowledge claims it, and their name goes on the work.
 *   Opening one route per person in Tax would mean five people each thinking
 *   the other four had it.
 *
 *   A step completes when its route completes.  Rejection is different: it
 *   stops the run where it stands and puts the letter back to the author, who
 *   is the only person who can do anything about it.
 *
 *   Escalation tells somebody; it never reassigns.  Moving late work to a
 *   partner's queue is how a partner ends up with forty items and the person
 *   who was late ends up with none.
 */

import { notify } from './notify.js';
import { effectivePermissions } from './permissions.js';
import {
  BLOCKING_ACTIONS, OVERSIGHT, addWorkingHours, coSettings, delegateFor,
  hoursUntil, isoStamp, nowStamp, recordEvent,
} from './correspondence.js';
import { activeRecipients, closeEnvelope, recordEnvelopeEvent } from './envelopes.js';

// ---------------------------------------------------------------------------
// Starting and advancing a run
// ---------------------------------------------------------------------------

/**
 * The workflow that should start on its own for a newly registered letter.
 *
 * The category is asked first because it is the more specific statement: "every
 * tax assessment goes through the tax review" beats "everything incoming goes
 * to the front desk", and a firm that has said both meant the first.
 */
export async function autoWorkflowFor(db, letter) {
  if (letter.category_id) {
    const byCategory = await db.prepare(
      'SELECT * FROM co_workflows WHERE active = 1 AND applies_category_id = ? ORDER BY id LIMIT 1',
    ).bind(letter.category_id).first();
    if (byCategory) return byCategory;
  }
  return db.prepare(
    `SELECT * FROM co_workflows
      WHERE active = 1 AND applies_type = ? AND applies_category_id IS NULL
      ORDER BY id LIMIT 1`,
  ).bind(letter.type).first();
}

/**
 * Begin a workflow against a letter.
 *
 * Returns the run, or null when the workflow has no steps — a workflow with
 * nothing in it is a naming mistake, not an instruction to do nothing forever,
 * and starting it would leave the letter marked "in progress" with nobody
 * holding it.
 */
export async function startWorkflow(db, env, letter, workflowId, actor) {
  const steps = await stepsOf(db, workflowId);
  if (!steps.length) return null;

  // A letter already travelling through a workflow does not start a second one.
  const running = await db.prepare(
    "SELECT id FROM co_workflow_runs WHERE letter_id = ? AND status = 'running' LIMIT 1",
  ).bind(letter.id).first();
  if (running) return null;

  const run = await db.prepare(
    `INSERT INTO co_workflow_runs (letter_id, workflow_id, step_seq, status)
     VALUES (?1, ?2, 0, 'running') RETURNING *`,
  ).bind(letter.id, workflowId).first();

  const workflow = await db.prepare('SELECT name FROM co_workflows WHERE id = ?')
    .bind(workflowId).first();

  await recordEvent(db, env, letter.id, {
    actor: actor?.name ?? 'system',
    actorUserId: actor?.id ?? null,
    action: 'workflow.started',
    detail: { workflow: workflow?.name ?? String(workflowId), steps: steps.length },
  });

  await openStep(db, env, letter, run, steps[0], actor);
  return run;
}

export async function stepsOf(db, workflowId) {
  const rows = await db.prepare(
    'SELECT * FROM co_workflow_steps WHERE workflow_id = ? ORDER BY seq ASC',
  ).bind(workflowId).all();
  return rows.results ?? [];
}

/** Open the route a step calls for, and tell whoever it lands on. */
async function openStep(db, env, letter, run, step, actor) {
  const settings = await coSettings(db);
  const dueAt = isoStamp(addWorkingHours(
    new Date(), step.sla_hours ?? settings.defaultDueHours, settings.workingDays,
  ));

  const toName = await addressLabel(db, step);

  const route = await db.prepare(
    `INSERT INTO co_routes
       (letter_id, seq, from_user_id, from_name, to_user_id, to_department_id,
        to_permission, to_name, action, instruction, due_at, status, run_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12)
     RETURNING *`,
  ).bind(
    letter.id,
    (await nextSeq(db, letter.id)),
    actor?.id ?? null,
    actor?.name ?? 'Workflow',
    step.to_user_id ?? null,
    step.to_department_id ?? null,
    step.to_permission ?? null,
    toName,
    step.action,
    step.instruction ?? null,
    dueAt,
    run.id,
  ).first();

  await db.prepare('UPDATE co_workflow_runs SET step_seq = ? WHERE id = ?')
    .bind(step.seq, run.id).run();

  await db.prepare(
    "UPDATE co_letters SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('registered','draft','in_progress')",
  ).bind(BLOCKING_ACTIONS.has(step.action) ? 'awaiting_approval' : 'in_progress', letter.id).run();

  await recordEvent(db, env, letter.id, {
    actor: actor?.name ?? 'system',
    actorUserId: actor?.id ?? null,
    action: 'route.opened',
    detail: { step: step.name, to: toName, action: step.action, dueAt },
  });

  await announceRoute(db, env, letter, route);
  return route;
}

export async function nextSeq(db, letterId) {
  const row = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM co_routes WHERE letter_id = ?')
    .bind(letterId).first();
  return Number(row?.n ?? 0) + 1;
}

/** "Ama Serwaa", "Tax", or "anyone who can approve" — what the route says. */
export async function addressLabel(db, target) {
  if (target.to_user_id) {
    const row = await db.prepare('SELECT name FROM users WHERE id = ?').bind(target.to_user_id).first();
    return row?.name ?? 'Someone';
  }
  if (target.to_department_id) {
    const row = await db.prepare('SELECT name FROM co_departments WHERE id = ?')
      .bind(target.to_department_id).first();
    return row?.name ?? 'A department';
  }
  if (target.to_permission) return 'Anyone who can approve';
  return 'Unassigned';
}

/**
 * A route was finished. Move the run on, or stop it.
 *
 * Called after every route completion — including routes created by hand, which
 * simply have no run and fall straight out of the first line.
 */
export async function advanceWorkflow(db, env, letter, route, actor) {
  if (!route.run_id) return null;

  const run = await db.prepare('SELECT * FROM co_workflow_runs WHERE id = ?').bind(route.run_id).first();
  if (!run || run.status !== 'running') return null;

  // A rejection ends the run where it stands. The letter goes back to whoever
  // wrote it, because they are the only person who can act on "no".
  if (route.decision === 'rejected') {
    await db.prepare(
      "UPDATE co_workflow_runs SET status = 'rejected', finished_at = datetime('now') WHERE id = ?",
    ).bind(run.id).run();
    await db.prepare(
      "UPDATE co_letters SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?",
    ).bind(letter.id).run();
    await recordEvent(db, env, letter.id, {
      actor: actor?.name ?? 'system',
      actorUserId: actor?.id ?? null,
      action: 'workflow.rejected',
      detail: { comment: route.comment ?? null },
    });
    await notify(db, {
      kind: 'co_rejected',
      level: 'high',
      title: `${letter.ref} was rejected`,
      body: `${actor?.name ?? 'Someone'} rejected “${letter.subject}”.`
        + (route.comment ? ` ${route.comment}` : ''),
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
      actor: actor?.name ?? null,
    });
    return { run, ended: 'rejected' };
  }

  const steps = await stepsOf(db, run.workflow_id);
  const index = steps.findIndex((s) => s.seq === run.step_seq);
  const next = index >= 0 ? steps[index + 1] : null;

  if (!next) {
    await db.prepare(
      "UPDATE co_workflow_runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?",
    ).bind(run.id).run();
    // An approved outgoing letter is ready to go out; anything else is simply
    // done being passed around.
    const status = letter.type === 'outgoing' ? 'approved' : 'closed';
    await db.prepare(
      `UPDATE co_letters SET status = ?, updated_at = datetime('now'),
         closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END
       WHERE id = ?`,
    ).bind(status, status, letter.id).run();
    await recordEvent(db, env, letter.id, {
      actor: actor?.name ?? 'system',
      actorUserId: actor?.id ?? null,
      action: 'workflow.completed',
      detail: { status },
    });
    await notify(db, {
      kind: 'co_workflow_done',
      title: `${letter.ref} has finished its workflow`,
      body: `“${letter.subject}” is now ${status === 'approved' ? 'approved and ready to send' : 'closed'}.`,
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
    });
    return { run, ended: 'completed' };
  }

  await openStep(db, env, letter, run, next, actor);
  return { run, ended: null, next: next.seq };
}

// ---------------------------------------------------------------------------
// Telling people
// ---------------------------------------------------------------------------

/** The bell entry — and the email — for a route somebody now holds. */
export async function announceRoute(db, env, letter, route) {
  const due = route.due_at ? ` Due ${route.due_at.slice(0, 16).replace('T', ' ')}.` : '';
  const what = {
    action: 'for action', review: 'for review', approve: 'for approval',
    sign: 'for signature', information: 'for information',
  }[route.action] ?? 'for action';

  await notify(db, {
    kind: 'co_route',
    level: route.action === 'information' ? 'info' : letterUrgency(letter),
    title: `${letter.ref} — ${what}`,
    body: `“${letter.subject}” is with ${route.to_name ?? 'you'} ${what}.${due}`,
    link: `#/co-letter?id=${letter.id}`,
    // Addressed by permission rather than person: the bell filters by what
    // somebody holds, and everyone who could act on this should see it. The
    // route itself, on the Mine screen, is what says whose it actually is.
    audience: route.action === 'information' ? null : 'co_route',
    actor: route.from_name ?? null,
  });
}

function letterUrgency(letter) {
  if (letter.priority === 'urgent') return 'high';
  if (letter.priority === 'high') return 'warn';
  return 'info';
}

/** Everyone active who holds a permission. Used by permission-addressed steps. */
export async function holdersOf(db, permission) {
  const rows = await db.prepare('SELECT * FROM users WHERE active = 1').all();
  return (rows.results ?? []).filter((u) => effectivePermissions(u).includes(permission));
}

/**
 * Who hears that something is late.
 *
 * In order of preference: whoever the step named, then the head of the
 * department the route was addressed to, then the head of the late person's own
 * department. If none of those exist the sweep still records the escalation and
 * addresses the notice to oversight, so a firm that has filled none of this in
 * still finds out.
 */
export async function escalationTarget(db, route) {
  if (route.run_id) {
    const step = await db.prepare(
      `SELECT s.escalate_to_user_id FROM co_workflow_steps s
         JOIN co_workflow_runs r ON r.workflow_id = s.workflow_id AND r.step_seq = s.seq
        WHERE r.id = ?`,
    ).bind(route.run_id).first().catch(() => null);
    if (step?.escalate_to_user_id) return step.escalate_to_user_id;
  }

  if (route.to_department_id) {
    const dept = await db.prepare('SELECT head_user_id FROM co_departments WHERE id = ?')
      .bind(route.to_department_id).first();
    if (dept?.head_user_id) return dept.head_user_id;
  }

  if (route.to_user_id) {
    const own = await db.prepare(
      `SELECT d.head_user_id FROM co_staff s
         JOIN co_departments d ON d.id = s.department_id
        WHERE s.user_id = ?`,
    ).bind(route.to_user_id).first().catch(() => null);
    if (own?.head_user_id && own.head_user_id !== route.to_user_id) return own.head_user_id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * The scheduled pass: remind, escalate, and roll recurring meetings forward.
 *
 * Everything it does is idempotent and stamped, so running it twice in an hour
 * — a cron that fires late, a person pressing the button — cannot send two
 * reminders for the same thing. That property is what makes it safe to run
 * often, and running it often is what makes the deadlines mean anything.
 */
export async function runSweep(db, env, now = new Date()) {
  const settings = await coSettings(db);
  if (!settings.sweepEnabled) return { skipped: true };

  const result = {
    reminded: 0,
    escalated: 0,
    tasksReminded: 0,
    meetingsReminded: 0,
    occurrencesCreated: 0,
    envelopesChased: 0,
    envelopesExpired: 0,
  };

  await remindRoutes(db, env, settings, now, result);
  await escalateRoutes(db, env, settings, now, result);
  await remindTasks(db, env, settings, now, result);
  await remindMeetings(db, env, settings, now, result);
  await rollRecurringMeetings(db, env, now, result);
  await chaseEnvelopes(db, env, now, result);
  await expireEnvelopes(db, env, now, result);

  return result;
}

/**
 * Chase whoever an envelope is currently waiting on.
 *
 * Chased per envelope rather than per recipient, and stamped on the envelope,
 * so a document with four signers produces one reminder round every few days
 * rather than four. Nobody is chased before their turn comes: a reminder about
 * something you cannot yet act on teaches people to ignore reminders.
 */
async function chaseEnvelopes(db, env, now, result) {
  const rows = await db.prepare(
    `SELECT e.*, l.subject
       FROM co_envelopes e JOIN co_letters l ON l.id = e.letter_id
      WHERE e.status = 'sent' AND e.reminder_days > 0
      LIMIT 100`,
  ).all().catch(() => ({ results: [] }));

  for (const envelope of rows.results ?? []) {
    const since = envelope.last_reminded_at ?? envelope.sent_at;
    const daysSince = since ? (now - new Date(since)) / 86_400_000 : 0;
    if (daysSince < envelope.reminder_days) continue;

    const recipients = await db.prepare(
      'SELECT * FROM co_envelope_recipients WHERE envelope_id = ? ORDER BY seq',
    ).bind(envelope.id).all();

    const waiting = activeRecipients(envelope, recipients.results ?? [])
      .filter((r) => r.role !== 'viewer' && r.status !== 'signed');
    if (!waiting.length) continue;

    await db.prepare('UPDATE co_envelopes SET last_reminded_at = ? WHERE id = ?')
      .bind(nowStamp(), envelope.id).run();
    await db.batch(waiting.map((r) => db.prepare(
      'UPDATE co_envelope_recipients SET reminded_at = ? WHERE id = ?',
    ).bind(nowStamp(), r.id)));

    await recordEnvelopeEvent(db, envelope.id, {
      actor: 'Reminders',
      action: 'envelope.reminded',
      detail: { to: waiting.map((r) => r.name), daysOutstanding: Math.round(daysSince) },
    });

    await notify(db, {
      kind: 'co_envelope_chase',
      level: 'warn',
      title: `${envelope.ref} is still unsigned`,
      body: `“${envelope.subject}” has been with ${waiting.map((r) => r.name).join(', ')} for `
        + `${Math.round(daysSince)} day${Math.round(daysSince) === 1 ? '' : 's'}.`,
      link: `#/co-letter?id=${envelope.letter_id}`,
      audience: 'co_register',
    });
    result.envelopesChased += 1;
  }
}

/**
 * Close envelopes whose links have run out.
 *
 * A link that never expires is a link somebody finds in an inbox in five years
 * and uses. Expiring one is not a failure to be hidden: the firm is told, so it
 * can send a fresh one to somebody who probably meant to sign it.
 */
async function expireEnvelopes(db, env, now, result) {
  const rows = await db.prepare(
    `SELECT e.*, l.subject FROM co_envelopes e JOIN co_letters l ON l.id = e.letter_id
      WHERE e.status = 'sent' AND e.expires_at IS NOT NULL AND e.expires_at < ?
      LIMIT 100`,
  ).bind(isoStamp(now)).all().catch(() => ({ results: [] }));

  for (const envelope of rows.results ?? []) {
    const letter = await db.prepare('SELECT * FROM co_letters WHERE id = ?')
      .bind(envelope.letter_id).first();
    if (!letter) continue;

    await closeEnvelope(db, env, envelope, letter, 'expired', 'The signing period ran out.');
    await recordEnvelopeEvent(db, envelope.id, {
      actor: 'Reminders',
      action: 'envelope.expired',
      detail: { expiresAt: envelope.expires_at },
    });

    await notify(db, {
      kind: 'co_envelope',
      level: 'warn',
      title: `${envelope.ref} expired unsigned`,
      body: `“${envelope.subject}” was not signed before its links ran out. Send a fresh one if it is still wanted.`,
      link: `#/co-letter?id=${envelope.letter_id}`,
      audience: 'co_register',
    });
    result.envelopesExpired += 1;
  }
}

async function remindRoutes(db, env, settings, now, result) {
  const rows = await db.prepare(
    `SELECT r.*, l.ref, l.subject, l.priority
       FROM co_routes r JOIN co_letters l ON l.id = r.letter_id
      WHERE r.status IN ('pending', 'acknowledged')
        AND r.due_at IS NOT NULL
        AND r.reminded_at IS NULL
        AND r.action != 'information'
      LIMIT 200`,
  ).all().catch(() => ({ results: [] }));

  for (const route of rows.results ?? []) {
    const left = hoursUntil(route.due_at, now);
    if (left == null || left > settings.reminderLead || left < 0) continue;

    await notify(db, {
      kind: 'co_due_soon',
      level: 'warn',
      title: `${route.ref} is due soon`,
      body: `“${route.subject}” is with ${route.to_name ?? 'someone'} and is due in `
        + `${Math.max(1, Math.round(left))} hour${Math.round(left) === 1 ? '' : 's'}.`,
      link: `#/co-letter?id=${route.letter_id}`,
      audience: 'co_route',
    });
    await db.prepare("UPDATE co_routes SET reminded_at = datetime('now') WHERE id = ?")
      .bind(route.id).run();
    result.reminded += 1;
  }
}

async function escalateRoutes(db, env, settings, now, result) {
  const rows = await db.prepare(
    `SELECT r.*, l.ref, l.subject
       FROM co_routes r JOIN co_letters l ON l.id = r.letter_id
      WHERE r.status IN ('pending', 'acknowledged')
        AND r.due_at IS NOT NULL
        AND r.escalated_at IS NULL
        AND r.action != 'information'
      LIMIT 200`,
  ).all().catch(() => ({ results: [] }));

  for (const route of rows.results ?? []) {
    const late = -(hoursUntil(route.due_at, now) ?? 0);
    if (late < settings.escalationGrace) continue;

    const target = await escalationTarget(db, route);
    // Somebody covering for an absent colleague hears about it too — they are
    // the person who can actually pick it up today.
    const delegate = await delegateFor(db, route.to_user_id, now);
    const targetName = target
      ? (await db.prepare('SELECT name FROM users WHERE id = ?').bind(target).first())?.name
      : null;

    await db.prepare(
      'UPDATE co_routes SET escalated_at = ?, escalated_to = ? WHERE id = ?',
    ).bind(nowStamp(), target ?? null, route.id).run();

    await recordEvent(db, env, route.letter_id, {
      actor: 'Deadline sweep',
      action: 'route.escalated',
      detail: {
        route: route.id,
        hoursLate: Math.round(late),
        to: targetName ?? 'oversight',
        delegate: delegate ?? null,
      },
    });

    await notify(db, {
      kind: 'co_escalation',
      level: 'high',
      title: `${route.ref} is ${Math.round(late / 24) >= 1 ? `${Math.round(late / 24)} day(s)` : `${Math.round(late)} hour(s)`} late`,
      body: `“${route.subject}” has been with ${route.to_name ?? 'someone'} since it was due.`
        + (targetName ? ` Escalated to ${targetName}.` : ' Nobody is set to escalate to.'),
      link: `#/co-letter?id=${route.letter_id}`,
      audience: targetName ? 'co_route' : OVERSIGHT,
    });
    result.escalated += 1;
  }
}

async function remindTasks(db, env, settings, now, result) {
  const rows = await db.prepare(
    `SELECT * FROM co_tasks
      WHERE status IN ('open', 'in_progress', 'blocked')
        AND due_at IS NOT NULL AND reminded_at IS NULL
      LIMIT 200`,
  ).all().catch(() => ({ results: [] }));

  for (const task of rows.results ?? []) {
    const left = hoursUntil(task.due_at, now);
    if (left == null || left > settings.reminderLead) continue;

    await notify(db, {
      kind: 'co_task_due',
      level: left < 0 ? 'high' : 'warn',
      title: left < 0 ? `Action point overdue: ${task.title}` : `Action point due: ${task.title}`,
      body: `${task.assignee_name ?? 'Unassigned'} — due ${String(task.due_at).slice(0, 16).replace('T', ' ')}.`,
      link: '#/co-tasks',
      audience: 'co_tasks',
    });
    await db.prepare("UPDATE co_tasks SET reminded_at = datetime('now') WHERE id = ?")
      .bind(task.id).run();
    result.tasksReminded += 1;
  }
}

async function remindMeetings(db, env, settings, now, result) {
  const rows = await db.prepare(
    `SELECT * FROM co_meetings
      WHERE status = 'scheduled' AND is_series = 0 AND reminded_at IS NULL
      LIMIT 200`,
  ).all().catch(() => ({ results: [] }));

  for (const meeting of rows.results ?? []) {
    const left = hoursUntil(meeting.starts_at, now);
    if (left == null || left > 24 || left < 0) continue;

    await notify(db, {
      kind: 'co_meeting',
      title: `Meeting tomorrow: ${meeting.title}`,
      body: `${String(meeting.starts_at).slice(0, 16).replace('T', ' ')}`
        + (meeting.location ? ` · ${meeting.location}` : ''),
      link: '#/co-meetings',
      audience: 'co_meetings',
    });
    await db.prepare("UPDATE co_meetings SET reminded_at = datetime('now') WHERE id = ?")
      .bind(meeting.id).run();
    result.meetingsReminded += 1;
  }
}

/**
 * Keep the next occurrence of every recurring meeting in the diary.
 *
 * One occurrence ahead rather than a year of them: a series whose time changes
 * would otherwise leave fifty wrong rows behind it, and a diary that only shows
 * what is actually next is the one people trust.
 */
async function rollRecurringMeetings(db, env, now, result) {
  const rows = await db.prepare(
    "SELECT * FROM co_meetings WHERE is_series = 1 AND status = 'scheduled' LIMIT 100",
  ).all().catch(() => ({ results: [] }));

  for (const series of rows.results ?? []) {
    if (series.recurrence_until && new Date(series.recurrence_until) < now) continue;

    const pending = await db.prepare(
      "SELECT id FROM co_meetings WHERE series_id = ? AND status = 'scheduled' AND starts_at > ? LIMIT 1",
    ).bind(series.id, isoStamp(now)).first();
    if (pending) continue;

    const last = await db.prepare(
      'SELECT starts_at FROM co_meetings WHERE series_id = ? ORDER BY starts_at DESC LIMIT 1',
    ).bind(series.id).first();

    const next = nextOccurrence(last?.starts_at ?? series.starts_at, series.recurrence, now);
    if (!next) continue;
    if (series.recurrence_until && next > new Date(series.recurrence_until)) continue;

    const created = await db.prepare(
      `INSERT INTO co_meetings
         (title, agenda, starts_at, duration_mins, location, organiser_user_id, organiser_name,
          case_id, recurrence, series_id, is_series, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'none', ?9, 0, 'scheduled')
       RETURNING id`,
    ).bind(
      series.title, series.agenda, isoStamp(next), series.duration_mins, series.location,
      series.organiser_user_id, series.organiser_name, series.case_id, series.id,
    ).first();

    // The standing invitation list travels with the series.
    await db.prepare(
      `INSERT INTO co_meeting_attendees (meeting_id, user_id, party_id, name, email, response)
       SELECT ?1, user_id, party_id, name, email, 'invited'
         FROM co_meeting_attendees WHERE meeting_id = ?2`,
    ).bind(created.id, series.id).run().catch(() => {});

    result.occurrencesCreated += 1;
  }
}

/** The next time a series falls due strictly after `now`. */
export function nextOccurrence(from, recurrence, now = new Date()) {
  const start = new Date(from);
  if (Number.isNaN(start.getTime()) || recurrence === 'none' || !recurrence) return null;

  const step = (date) => {
    const d = new Date(date.getTime());
    switch (recurrence) {
      case 'daily': d.setUTCDate(d.getUTCDate() + 1); break;
      case 'weekly': d.setUTCDate(d.getUTCDate() + 7); break;
      case 'fortnightly': d.setUTCDate(d.getUTCDate() + 14); break;
      case 'monthly': d.setUTCMonth(d.getUTCMonth() + 1); break;
      case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3); break;
      case 'yearly': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
      default: return null;
    }
    return d;
  };

  let cursor = start;
  // A series dormant for months should land on its next real slot, not on the
  // one after the last time anybody looked.
  for (let i = 0; i < 500; i++) {
    const advanced = step(cursor);
    if (!advanced) return null;
    cursor = advanced;
    if (cursor > now) return cursor;
  }
  return null;
}
