/**
 * The work the correspondence is about: clients, engagements, action points
 * and meetings.
 *
 * A letter on its own is a piece of paper. What makes it worth filing is that
 * it belongs to the 2026 audit of Kwame Foods, that it produced three things
 * somebody has to do, and that two of them were agreed in Tuesday's partners'
 * meeting. These four tables are that context.
 */

import { badRequest, bool, csvResponse, forbidden, int, json, notFound, num, readJson, str } from '../lib/http.js';
import {
  CASE_STATUSES, ENGAGEMENT_TYPES, OVERSIGHT, PRIORITIES, RECURRENCES,
  TASK_STATUSES, isoStamp, nextRef, nowStamp, visibilityClause,
} from '../lib/correspondence.js';
import { nextOccurrence } from '../lib/co-workflow.js';
import { notify } from '../lib/notify.js';

// ---------------------------------------------------------------------------
// Clients and other parties
// ---------------------------------------------------------------------------

const PARTY_KINDS = ['client', 'authority', 'bank', 'auditor', 'supplier', 'other'];

export async function listParties(ctx) {
  const { db, url } = ctx;
  const where = [];
  const binds = [];

  if (url.searchParams.get('all') !== '1') where.push('active = 1');
  const kind = url.searchParams.get('kind');
  if (kind && PARTY_KINDS.includes(kind)) { where.push('kind = ?'); binds.push(kind); }
  const q = str(url.searchParams.get('q'), 'Search', { max: 120 });
  if (q) {
    where.push('(name LIKE ? OR client_code LIKE ? OR tin LIKE ? OR email LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = await db.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM co_cases c WHERE c.party_id = p.id AND c.status NOT IN ('archived','completed')) AS open_cases,
            (SELECT COUNT(*) FROM co_letters l WHERE l.party_id = p.id AND l.archived = 0) AS letters
       FROM co_parties p
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.name LIMIT 1000`,
  ).bind(...binds).all();

  return json({ parties: rows.results ?? [] });
}

export async function createParty(ctx) {
  const body = await readJson(ctx.request);
  const kind = str(body.kind, 'Kind', { max: 20, fallback: 'client' });
  if (!PARTY_KINDS.includes(kind)) throw badRequest('That is not a kind of party');

  const row = await ctx.db.prepare(
    `INSERT INTO co_parties (name, kind, client_code, tin, contact_name, email, phone, address, sector, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING *`,
  ).bind(
    str(body.name, 'Name', { required: true, max: 200 }),
    kind,
    str(body.clientCode, 'Client code', { max: 40 }),
    str(body.tin, 'TIN', { max: 40 }),
    str(body.contactName, 'Contact', { max: 200 }),
    str(body.email, 'Email', { max: 200 }),
    str(body.phone, 'Phone', { max: 60 }),
    str(body.address, 'Address', { max: 1000 }),
    str(body.sector, 'Sector', { max: 120 }),
    str(body.note, 'Note', { max: 2000 }),
  ).first().catch((err) => {
    if (/UNIQUE/i.test(String(err))) throw badRequest('There is already a party with that name');
    throw err;
  });

  return json({ ok: true, party: row }, { status: 201 });
}

export async function updateParty(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    binds.push(value);
  };

  if (body.name !== undefined) set('name', str(body.name, 'Name', { required: true, max: 200 }));
  if (body.kind !== undefined) {
    const kind = str(body.kind, 'Kind', { required: true, max: 20 });
    if (!PARTY_KINDS.includes(kind)) throw badRequest('That is not a kind of party');
    set('kind', kind);
  }
  if (body.clientCode !== undefined) set('client_code', str(body.clientCode, 'Client code', { max: 40 }));
  if (body.tin !== undefined) set('tin', str(body.tin, 'TIN', { max: 40 }));
  if (body.contactName !== undefined) set('contact_name', str(body.contactName, 'Contact', { max: 200 }));
  if (body.email !== undefined) set('email', str(body.email, 'Email', { max: 200 }));
  if (body.phone !== undefined) set('phone', str(body.phone, 'Phone', { max: 60 }));
  if (body.address !== undefined) set('address', str(body.address, 'Address', { max: 1000 }));
  if (body.sector !== undefined) set('sector', str(body.sector, 'Sector', { max: 120 }));
  if (body.note !== undefined) set('note', str(body.note, 'Note', { max: 2000 }));
  if (body.active !== undefined) set('active', bool(body.active, true) ? 1 : 0);

  if (!fields.length) return json({ ok: true, unchanged: true });

  await ctx.db.prepare(`UPDATE co_parties SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

export async function listCases(ctx) {
  const { db, url } = ctx;
  const where = [];
  const binds = [];

  const status = url.searchParams.get('status');
  if (status === 'open') where.push("c.status NOT IN ('completed','archived')");
  else if (status && CASE_STATUSES.includes(status)) { where.push('c.status = ?'); binds.push(status); }
  else where.push("c.status != 'archived'");

  if (url.searchParams.get('party')) { where.push('c.party_id = ?'); binds.push(Number(url.searchParams.get('party'))); }
  const type = url.searchParams.get('type');
  if (type && ENGAGEMENT_TYPES.includes(type)) { where.push('c.engagement_type = ?'); binds.push(type); }
  if (url.searchParams.get('mine') === '1') {
    where.push('(c.partner_user_id = ? OR c.manager_user_id = ?)');
    binds.push(ctx.session.user.id, ctx.session.user.id);
  }

  const rows = await db.prepare(
    `SELECT c.*, p.name AS party_name,
            pu.name AS partner_name, mu.name AS manager_name,
            (SELECT COUNT(*) FROM co_letters l WHERE l.case_id = c.id AND l.archived = 0) AS letters,
            (SELECT COUNT(*) FROM co_tasks t WHERE t.case_id = c.id AND t.status IN ('open','in_progress','blocked')) AS open_tasks,
            (SELECT COALESCE(SUM(t.hours), 0) FROM co_tasks t WHERE t.case_id = c.id) AS hours_logged
       FROM co_cases c
       LEFT JOIN co_parties p ON p.id = c.party_id
       LEFT JOIN users pu ON pu.id = c.partner_user_id
       LEFT JOIN users mu ON mu.id = c.manager_user_id
      WHERE ${where.join(' AND ')}
      ORDER BY (c.statutory_due IS NULL), c.statutory_due ASC, c.id DESC
      LIMIT 500`,
  ).bind(...binds).all();

  return json({ cases: rows.results ?? [] });
}

export async function getCase(ctx, id) {
  const { db } = ctx;
  const kase = await db.prepare(
    `SELECT c.*, p.name AS party_name, pu.name AS partner_name, mu.name AS manager_name
       FROM co_cases c
       LEFT JOIN co_parties p ON p.id = c.party_id
       LEFT JOIN users pu ON pu.id = c.partner_user_id
       LEFT JOIN users mu ON mu.id = c.manager_user_id
      WHERE c.id = ?`,
  ).bind(Number(id)).first();
  if (!kase) throw notFound('That engagement could not be found');

  const [letters, tasks, meetings, files] = await Promise.all([
    db.prepare(`SELECT id, ref, type, subject, status, due_at, created_at
                  FROM co_letters WHERE case_id = ? ORDER BY created_at DESC LIMIT 200`).bind(kase.id).all(),
    db.prepare('SELECT * FROM co_tasks WHERE case_id = ? ORDER BY (due_at IS NULL), due_at LIMIT 200').bind(kase.id).all(),
    db.prepare(`SELECT id, title, starts_at, status FROM co_meetings
                 WHERE case_id = ? AND is_series = 0 ORDER BY starts_at DESC LIMIT 50`).bind(kase.id).all(),
    db.prepare('SELECT id, name, mime, size, at, uploaded_by FROM co_attachments WHERE case_id = ? ORDER BY id').bind(kase.id).all(),
  ]);

  return json({
    case: kase,
    letters: letters.results ?? [],
    tasks: tasks.results ?? [],
    meetings: meetings.results ?? [],
    attachments: files.results ?? [],
  });
}

export async function createCase(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  const engagementType = str(body.engagementType, 'Engagement type', { max: 30, fallback: 'other' });
  if (!ENGAGEMENT_TYPES.includes(engagementType)) throw badRequest('That is not a kind of engagement');

  // Engagement references come from the same register as letters, so nothing
  // in the firm ever carries two different meanings of "ENG-2026-0004".
  const ref = await nextRef(db, 'ENG', {});

  const row = await db.prepare(
    `INSERT INTO co_cases
       (ref, party_id, title, engagement_type, period_label, period_end, statutory_due,
        target_due, partner_user_id, manager_user_id, status, budget_hours, fee, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING *`,
  ).bind(
    ref,
    body.partyId ? int(body.partyId, 'Client') : null,
    str(body.title, 'Title', { required: true, max: 300 }),
    engagementType,
    str(body.periodLabel, 'Period', { max: 80 }),
    str(body.periodEnd, 'Period end', { max: 30 }),
    str(body.statutoryDue, 'Statutory deadline', { max: 30 }),
    str(body.targetDue, 'Internal target', { max: 30 }),
    body.partnerUserId ? int(body.partnerUserId, 'Partner') : null,
    body.managerUserId ? int(body.managerUserId, 'Manager') : null,
    CASE_STATUSES.includes(body.status) ? body.status : 'planned',
    num(body.budgetHours, 'Budget hours', { min: 0, max: 100_000, fallback: 0 }),
    num(body.fee, 'Fee', { min: 0, max: 1e9, fallback: 0 }),
    str(body.note, 'Note', { max: 4000 }),
  ).first();

  await notify(db, {
    kind: 'co_case',
    title: `New engagement ${ref}`,
    body: `${row.title} — opened by ${session.user.name}.`,
    link: `#/co-case?id=${row.id}`,
    audience: 'co_cases',
    actor: session.user.name,
  });

  return json({ ok: true, case: row }, { status: 201 });
}

export async function updateCase(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    binds.push(value);
  };

  if (body.title !== undefined) set('title', str(body.title, 'Title', { required: true, max: 300 }));
  if (body.partyId !== undefined) set('party_id', body.partyId ? int(body.partyId, 'Client') : null);
  if (body.engagementType !== undefined) {
    const type = str(body.engagementType, 'Engagement type', { required: true, max: 30 });
    if (!ENGAGEMENT_TYPES.includes(type)) throw badRequest('That is not a kind of engagement');
    set('engagement_type', type);
  }
  if (body.periodLabel !== undefined) set('period_label', str(body.periodLabel, 'Period', { max: 80 }));
  if (body.periodEnd !== undefined) set('period_end', str(body.periodEnd, 'Period end', { max: 30 }));
  if (body.statutoryDue !== undefined) set('statutory_due', str(body.statutoryDue, 'Statutory deadline', { max: 30 }));
  if (body.targetDue !== undefined) set('target_due', str(body.targetDue, 'Internal target', { max: 30 }));
  if (body.partnerUserId !== undefined) set('partner_user_id', body.partnerUserId ? int(body.partnerUserId, 'Partner') : null);
  if (body.managerUserId !== undefined) set('manager_user_id', body.managerUserId ? int(body.managerUserId, 'Manager') : null);
  if (body.budgetHours !== undefined) set('budget_hours', num(body.budgetHours, 'Budget hours', { min: 0, max: 100_000 }));
  if (body.fee !== undefined) set('fee', num(body.fee, 'Fee', { min: 0, max: 1e9 }));
  if (body.note !== undefined) set('note', str(body.note, 'Note', { max: 4000 }));
  if (body.status !== undefined) {
    const status = str(body.status, 'Status', { required: true, max: 20 });
    if (!CASE_STATUSES.includes(status)) throw badRequest('That is not a status');
    set('status', status);
    set('closed_at', ['completed', 'archived'].includes(status) ? nowStamp() : null);
  }

  if (!fields.length) return json({ ok: true, unchanged: true });
  await ctx.db.prepare(`UPDATE co_cases SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Action points
// ---------------------------------------------------------------------------

export async function listTasks(ctx) {
  const { db, url, session } = ctx;
  // An action point raised off a restricted letter carries its subject in the
  // title. Excluding those is the same rule as the register itself, applied
  // where it would otherwise leak round the side.
  const visible = visibilityClause(session, 'rl');
  const where = [
    `(t.letter_id IS NULL OR EXISTS (
        SELECT 1 FROM co_letters rl WHERE rl.id = t.letter_id AND ${visible.sql}))`,
  ];
  const binds = [...visible.binds];

  const status = url.searchParams.get('status');
  if (status === 'open') where.push("t.status IN ('open','in_progress','blocked')");
  else if (status && TASK_STATUSES.includes(status)) { where.push('t.status = ?'); binds.push(status); }

  if (url.searchParams.get('mine') === '1') { where.push('t.assignee_user_id = ?'); binds.push(session.user.id); }
  if (url.searchParams.get('case')) { where.push('t.case_id = ?'); binds.push(Number(url.searchParams.get('case'))); }
  if (url.searchParams.get('meeting')) { where.push('t.meeting_id = ?'); binds.push(Number(url.searchParams.get('meeting'))); }
  if (url.searchParams.get('overdue') === '1') {
    where.push("t.due_at IS NOT NULL AND t.due_at < ? AND t.status IN ('open','in_progress','blocked')");
    binds.push(nowStamp());
  }

  const rows = await db.prepare(
    `SELECT t.*, c.ref AS case_ref, c.title AS case_title, l.ref AS letter_ref, m.title AS meeting_title
       FROM co_tasks t
       LEFT JOIN co_cases c ON c.id = t.case_id
       LEFT JOIN co_letters l ON l.id = t.letter_id
       LEFT JOIN co_meetings m ON m.id = t.meeting_id
      WHERE ${where.join(' AND ')}
      ORDER BY (t.due_at IS NULL), t.due_at ASC, t.id DESC LIMIT 500`,
  ).bind(...binds).all();

  return json({ tasks: rows.results ?? [] });
}

export async function createTask(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  const assigneeUserId = body.assigneeUserId ? int(body.assigneeUserId, 'Assignee') : null;
  const assignee = assigneeUserId
    ? await db.prepare('SELECT name FROM users WHERE id = ? AND active = 1').bind(assigneeUserId).first()
    : null;
  if (assigneeUserId && !assignee) throw badRequest('That person is no longer active');

  const priority = str(body.priority, 'Priority', { max: 20, fallback: 'normal' });
  if (!PRIORITIES.includes(priority)) throw badRequest('Unknown priority');

  const row = await db.prepare(
    `INSERT INTO co_tasks
       (title, detail, case_id, letter_id, meeting_id, assignee_user_id, assignee_name,
        created_by, due_at, priority, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'open') RETURNING *`,
  ).bind(
    str(body.title, 'Title', { required: true, max: 300 }),
    str(body.detail, 'Detail', { max: 4000 }),
    body.caseId ? int(body.caseId, 'Engagement') : null,
    body.letterId ? int(body.letterId, 'Letter') : null,
    body.meetingId ? int(body.meetingId, 'Meeting') : null,
    assigneeUserId,
    assignee?.name ?? null,
    session.user.name,
    str(body.dueAt, 'Due', { max: 30 }),
    priority,
  ).first();

  if (assigneeUserId) {
    await notify(db, {
      kind: 'co_task',
      level: priority === 'urgent' ? 'high' : 'info',
      title: `Action point for ${assignee.name}`,
      body: `${row.title}${row.due_at ? ` — due ${String(row.due_at).slice(0, 10)}` : ''}`,
      link: '#/co-tasks',
      audience: 'co_tasks',
      actor: session.user.name,
    });
  }

  return json({ ok: true, task: row }, { status: 201 });
}

export async function updateTask(ctx, id) {
  const { db, session } = ctx;
  const task = await db.prepare('SELECT * FROM co_tasks WHERE id = ?').bind(Number(id)).first();
  if (!task) throw notFound('That action point could not be found');

  // Anyone may move their own along. Changing somebody else's — reassigning it,
  // moving its deadline, closing it — is a manager's business, and that is true
  // of every field rather than only of the status.
  const isMine = task.assignee_user_id === session.user.id;
  const mayManage = session.permissions.includes('co_tasks')
    || session.permissions.includes('co_cases')
    || session.permissions.includes(OVERSIGHT);
  if (!isMine && !mayManage) {
    throw forbidden('That action point belongs to somebody else.');
  }

  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    binds.push(value);
  };

  if (body.title !== undefined) set('title', str(body.title, 'Title', { required: true, max: 300 }));
  if (body.detail !== undefined) set('detail', str(body.detail, 'Detail', { max: 4000 }));
  if (body.dueAt !== undefined) {
    set('due_at', str(body.dueAt, 'Due', { max: 30 }));
    // A moved deadline deserves a fresh reminder; keeping the old stamp would
    // silently mean the new date passes with nothing said.
    set('reminded_at', null);
  }
  if (body.caseId !== undefined) set('case_id', body.caseId ? int(body.caseId, 'Engagement') : null);
  if (body.hours !== undefined) set('hours', num(body.hours, 'Hours', { min: 0, max: 10_000 }));
  if (body.priority !== undefined) {
    const priority = str(body.priority, 'Priority', { required: true, max: 20 });
    if (!PRIORITIES.includes(priority)) throw badRequest('Unknown priority');
    set('priority', priority);
  }
  if (body.assigneeUserId !== undefined) {
    const uid = body.assigneeUserId ? int(body.assigneeUserId, 'Assignee') : null;
    const person = uid ? await db.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first() : null;
    set('assignee_user_id', uid);
    set('assignee_name', person?.name ?? null);
  }
  if (body.status !== undefined) {
    const status = str(body.status, 'Status', { required: true, max: 20 });
    if (!TASK_STATUSES.includes(status)) throw badRequest('That is not a status');
    set('status', status);
    set('completed_at', ['done', 'cancelled'].includes(status) ? nowStamp() : null);
  }

  if (!fields.length) return json({ ok: true, unchanged: true });
  await db.prepare(`UPDATE co_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, task.id).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export async function listMeetings(ctx) {
  const { db, url } = ctx;
  const where = ['m.is_series = 0'];
  const binds = [];

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from) { where.push('m.starts_at >= ?'); binds.push(from); }
  if (to) { where.push('m.starts_at <= ?'); binds.push(`${to}T23:59:59Z`); }
  if (url.searchParams.get('case')) { where.push('m.case_id = ?'); binds.push(Number(url.searchParams.get('case'))); }
  if (url.searchParams.get('upcoming') === '1') { where.push('m.starts_at >= ?'); binds.push(nowStamp()); }

  const rows = await db.prepare(
    `SELECT m.*, c.ref AS case_ref, c.title AS case_title,
            (SELECT COUNT(*) FROM co_meeting_attendees a WHERE a.meeting_id = m.id) AS attendee_count,
            (SELECT COUNT(*) FROM co_tasks t WHERE t.meeting_id = m.id) AS action_points
       FROM co_meetings m
       LEFT JOIN co_cases c ON c.id = m.case_id
      WHERE ${where.join(' AND ')}
      ORDER BY m.starts_at DESC LIMIT 300`,
  ).bind(...binds).all();

  const series = await db.prepare(
    `SELECT m.*, (SELECT COUNT(*) FROM co_meetings o WHERE o.series_id = m.id) AS occurrences
       FROM co_meetings m WHERE m.is_series = 1 ORDER BY m.title`,
  ).all();

  return json({ meetings: rows.results ?? [], series: series.results ?? [] });
}

export async function getMeeting(ctx, id) {
  const { db } = ctx;
  const meeting = await db.prepare(
    `SELECT m.*, c.ref AS case_ref, c.title AS case_title
       FROM co_meetings m LEFT JOIN co_cases c ON c.id = m.case_id WHERE m.id = ?`,
  ).bind(Number(id)).first();
  if (!meeting) throw notFound('That meeting could not be found');

  const [attendees, tasks, files] = await Promise.all([
    db.prepare(
      `SELECT a.*, u.name AS user_name, p.name AS party_name
         FROM co_meeting_attendees a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN co_parties p ON p.id = a.party_id
        WHERE a.meeting_id = ? ORDER BY a.id`,
    ).bind(meeting.id).all(),
    db.prepare('SELECT * FROM co_tasks WHERE meeting_id = ? ORDER BY id').bind(meeting.id).all(),
    db.prepare('SELECT id, name, mime, size, at, uploaded_by FROM co_attachments WHERE meeting_id = ? ORDER BY id').bind(meeting.id).all(),
  ]);

  return json({
    meeting,
    attendees: attendees.results ?? [],
    tasks: tasks.results ?? [],
    attachments: files.results ?? [],
  });
}

/**
 * Schedule a meeting — once, or on a repeat.
 *
 * A repeating meeting creates two rows: the series, which is the rule, and its
 * first occurrence, which is the thing in the diary. The sweep adds the next
 * occurrence as each one passes, so a diary never fills with a year of rows
 * that are all wrong the moment the time changes.
 */
export async function createMeeting(ctx) {
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  const startsAt = str(body.startsAt, 'Start', { required: true, max: 30 });
  if (Number.isNaN(new Date(startsAt).getTime())) throw badRequest('That start time is not a date');

  const recurrence = str(body.recurrence, 'Repeat', { max: 20, fallback: 'none' });
  if (!RECURRENCES.includes(recurrence)) throw badRequest('That is not a repeat pattern');

  const title = str(body.title, 'Title', { required: true, max: 300 });
  const shared = [
    title,
    str(body.agenda, 'Agenda', { max: 8000 }),
    int(body.durationMins ?? 60, 'Duration', { min: 5, max: 1440, fallback: 60 }),
    str(body.location, 'Location', { max: 200 }),
    session.user.id,
    session.user.name,
    body.caseId ? int(body.caseId, 'Engagement') : null,
    body.letterId ? int(body.letterId, 'Letter') : null,
  ];

  let seriesId = null;
  if (recurrence !== 'none') {
    const series = await db.prepare(
      `INSERT INTO co_meetings
         (title, agenda, starts_at, duration_mins, location, organiser_user_id, organiser_name,
          case_id, letter_id, recurrence, recurrence_until, is_series, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, 'scheduled') RETURNING id`,
    ).bind(
      shared[0], shared[1], isoStamp(new Date(startsAt)), shared[2], shared[3],
      shared[4], shared[5], shared[6], shared[7],
      recurrence, str(body.recurrenceUntil, 'Until', { max: 30 }),
    ).first();
    seriesId = series.id;
  }

  const meeting = await db.prepare(
    `INSERT INTO co_meetings
       (title, agenda, starts_at, duration_mins, location, organiser_user_id, organiser_name,
        case_id, letter_id, recurrence, series_id, is_series, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'none', ?10, 0, 'scheduled') RETURNING *`,
  ).bind(
    shared[0], shared[1], isoStamp(new Date(startsAt)), shared[2], shared[3],
    shared[4], shared[5], shared[6], shared[7], seriesId,
  ).first();

  await saveAttendees(db, meeting.id, body.attendees);
  // The invitation list belongs to the rule as well, so occurrences the sweep
  // creates months from now still have the right people on them.
  if (seriesId) await saveAttendees(db, seriesId, body.attendees);

  await notify(db, {
    kind: 'co_meeting',
    title: `Meeting: ${title}`,
    body: `${startsAt.slice(0, 16).replace('T', ' ')}`
      + (meeting.location ? ` · ${meeting.location}` : '')
      + (recurrence !== 'none' ? ` · repeats ${recurrence}` : ''),
    link: '#/co-meetings',
    audience: 'co_meetings',
    actor: session.user.name,
  });

  return json({
    ok: true,
    meeting,
    seriesId,
    nextAfter: seriesId ? nextOccurrence(startsAt, recurrence, new Date(startsAt)) : null,
  }, { status: 201 });
}

async function saveAttendees(db, meetingId, attendees) {
  if (!Array.isArray(attendees) || !attendees.length) return;
  await db.prepare('DELETE FROM co_meeting_attendees WHERE meeting_id = ?').bind(meetingId).run();
  await db.batch(attendees.slice(0, 100).map((a) => db.prepare(
    `INSERT INTO co_meeting_attendees (meeting_id, user_id, party_id, name, email, response)
     VALUES (?1, ?2, ?3, ?4, ?5, 'invited')`,
  ).bind(
    meetingId,
    a.userId ? Number(a.userId) : null,
    a.partyId ? Number(a.partyId) : null,
    str(a.name, 'Attendee', { max: 200 }),
    str(a.email, 'Attendee email', { max: 200 }),
  )));
}

export async function updateMeeting(ctx, id) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    binds.push(value);
  };

  if (body.title !== undefined) set('title', str(body.title, 'Title', { required: true, max: 300 }));
  if (body.agenda !== undefined) set('agenda', str(body.agenda, 'Agenda', { max: 8000 }));
  if (body.location !== undefined) set('location', str(body.location, 'Location', { max: 200 }));
  if (body.caseId !== undefined) set('case_id', body.caseId ? int(body.caseId, 'Engagement') : null);
  if (body.durationMins !== undefined) set('duration_mins', int(body.durationMins, 'Duration', { min: 5, max: 1440 }));
  if (body.startsAt !== undefined) {
    const startsAt = str(body.startsAt, 'Start', { required: true, max: 30 });
    if (Number.isNaN(new Date(startsAt).getTime())) throw badRequest('That start time is not a date');
    set('starts_at', isoStamp(new Date(startsAt)));
    set('reminded_at', null);
  }
  if (body.status !== undefined) {
    const status = str(body.status, 'Status', { required: true, max: 20 });
    if (!['scheduled', 'held', 'cancelled'].includes(status)) throw badRequest('That is not a status');
    set('status', status);
  }
  if (body.recurrenceUntil !== undefined) set('recurrence_until', str(body.recurrenceUntil, 'Until', { max: 30 }));

  if (fields.length) {
    await db.prepare(`UPDATE co_meetings SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...binds, Number(id)).run();
  }
  if (body.attendees !== undefined) await saveAttendees(db, Number(id), body.attendees);

  return json({ ok: true });
}

/**
 * Record what was decided, and turn the decisions into action points.
 *
 * Minutes with no action points are a document nobody opens again. Writing them
 * here creates the tasks in the same call, so "Ama to write to the Registrar by
 * Friday" leaves the meeting as something with a name and a date on it.
 */
export async function recordMinutes(ctx, id) {
  const { db, session } = ctx;
  const meeting = await db.prepare('SELECT * FROM co_meetings WHERE id = ?').bind(Number(id)).first();
  if (!meeting) throw notFound('That meeting could not be found');

  const body = await readJson(ctx.request);
  const minutes = str(body.minutes, 'Minutes', { required: true, max: 40_000 });

  await db.prepare(
    `UPDATE co_meetings SET minutes = ?, minutes_by = ?, minutes_at = datetime('now'),
            status = 'held' WHERE id = ?`,
  ).bind(minutes, session.user.name, meeting.id).run();

  const points = Array.isArray(body.actionPoints) ? body.actionPoints.slice(0, 50) : [];
  let created = 0;

  for (const point of points) {
    const title = str(point.title, 'Action point', { max: 300 });
    if (!title) continue;
    const uid = point.assigneeUserId ? Number(point.assigneeUserId) : null;
    const person = uid ? await db.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first() : null;

    await db.prepare(
      `INSERT INTO co_tasks
         (title, detail, case_id, meeting_id, assignee_user_id, assignee_name, created_by,
          due_at, priority, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open')`,
    ).bind(
      title,
      str(point.detail, 'Detail', { max: 2000 }),
      meeting.case_id,
      meeting.id,
      uid,
      person?.name ?? null,
      session.user.name,
      str(point.dueAt, 'Due', { max: 30 }),
      PRIORITIES.includes(point.priority) ? point.priority : 'normal',
    ).run();
    created += 1;
  }

  if (created) {
    await notify(db, {
      kind: 'co_minutes',
      title: `${created} action point${created === 1 ? '' : 's'} from ${meeting.title}`,
      body: `Minutes recorded by ${session.user.name}.`,
      link: '#/co-tasks',
      audience: 'co_tasks',
      actor: session.user.name,
    });
  }

  return json({ ok: true, actionPoints: created });
}

/** Mark who actually turned up. Feeds the attendance column in reporting. */
export async function markAttendance(ctx, id) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const rows = Array.isArray(body.attendance) ? body.attendance.slice(0, 100) : [];
  if (!rows.length) return json({ ok: true, unchanged: true });

  await db.batch(rows.map((r) => db.prepare(
    'UPDATE co_meeting_attendees SET attended = ?, response = COALESCE(?, response) WHERE id = ? AND meeting_id = ?',
  ).bind(
    r.attended ? 1 : 0,
    ['invited', 'accepted', 'declined'].includes(r.response) ? r.response : null,
    Number(r.id), Number(id),
  )));

  return json({ ok: true });
}

/** The engagement deadline board, as a spreadsheet. */
export async function exportCases(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT c.ref, c.title, p.name AS party, c.engagement_type, c.period_label, c.period_end,
            c.statutory_due, c.target_due, c.status, c.budget_hours, c.fee,
            pu.name AS partner, mu.name AS manager,
            (SELECT COALESCE(SUM(t.hours), 0) FROM co_tasks t WHERE t.case_id = c.id) AS hours_logged
       FROM co_cases c
       LEFT JOIN co_parties p ON p.id = c.party_id
       LEFT JOIN users pu ON pu.id = c.partner_user_id
       LEFT JOIN users mu ON mu.id = c.manager_user_id
      ORDER BY (c.statutory_due IS NULL), c.statutory_due LIMIT 5000`,
  ).all();

  const header = [
    'Reference', 'Engagement', 'Client', 'Type', 'Period', 'Period end',
    'Statutory deadline', 'Internal target', 'Status', 'Budget hours', 'Hours logged',
    'Fee', 'Partner', 'Manager',
  ];
  const body = (rows.results ?? []).map((r) => [
    r.ref, r.title, r.party, r.engagement_type, r.period_label, r.period_end,
    r.statutory_due, r.target_due, r.status, r.budget_hours, r.hours_logged,
    r.fee, r.partner, r.manager,
  ]);

  return csvResponse(`engagements-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body]);
}
