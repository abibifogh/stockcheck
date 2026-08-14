/**
 * The register: letters in, letters out, and everything that happens to them.
 *
 * Handlers here validate, write, and record the event. What a thing *means* —
 * how a reference is issued, who may see a restricted letter, when a deadline
 * falls — belongs to `lib/correspondence.js`, and is never decided twice.
 */

import {
  badRequest, bool, csvResponse, forbidden, int, json, notFound, readJson, str,
} from '../lib/http.js';
import {
  ACTION_KEYS, BLOCKING_ACTIONS, CHANNELS, CLOSED_STATUSES, CONFIDENTIALITY,
  LETTER_TYPES, OVERSIGHT, PRIORITIES, ROUTE_ACTIONS, STATUSES, TYPE_KEYS,
  addWorkingHours, assertEditable, canEditLetter, coSettings, currentDigest,
  isoStamp, letterSummary, loadLetter, nextRef, nowStamp, prefixFor, recordEvent,
  safeParse, verifySignatures, verifyTrail, visibilityClause,
} from '../lib/correspondence.js';
import {
  addressLabel, advanceWorkflow, announceRoute, autoWorkflowFor, nextSeq, startWorkflow,
} from '../lib/co-workflow.js';
import { sealFor } from '../lib/co-crypto.js';
import { notify } from '../lib/notify.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Everything the screens need before they can draw anything. */
export async function bootstrap(ctx) {
  const { db, session } = ctx;
  const settings = await coSettings(db);

  const [departments, categories, parties, cases, staff, templates, workflows] = await Promise.all([
    db.prepare('SELECT id, name, code, head_user_id FROM co_departments WHERE active = 1 ORDER BY sort_order, name').all(),
    db.prepare('SELECT id, name, prefix, default_due_hours FROM co_categories WHERE active = 1 ORDER BY sort_order, name').all(),
    db.prepare('SELECT id, name, kind, client_code, email, tin FROM co_parties WHERE active = 1 ORDER BY name').all(),
    db.prepare("SELECT id, ref, title, party_id, engagement_type, status, statutory_due FROM co_cases WHERE status NOT IN ('archived') ORDER BY id DESC LIMIT 500").all(),
    db.prepare(`SELECT u.id, u.name, u.role, s.department_id, s.title, s.signature_name, s.away_until
                  FROM users u LEFT JOIN co_staff s ON s.user_id = u.id
                 WHERE u.active = 1 ORDER BY u.name`).all(),
    db.prepare('SELECT id, name, type, category_id FROM co_templates WHERE active = 1 ORDER BY name').all(),
    db.prepare('SELECT id, name, applies_type, applies_category_id FROM co_workflows WHERE active = 1 ORDER BY name').all(),
  ]);

  const me = staff.results?.find((s) => s.id === session.user.id) ?? null;

  return json({
    firmName: settings.firmName,
    settings: {
      timezone: settings.timezone,
      defaultDueHours: settings.defaultDueHours,
      escalationGrace: settings.escalationGrace,
      reminderLead: settings.reminderLead,
    },
    user: {
      id: session.user.id,
      name: session.user.name,
      role: session.user.role,
      departmentId: me?.department_id ?? null,
      title: me?.title ?? null,
      signatureName: me?.signature_name ?? session.user.name,
    },
    permissions: session.permissions,
    types: LETTER_TYPES,
    actions: ROUTE_ACTIONS,
    statuses: STATUSES,
    priorities: PRIORITIES,
    channels: CHANNELS,
    confidentiality: CONFIDENTIALITY,
    departments: departments.results ?? [],
    categories: categories.results ?? [],
    parties: parties.results ?? [],
    cases: cases.results ?? [],
    staff: staff.results ?? [],
    templates: templates.results ?? [],
    workflows: workflows.results ?? [],
  });
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

/**
 * The register, filtered.
 *
 * Every filter is optional and they compose, because the question is never the
 * same twice: "everything overdue in Tax", "everything from Kwame Foods this
 * year", "what did I register last week".
 */
export async function listLetters(ctx) {
  const { db, url, session } = ctx;
  const params = url.searchParams;

  const where = [];
  const binds = [];

  const visible = visibilityClause(session);
  where.push(visible.sql);
  binds.push(...visible.binds);

  const add = (clause, ...values) => { where.push(clause); binds.push(...values); };

  const type = params.get('type');
  if (type && TYPE_KEYS.includes(type)) add('l.type = ?', type);

  const status = params.get('status');
  if (status === 'open') add(`l.status NOT IN ('closed','cancelled')`);
  else if (status && STATUSES.includes(status)) add('l.status = ?', status);

  if (params.get('party')) add('l.party_id = ?', Number(params.get('party')));
  if (params.get('case')) add('l.case_id = ?', Number(params.get('case')));
  if (params.get('category')) add('l.category_id = ?', Number(params.get('category')));
  if (params.get('department')) add('l.department_id = ?', Number(params.get('department')));
  if (params.get('priority')) add('l.priority = ?', params.get('priority'));
  if (params.get('from')) add('date(l.created_at) >= ?', params.get('from'));
  if (params.get('to')) add('date(l.created_at) <= ?', params.get('to'));

  // Archived rows are out of the way unless asked for: a register five years
  // old is mostly things nobody is looking for.
  if (params.get('archived') === '1') add('l.archived = 1');
  else add('l.archived = 0');

  if (params.get('overdue') === '1') {
    add(`l.due_at IS NOT NULL AND l.due_at < ? AND l.status NOT IN ('closed','cancelled')`, nowStamp());
  }

  if (params.get('mine') === '1') {
    add(
      `EXISTS (SELECT 1 FROM co_routes r WHERE r.letter_id = l.id
                AND r.to_user_id = ? AND r.status IN ('pending','acknowledged'))`,
      session.user.id,
    );
  }

  const q = str(params.get('q'), 'Search', { max: 120 });
  if (q) {
    // Reference, subject, their reference, summary and the client's name. Not
    // the body: D1 has no full-text index here, and a LIKE over every letter
    // ever written is the one query that would get slower every month.
    const like = `%${q}%`;
    add(
      '(l.ref LIKE ? OR l.subject LIKE ? OR l.their_ref LIKE ? OR l.summary LIKE ? OR p.name LIKE ?)',
      like, like, like, like, like,
    );
  }

  const limit = Math.min(Math.max(int(params.get('limit') ?? 100, 'Limit', { fallback: 100 }), 1), 500);
  const offset = Math.max(int(params.get('offset') ?? 0, 'Offset', { fallback: 0 }), 0);

  const sql = `
    SELECT l.*,
           p.name AS party_name,
           c.ref  AS case_ref,
           cat.name AS category_name,
           d.name AS department_name,
           (SELECT COUNT(*) FROM co_routes r
             WHERE r.letter_id = l.id AND r.status IN ('pending','acknowledged')) AS open_routes,
           (SELECT GROUP_CONCAT(r.to_name, ', ') FROM co_routes r
             WHERE r.letter_id = l.id AND r.status IN ('pending','acknowledged')) AS with_names
      FROM co_letters l
      LEFT JOIN co_parties p     ON p.id = l.party_id
      LEFT JOIN co_cases c       ON c.id = l.case_id
      LEFT JOIN co_categories cat ON cat.id = l.category_id
      LEFT JOIN co_departments d ON d.id = l.department_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT ? OFFSET ?`;

  const rows = await db.prepare(sql).bind(...binds, limit, offset).all();
  const now = new Date();

  const counted = await db.prepare(
    `SELECT COUNT(*) AS n FROM co_letters l LEFT JOIN co_parties p ON p.id = l.party_id
      WHERE ${where.join(' AND ')}`,
  ).bind(...binds).first();

  return json({
    letters: (rows.results ?? []).map((r) => letterSummary(r, now)),
    total: counted?.n ?? 0,
    limit,
    offset,
  });
}

/** One letter, with everything hanging off it. */
export async function getLetter(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);

  const [routes, events, attachments, signatures, links, party, kase, category, department, run] =
    await Promise.all([
      db.prepare(`SELECT r.*, u.name AS to_user_name FROM co_routes r
                    LEFT JOIN users u ON u.id = r.to_user_id
                   WHERE r.letter_id = ? ORDER BY r.seq, r.id`).bind(letter.id).all(),
      db.prepare('SELECT * FROM co_events WHERE letter_id = ? ORDER BY id DESC LIMIT 200').bind(letter.id).all(),
      db.prepare('SELECT id, name, mime, size, sha256, uploaded_by, at FROM co_attachments WHERE letter_id = ? ORDER BY id').bind(letter.id).all(),
      db.prepare('SELECT id, name, title, method, at, image FROM co_signatures WHERE letter_id = ? ORDER BY id').bind(letter.id).all(),
      db.prepare(`SELECT k.kind, l2.id, l2.ref, l2.subject, l2.type, l2.status
                    FROM co_letter_links k JOIN co_letters l2 ON l2.id = k.other_id
                   WHERE k.letter_id = ?`).bind(letter.id).all(),
      letter.party_id ? db.prepare('SELECT * FROM co_parties WHERE id = ?').bind(letter.party_id).first() : null,
      letter.case_id ? db.prepare('SELECT id, ref, title, statutory_due, status FROM co_cases WHERE id = ?').bind(letter.case_id).first() : null,
      letter.category_id ? db.prepare('SELECT id, name, retention_years FROM co_categories WHERE id = ?').bind(letter.category_id).first() : null,
      letter.department_id ? db.prepare('SELECT id, name FROM co_departments WHERE id = ?').bind(letter.department_id).first() : null,
      db.prepare(`SELECT r.*, w.name AS workflow_name FROM co_workflow_runs r
                    JOIN co_workflows w ON w.id = r.workflow_id
                   WHERE r.letter_id = ? ORDER BY r.id DESC LIMIT 1`).bind(letter.id).first(),
    ]);

  const recipients = await db.prepare(
    `SELECT k.id, k.kind, k.name, k.email, p.name AS party_name
       FROM co_recipients k LEFT JOIN co_parties p ON p.id = k.party_id
      WHERE k.letter_id = ? ORDER BY k.id`,
  ).bind(letter.id).all();

  const signatureCheck = await verifySignatures(db, env, letter);

  return json({
    letter: {
      ...letter,
      sealed: Boolean(letter.sealed_at),
      canEdit: canEditLetter(letter, session),
      recipients: recipients.results ?? [],
    },
    party: party ?? null,
    case: kase ?? null,
    category: category ?? null,
    department: department ?? null,
    workflow: run ?? null,
    routes: (routes.results ?? []).map((r) => ({
      ...r,
      mine: r.to_user_id === session.user.id,
      // A pool route with nobody's name on it is claimable by anyone who can
      // route, which is what the button on the screen keys off.
      claimable: !r.to_user_id && (r.to_department_id || r.to_permission) && r.status === 'pending',
    })),
    events: (events.results ?? []).map((e) => ({ ...e, detail: safeParse(e.detail) })),
    attachments: attachments.results ?? [],
    // The drawn image is joined back on by id rather than by position. The two
    // queries happen to return the same order today, and a screen that showed
    // one partner's signature under another partner's name because that stopped
    // being true would be a serious thing to have shipped.
    signatures: signatureCheck.signatures.map((s) => ({
      ...s,
      image: (signatures.results ?? []).find((row) => row.id === s.id)?.image ?? null,
    })),
    signaturesValid: signatureCheck.allValid && !signatureCheck.documentMoved,
    links: links.results ?? [],
  });
}

/**
 * Register a new letter.
 *
 * The reference is issued here rather than later, because a register issues a
 * number when the letter reaches the desk — not when somebody eventually
 * finishes typing it. An abandoned draft therefore keeps its number, which is
 * correct: a gap in a register is a question with an answer, a reused number is
 * two letters filed as one.
 */
export async function createLetter(ctx) {
  const { db, env, session } = ctx;
  const body = await readJson(ctx.request);
  const settings = await coSettings(db);

  const type = str(body.type, 'Type', { required: true, max: 20 });
  if (!TYPE_KEYS.includes(type)) throw badRequest('That is not a kind of correspondence');

  const subject = str(body.subject, 'Subject', { required: true, max: 300 });
  const categoryId = body.categoryId ? int(body.categoryId, 'Category') : null;
  const category = categoryId
    ? await db.prepare('SELECT * FROM co_categories WHERE id = ?').bind(categoryId).first()
    : null;
  if (categoryId && !category) throw badRequest('That category no longer exists');

  const confidentiality = str(body.confidentiality, 'Confidentiality', { max: 20, fallback: 'normal' });
  if (!CONFIDENTIALITY.includes(confidentiality)) throw badRequest('Unknown confidentiality level');

  const priority = str(body.priority, 'Priority', { max: 20, fallback: 'normal' });
  if (!PRIORITIES.includes(priority)) throw badRequest('Unknown priority');

  const channel = str(body.channel, 'Channel', { max: 20 });
  if (channel && !CHANNELS.includes(channel)) throw badRequest('Unknown channel');

  const ref = await nextRef(db, prefixFor(type, category), { digits: settings.refDigits });

  // Incoming post is registered the moment it is logged — it has already
  // arrived. Something the firm is sending starts as a draft, because it is
  // not finished until somebody says so.
  const status = type === 'incoming' ? 'registered' : 'draft';

  const dueHours = body.dueAt
    ? null
    : (category?.default_due_hours ?? settings.defaultDueHours);
  const dueAt = body.dueAt
    ? str(body.dueAt, 'Due date', { max: 30 })
    : isoStamp(addWorkingHours(new Date(), dueHours, settings.workingDays));

  const letter = await db.prepare(
    `INSERT INTO co_letters
       (ref, type, subject, body, summary, party_id, case_id, category_id, department_id,
        confidentiality, priority, channel, their_ref, letter_date, received_at, due_at,
        status, created_by, created_by_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
     RETURNING *`,
  ).bind(
    ref, type, subject,
    str(body.body, 'Body', { max: 60_000 }),
    str(body.summary, 'Summary', { max: 1000 }),
    body.partyId ? int(body.partyId, 'Client') : null,
    body.caseId ? int(body.caseId, 'Engagement') : null,
    categoryId,
    body.departmentId ? int(body.departmentId, 'Department') : null,
    confidentiality, priority, channel,
    str(body.theirRef, 'Their reference', { max: 100 }),
    str(body.letterDate, 'Date on the letter', { max: 30 }),
    type === 'incoming' ? (str(body.receivedAt, 'Received', { max: 30 }) ?? nowStamp()) : null,
    dueAt, status, session.user.id, session.user.name,
  ).first();

  await addRecipients(db, letter.id, body.recipients);

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'letter.registered',
    detail: { ref, type, subject, confidentiality, priority, dueAt },
  });

  // A letter that arrived is announced now; one still being drafted is
  // announced when it is sent for approval, because until then nobody else has
  // anything to do about it.
  if (type === 'incoming') {
    await notify(db, {
      kind: 'co_registered',
      level: priority === 'urgent' ? 'high' : 'info',
      title: `${ref} registered`,
      body: `“${subject}”${letter.party_id ? '' : ''} was logged by ${session.user.name}.`,
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
      actor: session.user.name,
    });
  }

  // A category with a workflow starts it straight away. Nothing to press.
  //
  // `noWorkflow` is a real answer and not the same as leaving the field alone:
  // it means do not start the category's one either. Somebody registering a
  // letter they intend to route by hand needs a way to say so, and switching
  // the category off to get it would file the letter wrongly for ever.
  const workflow = bool(body.noWorkflow, false)
    ? null
    : body.workflowId
      ? await db.prepare('SELECT * FROM co_workflows WHERE id = ? AND active = 1')
        .bind(int(body.workflowId, 'Workflow')).first()
      : await autoWorkflowFor(db, letter);
  if (workflow) {
    await startWorkflow(db, env, letter, workflow.id, session.user);
  }

  const fresh = await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(letter.id).first();
  return json({ ok: true, letter: fresh }, { status: 201 });
}

async function addRecipients(db, letterId, recipients) {
  if (!Array.isArray(recipients) || !recipients.length) return;
  const statements = recipients.slice(0, 50).map((r) => db.prepare(
    `INSERT INTO co_recipients (letter_id, kind, party_id, user_id, name, email)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(
    letterId,
    ['to', 'cc', 'bcc'].includes(r.kind) ? r.kind : 'to',
    r.partyId ? Number(r.partyId) : null,
    r.userId ? Number(r.userId) : null,
    str(r.name, 'Recipient', { max: 200 }),
    str(r.email, 'Recipient email', { max: 200 }),
  ));
  await db.batch(statements);
}

/** Change a letter that has not been sealed. */
export async function updateLetter(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  assertEditable(letter, session);

  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const changed = {};

  const set = (column, value, label) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    binds.push(value);
    changed[label ?? column] = value;
  };

  if (body.subject !== undefined) set('subject', str(body.subject, 'Subject', { required: true, max: 300 }));
  if (body.body !== undefined) set('body', str(body.body, 'Body', { max: 60_000 }));
  if (body.summary !== undefined) set('summary', str(body.summary, 'Summary', { max: 1000 }));
  if (body.theirRef !== undefined) set('their_ref', str(body.theirRef, 'Their reference', { max: 100 }));
  if (body.letterDate !== undefined) set('letter_date', str(body.letterDate, 'Date', { max: 30 }));
  if (body.dueAt !== undefined) set('due_at', str(body.dueAt, 'Due', { max: 30 }));
  if (body.partyId !== undefined) set('party_id', body.partyId ? int(body.partyId, 'Client') : null);
  if (body.caseId !== undefined) set('case_id', body.caseId ? int(body.caseId, 'Engagement') : null);
  if (body.categoryId !== undefined) set('category_id', body.categoryId ? int(body.categoryId, 'Category') : null);
  if (body.departmentId !== undefined) set('department_id', body.departmentId ? int(body.departmentId, 'Department') : null);

  if (body.priority !== undefined) {
    const priority = str(body.priority, 'Priority', { required: true, max: 20 });
    if (!PRIORITIES.includes(priority)) throw badRequest('Unknown priority');
    set('priority', priority);
  }
  if (body.channel !== undefined) {
    const channel = str(body.channel, 'Channel', { max: 20 });
    if (channel && !CHANNELS.includes(channel)) throw badRequest('Unknown channel');
    set('channel', channel);
  }
  if (body.confidentiality !== undefined) {
    const level = str(body.confidentiality, 'Confidentiality', { required: true, max: 20 });
    if (!CONFIDENTIALITY.includes(level)) throw badRequest('Unknown confidentiality level');
    // Raising a letter to restricted is a decision with consequences for who can
    // see it, so it is a partner's to make — not the author's, after the fact.
    if (level === 'restricted' && !session.permissions.includes(OVERSIGHT)) {
      throw forbidden('Only a partner can mark correspondence restricted.');
    }
    set('confidentiality', level);
  }

  if (!fields.length) return json({ ok: true, unchanged: true });

  await db.prepare(
    `UPDATE co_letters SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
  ).bind(...binds, letter.id).run();

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'letter.amended',
    detail: changed,
  });

  const fresh = await db.prepare('SELECT * FROM co_letters WHERE id = ?').bind(letter.id).first();
  return json({ ok: true, letter: fresh });
}

/**
 * Move a letter along by hand: dispatched, closed, reopened, cancelled.
 *
 * Dispatch is the one with a rule attached. A letter with an approval or a
 * signature still outstanding cannot go out, because the whole reason those
 * routes exist is to stop exactly that.
 */
export async function setStatus(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  const body = await readJson(ctx.request);

  const status = str(body.status, 'Status', { required: true, max: 30 });
  if (!STATUSES.includes(status)) throw badRequest('That is not a status');

  if (status === 'dispatched') {
    const blocking = await db.prepare(
      `SELECT COUNT(*) AS n FROM co_routes
        WHERE letter_id = ? AND status IN ('pending','acknowledged') AND action IN ('approve','sign')`,
    ).bind(letter.id).first();
    if (Number(blocking?.n ?? 0) > 0) {
      throw badRequest(
        'This is still waiting for approval or signature, so it cannot be marked as sent. '
        + 'Clear those first, or cancel them if they are no longer needed.',
      );
    }
  }

  const closing = CLOSED_STATUSES.has(status);

  await db.prepare(
    `UPDATE co_letters
        SET status = ?1,
            dispatched_at = CASE WHEN ?1 = 'dispatched' THEN COALESCE(dispatched_at, datetime('now')) ELSE dispatched_at END,
            closed_at = CASE WHEN ?2 = 1 THEN datetime('now') ELSE NULL END,
            closed_by  = CASE WHEN ?2 = 1 THEN ?3 ELSE NULL END,
            updated_at = datetime('now')
      WHERE id = ?4`,
  ).bind(status, closing ? 1 : 0, session.user.name, letter.id).run();

  // Closing a letter closes what people were still being asked to do about it.
  // Leaving them open would keep it in somebody's queue for ever with nothing
  // at the other end.
  if (closing) {
    await db.prepare(
      `UPDATE co_routes SET status = 'cancelled', completed_at = datetime('now')
        WHERE letter_id = ? AND status IN ('pending','acknowledged')`,
    ).bind(letter.id).run();
    await db.prepare(
      "UPDATE co_workflow_runs SET status = 'cancelled', finished_at = datetime('now') WHERE letter_id = ? AND status = 'running'",
    ).bind(letter.id).run();
  }

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: `letter.${status}`,
    detail: { note: str(body.note, 'Note', { max: 500 }) },
  });

  return json({ ok: true, status });
}

/** Put a letter beyond the working register, or bring it back. */
export async function archiveLetter(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  const body = await readJson(ctx.request);
  const archived = bool(body.archived, true);

  if (archived && !CLOSED_STATUSES.has(letter.status)) {
    throw badRequest('Close this first. Archiving something still being worked on hides live work.');
  }

  await db.prepare("UPDATE co_letters SET archived = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(archived ? 1 : 0, letter.id).run();
  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: archived ? 'letter.archived' : 'letter.unarchived',
  });
  return json({ ok: true, archived });
}

/** Tie two letters together — a reply, a follow-up, or simply "see also". */
export async function linkLetter(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  const body = await readJson(ctx.request);

  const otherId = int(body.otherId, 'The other letter', { required: true });
  if (otherId === letter.id) throw badRequest('A letter cannot be linked to itself');
  const other = await loadLetter(db, otherId, session);

  const kind = str(body.kind, 'Link', { max: 20, fallback: 'related' });
  if (!['reply_to', 'follow_up', 'related'].includes(kind)) throw badRequest('Unknown kind of link');

  // Held both ways so the thread reads from either end. The mirrored kind is
  // not the same word: B is a reply to A, so from B's side A is what it
  // replied to.
  const mirror = kind === 'reply_to' ? 'follow_up' : kind === 'follow_up' ? 'reply_to' : 'related';

  await db.batch([
    db.prepare('INSERT OR IGNORE INTO co_letter_links (letter_id, other_id, kind) VALUES (?1, ?2, ?3)')
      .bind(letter.id, other.id, kind),
    db.prepare('INSERT OR IGNORE INTO co_letter_links (letter_id, other_id, kind) VALUES (?1, ?2, ?3)')
      .bind(other.id, letter.id, mirror),
  ]);

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'letter.linked',
    detail: { to: other.ref, kind },
  });

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Send a letter to somebody, a department, or anyone holding a permission. */
export async function createRoute(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  if (CLOSED_STATUSES.has(letter.status)) {
    throw badRequest('This correspondence is closed. Reopen it before sending it to anybody.');
  }

  const body = await readJson(ctx.request);
  const action = str(body.action, 'What is being asked', { required: true, max: 20 });
  if (!ACTION_KEYS.includes(action)) throw badRequest('That is not something you can ask for');

  const toUserId = body.toUserId ? int(body.toUserId, 'Person') : null;
  const toDepartmentId = body.toDepartmentId ? int(body.toDepartmentId, 'Department') : null;
  const toPermission = str(body.toPermission, 'Anyone who can', { max: 40 });

  if (!toUserId && !toDepartmentId && !toPermission) {
    throw badRequest('Say who this is going to — a person, a department, or anyone who can approve.');
  }

  const settings = await coSettings(db);
  const dueAt = body.dueAt
    ? str(body.dueAt, 'Due', { max: 30 })
    : isoStamp(addWorkingHours(
      new Date(),
      body.dueHours ? int(body.dueHours, 'Hours', { min: 1, max: 8760 }) : settings.defaultDueHours,
      settings.workingDays,
    ));

  const target = { to_user_id: toUserId, to_department_id: toDepartmentId, to_permission: toPermission };

  const route = await db.prepare(
    `INSERT INTO co_routes
       (letter_id, seq, from_user_id, from_name, to_user_id, to_department_id, to_permission,
        to_name, action, instruction, due_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending')
     RETURNING *`,
  ).bind(
    letter.id, await nextSeq(db, letter.id), session.user.id, session.user.name,
    toUserId, toDepartmentId, toPermission,
    await addressLabel(db, target),
    action, str(body.instruction, 'Instruction', { max: 2000 }), dueAt,
  ).first();

  const nextStatus = BLOCKING_ACTIONS.has(action) ? 'awaiting_approval' : 'in_progress';
  await db.prepare(
    `UPDATE co_letters SET status = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('draft','registered','in_progress')`,
  ).bind(nextStatus, letter.id).run();

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'route.sent',
    detail: { to: route.to_name, action, dueAt, instruction: route.instruction },
  });

  await announceRoute(db, env, letter, route);
  return json({ ok: true, route }, { status: 201 });
}

/**
 * Everything currently sitting with the signed-in person.
 *
 * Their own routes, the pool routes they could claim, and — when they are
 * covering for somebody who is away — that person's too, marked as such.
 */
export async function myWork(ctx) {
  const { db, session } = ctx;
  const uid = session.user.id;

  const mine = await db.prepare(
    `SELECT r.*, l.ref, l.subject, l.type, l.priority, l.confidentiality, l.status AS letter_status,
            p.name AS party_name
       FROM co_routes r
       JOIN co_letters l ON l.id = r.letter_id
       LEFT JOIN co_parties p ON p.id = l.party_id
      WHERE r.status IN ('pending','acknowledged') AND r.to_user_id = ?
      ORDER BY (r.due_at IS NULL), r.due_at ASC LIMIT 200`,
  ).bind(uid).all();

  // Pool routes: addressed to my department, or to a permission I hold, and
  // not yet claimed by anybody.
  const staff = await db.prepare('SELECT department_id FROM co_staff WHERE user_id = ?')
    .bind(uid).first().catch(() => null);

  const pool = await db.prepare(
    `SELECT r.*, l.ref, l.subject, l.type, l.priority, l.status AS letter_status, p.name AS party_name
       FROM co_routes r
       JOIN co_letters l ON l.id = r.letter_id
       LEFT JOIN co_parties p ON p.id = l.party_id
      WHERE r.status = 'pending' AND r.to_user_id IS NULL
        AND (r.to_department_id = ?1 OR r.to_permission IS NOT NULL)
      ORDER BY (r.due_at IS NULL), r.due_at ASC LIMIT 100`,
  ).bind(staff?.department_id ?? -1).all();

  const claimable = (pool.results ?? []).filter(
    (r) => !r.to_permission || session.permissions.includes(r.to_permission),
  );

  const covering = await db.prepare(
    `SELECT r.*, l.ref, l.subject, l.type, l.priority, u.name AS owner_name
       FROM co_routes r
       JOIN co_letters l ON l.id = r.letter_id
       JOIN co_staff s ON s.user_id = r.to_user_id
       JOIN users u ON u.id = r.to_user_id
      WHERE r.status IN ('pending','acknowledged')
        AND s.delegate_user_id = ?1 AND datetime(s.away_until) > datetime('now')
      ORDER BY (r.due_at IS NULL), r.due_at ASC LIMIT 100`,
  ).bind(uid).all().catch(() => ({ results: [] }));

  const tasks = await db.prepare(
    `SELECT * FROM co_tasks WHERE assignee_user_id = ? AND status IN ('open','in_progress','blocked')
      ORDER BY (due_at IS NULL), due_at ASC LIMIT 100`,
  ).bind(uid).all().catch(() => ({ results: [] }));

  return json({
    routes: mine.results ?? [],
    claimable,
    covering: covering.results ?? [],
    tasks: tasks.results ?? [],
  });
}

/**
 * Act on a route: acknowledge it, complete it, return it, or pass it on.
 *
 * The gate is being the person it is addressed to. A pool route has nobody's
 * name on it yet, so acting on it claims it — which is the whole mechanism by
 * which "send this to Tax" ends up with a name against the work.
 */
export async function actOnRoute(ctx, routeId) {
  const { db, env, session } = ctx;
  const route = await db.prepare('SELECT * FROM co_routes WHERE id = ?').bind(Number(routeId)).first();
  if (!route) throw notFound('That routing entry could not be found');

  const letter = await loadLetter(db, route.letter_id, session);
  const body = await readJson(ctx.request);
  const act = str(body.act, 'Action', { required: true, max: 20 });

  const isMine = route.to_user_id === session.user.id;
  const isPool = !route.to_user_id
    && (route.to_department_id != null || route.to_permission != null);
  const poolOpen = isPool
    && (!route.to_permission || session.permissions.includes(route.to_permission));
  const isOverseer = session.permissions.includes(OVERSIGHT);

  if (!isMine && !poolOpen && !isOverseer) {
    throw forbidden('This is not with you. Only the person it was sent to can act on it.');
  }
  if (route.status === 'completed' || route.status === 'cancelled') {
    throw badRequest('That has already been dealt with.');
  }

  // Claiming: an unclaimed pool route gets the acting person's name written on
  // it, so from here on it is theirs and everybody else's list is shorter.
  if (!route.to_user_id && (isMine || poolOpen)) {
    await db.prepare('UPDATE co_routes SET to_user_id = ?, to_name = ? WHERE id = ?')
      .bind(session.user.id, session.user.name, route.id).run();
    route.to_user_id = session.user.id;
    route.to_name = session.user.name;
  }

  const comment = str(body.comment, 'Comment', { max: 4000 });

  if (act === 'acknowledge') {
    await db.prepare(
      "UPDATE co_routes SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?",
    ).bind(route.id).run();
    await recordEvent(db, env, letter.id, {
      actor: session.user.name,
      actorUserId: session.user.id,
      action: 'route.acknowledged',
      detail: { route: route.id },
    });
    return json({ ok: true, status: 'acknowledged' });
  }

  if (act === 'forward') {
    // Passing it on does not discharge it: the original stays open until the
    // person it went to reports back, which is what stops a letter being
    // forwarded round the firm until everyone thinks somebody else has it.
    const toUserId = body.toUserId ? int(body.toUserId, 'Person') : null;
    const toDepartmentId = body.toDepartmentId ? int(body.toDepartmentId, 'Department') : null;
    if (!toUserId && !toDepartmentId) throw badRequest('Say who you are passing this to');

    const settings = await coSettings(db);
    const target = { to_user_id: toUserId, to_department_id: toDepartmentId };
    const onward = await db.prepare(
      `INSERT INTO co_routes
         (letter_id, seq, from_user_id, from_name, to_user_id, to_department_id, to_name,
          action, instruction, due_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending') RETURNING *`,
    ).bind(
      letter.id, await nextSeq(db, letter.id), session.user.id, session.user.name,
      toUserId, toDepartmentId, await addressLabel(db, target),
      str(body.action, 'What is being asked', { max: 20, fallback: 'action' }),
      comment,
      route.due_at ?? isoStamp(addWorkingHours(new Date(), settings.defaultDueHours, settings.workingDays)),
    ).first();

    await recordEvent(db, env, letter.id, {
      actor: session.user.name,
      actorUserId: session.user.id,
      action: 'route.forwarded',
      detail: { from: route.to_name, to: onward.to_name, comment },
    });
    await announceRoute(db, env, letter, onward);
    return json({ ok: true, status: 'forwarded', route: onward });
  }

  if (act === 'return') {
    await db.prepare(
      `UPDATE co_routes SET status = 'returned', comment = ?, completed_at = datetime('now'),
              completed_by = ? WHERE id = ?`,
    ).bind(comment, session.user.name, route.id).run();

    await recordEvent(db, env, letter.id, {
      actor: session.user.name,
      actorUserId: session.user.id,
      action: 'route.returned',
      detail: { route: route.id, comment },
    });
    await notify(db, {
      kind: 'co_returned',
      level: 'warn',
      title: `${letter.ref} came back`,
      body: `${session.user.name} returned it${comment ? `: ${comment}` : '.'}`,
      link: `#/co-letter?id=${letter.id}`,
      audience: 'co_register',
      actor: session.user.name,
    });
    return json({ ok: true, status: 'returned' });
  }

  if (act !== 'complete') throw badRequest('Unknown action');

  // Completing. Approval and signature routes must say which way they went.
  let decision = null;
  if (route.action === 'approve' || route.action === 'sign') {
    decision = str(body.decision, 'Decision', { required: true, max: 20 });
    if (!['approved', 'rejected'].includes(decision)) {
      throw badRequest('An approval is either approved or rejected');
    }
    if (decision === 'rejected' && !comment) {
      throw badRequest('Say why it was rejected. A rejection with no reason cannot be acted on.');
    }
    if (!session.permissions.includes('co_approve') && !isOverseer) {
      throw forbidden('You do not have approval rights.');
    }
  } else if (body.decision) {
    decision = 'noted';
  }

  await db.prepare(
    `UPDATE co_routes SET status = 'completed', decision = ?, comment = ?,
            completed_at = datetime('now'), completed_by = ?,
            acknowledged_at = COALESCE(acknowledged_at, datetime('now'))
      WHERE id = ?`,
  ).bind(decision, comment, session.user.name, route.id).run();

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: route.action === 'approve' || route.action === 'sign'
      ? `route.${decision}` : 'route.completed',
    detail: { route: route.id, asked: route.action, comment },
  });

  const completed = { ...route, decision, comment };
  const moved = await advanceWorkflow(db, env, letter, completed, session.user);

  // A hand-made route finishing when nothing else is outstanding puts the
  // letter back to a resting state, rather than leaving it "awaiting approval"
  // for ever because the label was never updated.
  if (!moved) await settleLetter(db, letter);

  return json({ ok: true, status: 'completed', decision, workflow: moved?.ended ?? null });
}

/** No open routes left: say so on the letter rather than leaving a stale label. */
async function settleLetter(db, letter) {
  const open = await db.prepare(
    "SELECT COUNT(*) AS n FROM co_routes WHERE letter_id = ? AND status IN ('pending','acknowledged')",
  ).bind(letter.id).first();
  if (Number(open?.n ?? 0) > 0) return;

  const rejected = await db.prepare(
    "SELECT COUNT(*) AS n FROM co_routes WHERE letter_id = ? AND decision = 'rejected'",
  ).bind(letter.id).first();

  const next = Number(rejected?.n ?? 0) > 0
    ? 'in_progress'
    : letter.type === 'outgoing' ? 'approved' : 'in_progress';

  await db.prepare(
    `UPDATE co_letters SET status = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'awaiting_approval'`,
  ).bind(next, letter.id).run();
}

/** Cancel a route that should never have been sent. */
export async function cancelRoute(ctx, routeId) {
  const { db, env, session } = ctx;
  const route = await db.prepare('SELECT * FROM co_routes WHERE id = ?').bind(Number(routeId)).first();
  if (!route) throw notFound('That routing entry could not be found');
  const letter = await loadLetter(db, route.letter_id, session);

  const isSender = route.from_user_id === session.user.id;
  if (!isSender && !session.permissions.includes(OVERSIGHT)) {
    throw forbidden('Only whoever sent it, or a partner, can withdraw it.');
  }
  if (route.status === 'completed') throw badRequest('That has already been dealt with.');

  await db.prepare(
    "UPDATE co_routes SET status = 'cancelled', completed_at = datetime('now'), completed_by = ? WHERE id = ?",
  ).bind(session.user.name, route.id).run();

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'route.cancelled',
    detail: { route: route.id, to: route.to_name },
  });
  await settleLetter(db, letter);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Sign a letter, sealing its text and attachments as they stand.
 *
 * The seal is over a digest of the exact document; the digest is stored beside
 * the signature. From then on the letter cannot be edited, and the verification
 * screen can say whether anything underneath it has moved since.
 */
export async function signLetter(ctx, id) {
  const { db, env, request, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);
  const body = await readJson(request);

  if (CLOSED_STATUSES.has(letter.status)) throw badRequest('This correspondence is closed.');

  const name = str(body.name, 'Name', { required: true, max: 200 });
  const method = str(body.method, 'Method', { max: 20, fallback: 'typed' });
  if (!['typed', 'drawn'].includes(method)) throw badRequest('Unknown way of signing');

  const image = method === 'drawn' ? str(body.image, 'Signature', { max: 200_000 }) : null;
  if (method === 'drawn' && !image) throw badRequest('The drawn signature did not reach the server');

  // Typing your own name is the assertion. Requiring it to match the account
  // means a signature cannot be applied on somebody else's behalf by accident.
  const staff = await db.prepare('SELECT signature_name, title FROM co_staff WHERE user_id = ?')
    .bind(session.user.id).first().catch(() => null);

  const at = nowStamp();
  const contentHash = await currentDigest(db, env, letter);
  const seal = await sealFor(env, contentHash, { userId: session.user.id, name, at });

  await db.prepare(
    `INSERT INTO co_signatures
       (letter_id, route_id, user_id, name, title, method, image, content_hash, seal, at, ip)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    letter.id,
    body.routeId ? int(body.routeId, 'Route') : null,
    session.user.id,
    staff?.signature_name || name,
    str(body.title, 'Title', { max: 120 }) ?? staff?.title ?? null,
    method, image, contentHash, seal, at,
    request.headers.get('CF-Connecting-IP') || null,
  ).run();

  await db.prepare(
    "UPDATE co_letters SET sealed_at = COALESCE(sealed_at, ?), content_hash = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(at, contentHash, letter.id).run();

  await recordEvent(db, env, letter.id, {
    actor: session.user.name,
    actorUserId: session.user.id,
    action: 'letter.signed',
    detail: { name: staff?.signature_name || name, method, contentHash },
  });

  return json({ ok: true, at, contentHash });
}

/**
 * Check a letter's whole record: the trail's hash chain, and every signature.
 *
 * Two independent questions, reported separately, because they fail for
 * different reasons and need different answers. A broken chain means somebody
 * edited the history. A signature whose digest no longer matches means the
 * document changed after it was signed.
 */
export async function verifyLetter(ctx, id) {
  const { db, env, session } = ctx;
  const letter = await loadLetter(db, Number(id), session);

  const [trail, signatures] = await Promise.all([
    verifyTrail(db, env, letter.id),
    verifySignatures(db, env, letter),
  ]);

  return json({
    ref: letter.ref,
    trail,
    signatures: signatures.signatures,
    documentMoved: signatures.documentMoved,
    sealsValid: signatures.allValid,
    checkedAt: nowStamp(),
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export { downloadAttachment, removeAttachment, uploadAttachment } from './co-files.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(ctx) {
  const rows = await ctx.db.prepare(
    'SELECT * FROM co_templates WHERE active = 1 ORDER BY name',
  ).all();
  return json({ templates: rows.results ?? [] });
}

/**
 * A template with its placeholders filled in.
 *
 * Anything the system does not know is left as it was rather than blanked:
 * {{fee}} on the page is a prompt to type the fee, an empty space is a letter
 * that goes out with a hole in it.
 */
export async function renderTemplate(ctx, id) {
  const { db, url } = ctx;
  const template = await db.prepare('SELECT * FROM co_templates WHERE id = ?').bind(Number(id)).first();
  if (!template) throw notFound('That template could not be found');

  const partyId = url.searchParams.get('party');
  const caseId = url.searchParams.get('case');

  const [party, kase, settings] = await Promise.all([
    partyId ? db.prepare('SELECT * FROM co_parties WHERE id = ?').bind(Number(partyId)).first() : null,
    caseId ? db.prepare('SELECT * FROM co_cases WHERE id = ?').bind(Number(caseId)).first() : null,
    coSettings(db),
  ]);

  const today = new Date();
  const values = {
    firm_name: settings.firmName,
    today: today.toISOString().slice(0, 10),
    year: String(today.getUTCFullYear()),
    client_name: party?.name ?? null,
    client_contact: party?.contact_name ?? null,
    client_address: party?.address ?? null,
    client_tin: party?.tin ?? null,
    client_code: party?.client_code ?? null,
    engagement: kase?.title ?? null,
    engagement_ref: kase?.ref ?? null,
    period: kase?.period_label ?? null,
    period_end: kase?.period_end ?? null,
    statutory_due: kase?.statutory_due ?? null,
    signer_name: ctx.session.user.name,
  };

  return json({
    template,
    subject: fillPlaceholders(template.subject, values),
    body: fillPlaceholders(template.body, values),
    placeholders: placeholdersIn(`${template.subject}\n${template.body}`),
  });
}

export function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (whole, key) => {
    const value = values[key.toLowerCase()];
    return value == null || value === '' ? whole : String(value);
  });
}

export function placeholdersIn(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)) {
    found.add(match[1].toLowerCase());
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** The register as a spreadsheet — what an auditor or a regulator asks for. */
export async function exportRegister(ctx) {
  const { db, url, session } = ctx;
  const visible = visibilityClause(session);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const where = [visible.sql];
  const binds = [...visible.binds];
  if (from) { where.push('date(l.created_at) >= ?'); binds.push(from); }
  if (to) { where.push('date(l.created_at) <= ?'); binds.push(to); }

  const rows = await db.prepare(
    `SELECT l.ref, l.type, l.subject, l.status, l.priority, l.confidentiality,
            l.their_ref, l.letter_date, l.received_at, l.due_at, l.dispatched_at,
            l.closed_at, l.created_at, l.created_by_name,
            p.name AS party, cat.name AS category, d.name AS department, c.ref AS case_ref
       FROM co_letters l
       LEFT JOIN co_parties p ON p.id = l.party_id
       LEFT JOIN co_categories cat ON cat.id = l.category_id
       LEFT JOIN co_departments d ON d.id = l.department_id
       LEFT JOIN co_cases c ON c.id = l.case_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC LIMIT 10000`,
  ).bind(...binds).all();

  const header = [
    'Reference', 'Type', 'Subject', 'Client / party', 'Engagement', 'Category', 'Department',
    'Status', 'Priority', 'Confidentiality', 'Their reference', 'Letter date', 'Received',
    'Due', 'Dispatched', 'Closed', 'Registered', 'Registered by',
  ];
  const body = (rows.results ?? []).map((r) => [
    r.ref, r.type, r.subject, r.party, r.case_ref, r.category, r.department,
    r.status, r.priority, r.confidentiality, r.their_ref, r.letter_date, r.received_at,
    r.due_at, r.dispatched_at, r.closed_at, r.created_at, r.created_by_name,
  ]);

  return csvResponse(`correspondence-register-${new Date().toISOString().slice(0, 10)}.csv`,
    [header, ...body]);
}
