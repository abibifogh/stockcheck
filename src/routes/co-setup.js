/**
 * Setting the practice up: departments, categories, templates, workflows, and
 * who sits where.
 *
 * Everything here is the sort of thing a firm changes twice a year and then
 * forgets about — which is exactly why it is data rather than code. A firm that
 * needs a deploy to add "Company Secretarial" to its departments will instead
 * file everything under General for ever.
 */

import { badRequest, bool, int, json, notFound, readJson, str } from '../lib/http.js';
import { ACTION_KEYS, TYPE_KEYS, coSettings } from '../lib/correspondence.js';
import { PERMISSIONS } from '../lib/permissions.js';
import { runSweep } from '../lib/co-workflow.js';
import { emailPeople } from '../lib/co-email.js';

// ---------------------------------------------------------------------------
// Everything, in one call
// ---------------------------------------------------------------------------

export async function setup(ctx) {
  const { db } = ctx;
  const settings = await coSettings(db);

  const [departments, categories, templates, workflows, steps, staff, numbering] = await Promise.all([
    db.prepare(`SELECT d.*, u.name AS head_name FROM co_departments d
                  LEFT JOIN users u ON u.id = d.head_user_id ORDER BY d.sort_order, d.name`).all(),
    db.prepare(`SELECT c.*, w.name AS workflow_name FROM co_categories c
                  LEFT JOIN co_workflows w ON w.id = c.workflow_id ORDER BY c.sort_order, c.name`).all(),
    db.prepare('SELECT * FROM co_templates ORDER BY name').all(),
    db.prepare('SELECT * FROM co_workflows ORDER BY name').all(),
    db.prepare(`SELECT s.*, u.name AS to_user_name, d.name AS to_department_name,
                       e.name AS escalate_to_name
                  FROM co_workflow_steps s
                  LEFT JOIN users u ON u.id = s.to_user_id
                  LEFT JOIN co_departments d ON d.id = s.to_department_id
                  LEFT JOIN users e ON e.id = s.escalate_to_user_id
                 ORDER BY s.workflow_id, s.seq`).all(),
    db.prepare(`SELECT u.id, u.name, u.role, u.email, s.department_id, s.title,
                       s.signature_name, s.away_until, s.delegate_user_id,
                       d.name AS department_name, g.name AS delegate_name
                  FROM users u
                  LEFT JOIN co_staff s ON s.user_id = u.id
                  LEFT JOIN co_departments d ON d.id = s.department_id
                  LEFT JOIN users g ON g.id = s.delegate_user_id
                 WHERE u.active = 1 ORDER BY u.name`).all(),
    db.prepare('SELECT * FROM co_numbering ORDER BY year DESC, prefix').all(),
  ]);

  return json({
    settings: {
      firmName: settings.firmName,
      refDigits: settings.refDigits,
      escalationGrace: settings.escalationGrace,
      reminderLead: settings.reminderLead,
      defaultDueHours: settings.defaultDueHours,
      workingDays: [...settings.workingDays].sort(),
      sweepEnabled: settings.sweepEnabled,
      timezone: settings.timezone,
      // Email. `configured` is the server's answer to "will anything actually
      // leave the building" — the two switches below it are only what the firm
      // wants, and a firm that has ticked both and set no provider key would
      // otherwise sit waiting for messages that were never going to arrive.
      emailConfigured: Boolean(ctx.env.RESEND_API_KEY),
      emailFrom: settings.raw.email_from ?? '',
      emailSenderName: settings.raw.co_email_sender_name ?? '',
      emailReplyTo: settings.raw.co_email_reply_to ?? '',
      emailRecipients: settings.raw.co_email_recipients !== '0',
      emailStaff: settings.raw.co_email_staff !== '0',
      siteUrl: settings.raw.site_url ?? '',
    },
    departments: departments.results ?? [],
    categories: categories.results ?? [],
    templates: templates.results ?? [],
    workflows: (workflows.results ?? []).map((w) => ({
      ...w,
      steps: (steps.results ?? []).filter((s) => s.workflow_id === w.id),
    })),
    staff: staff.results ?? [],
    numbering: numbering.results ?? [],
    // The permission keys a workflow step may address, so the form offers the
    // real list rather than a hand-typed one that drifts out of date.
    permissions: PERMISSIONS.filter((p) => p.key.startsWith('co_')),
    actions: ACTION_KEYS,
    types: TYPE_KEYS,
  });
}

export async function updateSettings(ctx) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const writes = [];

  const put = (key, value) => writes.push(
    db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2')
      .bind(key, String(value)),
  );

  if (body.firmName !== undefined) put('co_firm_name', str(body.firmName, 'Firm name', { required: true, max: 200 }));
  if (body.refDigits !== undefined) put('co_ref_digits', int(body.refDigits, 'Reference digits', { min: 3, max: 8 }));
  if (body.escalationGrace !== undefined) put('co_escalation_grace', int(body.escalationGrace, 'Escalation grace', { min: 0, max: 720 }));
  if (body.reminderLead !== undefined) put('co_reminder_lead', int(body.reminderLead, 'Reminder lead', { min: 0, max: 720 }));
  if (body.defaultDueHours !== undefined) put('co_default_due_hours', int(body.defaultDueHours, 'Default deadline', { min: 1, max: 8760 }));
  if (body.sweepEnabled !== undefined) put('co_sweep_enabled', bool(body.sweepEnabled, true) ? '1' : '0');
  if (body.timezone !== undefined) put('timezone', str(body.timezone, 'Time zone', { required: true, max: 60 }));

  // Email. `site_url` lives here rather than under notifications because every
  // link in every message is built from it, and a message whose button goes
  // nowhere is worse than no message.
  if (body.siteUrl !== undefined) put('site_url', str(body.siteUrl, 'Site address', { max: 200 }) ?? '');
  if (body.emailFrom !== undefined) {
    const from = str(body.emailFrom, 'From address', { max: 200 }) ?? '';
    if (from && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(from.replace(/^.*<|>$/g, ''))) {
      throw badRequest('That does not look like an email address');
    }
    put('email_from', from);
  }
  if (body.emailSenderName !== undefined) put('co_email_sender_name', str(body.emailSenderName, 'Sender name', { max: 120 }) ?? '');
  if (body.emailReplyTo !== undefined) {
    const replyTo = str(body.emailReplyTo, 'Reply-to', { max: 200 }) ?? '';
    if (replyTo && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(replyTo)) {
      throw badRequest('That reply-to does not look like an email address');
    }
    put('co_email_reply_to', replyTo);
  }
  if (body.emailRecipients !== undefined) put('co_email_recipients', bool(body.emailRecipients, true) ? '1' : '0');
  if (body.emailStaff !== undefined) put('co_email_staff', bool(body.emailStaff, true) ? '1' : '0');

  if (body.workingDays !== undefined) {
    const days = (Array.isArray(body.workingDays) ? body.workingDays : [])
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (!days.length) throw badRequest('At least one day has to be a working day');
    put('co_working_days', [...new Set(days)].sort().join(','));
  }

  if (!writes.length) return json({ ok: true, unchanged: true });
  await db.batch(writes);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function createDepartment(ctx) {
  const body = await readJson(ctx.request);
  const row = await ctx.db.prepare(
    `INSERT INTO co_departments (name, code, head_user_id, sort_order)
     VALUES (?1, ?2, ?3, ?4) RETURNING *`,
  ).bind(
    str(body.name, 'Name', { required: true, max: 120 }),
    str(body.code, 'Code', { required: true, max: 10 }).toUpperCase(),
    body.headUserId ? int(body.headUserId, 'Head') : null,
    int(body.sortOrder ?? 100, 'Order', { fallback: 100 }),
  ).first().catch((err) => {
    if (/UNIQUE/i.test(String(err))) throw badRequest('There is already a department with that name or code');
    throw err;
  });
  return json({ ok: true, department: row }, { status: 201 });
}

export async function updateDepartment(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`); binds.push(value);
  };

  if (body.name !== undefined) set('name', str(body.name, 'Name', { required: true, max: 120 }));
  if (body.code !== undefined) set('code', str(body.code, 'Code', { required: true, max: 10 }).toUpperCase());
  if (body.headUserId !== undefined) set('head_user_id', body.headUserId ? int(body.headUserId, 'Head') : null);
  if (body.sortOrder !== undefined) set('sort_order', int(body.sortOrder, 'Order'));
  if (body.active !== undefined) set('active', bool(body.active, true) ? 1 : 0);

  if (!fields.length) return json({ ok: true, unchanged: true });
  await ctx.db.prepare(`UPDATE co_departments SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createCategory(ctx) {
  const body = await readJson(ctx.request);
  const row = await ctx.db.prepare(
    `INSERT INTO co_categories (name, prefix, retention_years, workflow_id, default_due_hours, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *`,
  ).bind(
    str(body.name, 'Name', { required: true, max: 120 }),
    body.prefix ? str(body.prefix, 'Prefix', { max: 8 }).toUpperCase() : null,
    int(body.retentionYears ?? 6, 'Retention', { min: 1, max: 50, fallback: 6 }),
    body.workflowId ? int(body.workflowId, 'Workflow') : null,
    body.defaultDueHours ? int(body.defaultDueHours, 'Deadline', { min: 1, max: 8760 }) : null,
    int(body.sortOrder ?? 100, 'Order', { fallback: 100 }),
  ).first().catch((err) => {
    if (/UNIQUE/i.test(String(err))) throw badRequest('There is already a category with that name');
    throw err;
  });
  return json({ ok: true, category: row }, { status: 201 });
}

export async function updateCategory(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`); binds.push(value);
  };

  if (body.name !== undefined) set('name', str(body.name, 'Name', { required: true, max: 120 }));
  if (body.prefix !== undefined) set('prefix', body.prefix ? str(body.prefix, 'Prefix', { max: 8 }).toUpperCase() : null);
  if (body.retentionYears !== undefined) set('retention_years', int(body.retentionYears, 'Retention', { min: 1, max: 50 }));
  if (body.workflowId !== undefined) set('workflow_id', body.workflowId ? int(body.workflowId, 'Workflow') : null);
  if (body.defaultDueHours !== undefined) {
    set('default_due_hours', body.defaultDueHours ? int(body.defaultDueHours, 'Deadline', { min: 1, max: 8760 }) : null);
  }
  if (body.sortOrder !== undefined) set('sort_order', int(body.sortOrder, 'Order'));
  if (body.active !== undefined) set('active', bool(body.active, true) ? 1 : 0);

  if (!fields.length) return json({ ok: true, unchanged: true });
  await ctx.db.prepare(`UPDATE co_categories SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function createTemplate(ctx) {
  const body = await readJson(ctx.request);
  const type = str(body.type, 'Type', { max: 20, fallback: 'outgoing' });
  if (!TYPE_KEYS.includes(type)) throw badRequest('That is not a kind of correspondence');

  const row = await ctx.db.prepare(
    `INSERT INTO co_templates (name, type, category_id, subject, body, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *`,
  ).bind(
    str(body.name, 'Name', { required: true, max: 200 }),
    type,
    body.categoryId ? int(body.categoryId, 'Category') : null,
    str(body.subject, 'Subject', { required: true, max: 300 }),
    str(body.body, 'Body', { required: true, max: 60_000 }),
    str(body.note, 'Note', { max: 1000 }),
  ).first().catch((err) => {
    if (/UNIQUE/i.test(String(err))) throw badRequest('There is already a template with that name');
    throw err;
  });
  return json({ ok: true, template: row }, { status: 201 });
}

export async function updateTemplate(ctx, id) {
  const body = await readJson(ctx.request);
  const fields = [];
  const binds = [];
  const set = (column, value) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`); binds.push(value);
  };

  if (body.name !== undefined) set('name', str(body.name, 'Name', { required: true, max: 200 }));
  if (body.subject !== undefined) set('subject', str(body.subject, 'Subject', { required: true, max: 300 }));
  if (body.body !== undefined) set('body', str(body.body, 'Body', { required: true, max: 60_000 }));
  if (body.note !== undefined) set('note', str(body.note, 'Note', { max: 1000 }));
  if (body.categoryId !== undefined) set('category_id', body.categoryId ? int(body.categoryId, 'Category') : null);
  if (body.active !== undefined) set('active', bool(body.active, true) ? 1 : 0);
  if (body.type !== undefined) {
    const type = str(body.type, 'Type', { required: true, max: 20 });
    if (!TYPE_KEYS.includes(type)) throw badRequest('That is not a kind of correspondence');
    set('type', type);
  }

  if (!fields.length) return json({ ok: true, unchanged: true });
  await ctx.db.prepare(`UPDATE co_templates SET ${fields.join(', ')} WHERE id = ?`)
    .bind(...binds, Number(id)).run();
  return json({ ok: true });
}

export async function deleteTemplate(ctx, id) {
  await ctx.db.prepare('DELETE FROM co_templates WHERE id = ?').bind(Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * Save a workflow and all of its steps in one go.
 *
 * The steps are replaced rather than merged. A workflow is an ordered list, and
 * "step 3 now comes before step 2" is not expressible as a set of edits without
 * inventing an ordering protocol that the form would then have to obey.
 *
 * Runs already in flight are untouched: they hold their step number, and the
 * next step they look for is whatever the workflow says by then. That is the
 * honest behaviour — a firm that reorders its approvals means it from now on,
 * not retrospectively for letters halfway through.
 */
export async function saveWorkflow(ctx, id) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 200 });

  const appliesType = body.appliesType ? str(body.appliesType, 'Applies to', { max: 20 }) : null;
  if (appliesType && !TYPE_KEYS.includes(appliesType)) throw badRequest('That is not a kind of correspondence');

  let workflowId = id ? Number(id) : null;

  if (workflowId) {
    const existing = await db.prepare('SELECT id FROM co_workflows WHERE id = ?').bind(workflowId).first();
    if (!existing) throw notFound('That workflow could not be found');
    await db.prepare(
      `UPDATE co_workflows SET name = ?, description = ?, applies_type = ?,
              applies_category_id = ?, active = ? WHERE id = ?`,
    ).bind(
      name,
      str(body.description, 'Description', { max: 2000 }),
      appliesType,
      body.appliesCategoryId ? int(body.appliesCategoryId, 'Category') : null,
      bool(body.active, true) ? 1 : 0,
      workflowId,
    ).run();
  } else {
    const created = await db.prepare(
      `INSERT INTO co_workflows (name, description, applies_type, applies_category_id, active)
       VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
    ).bind(
      name,
      str(body.description, 'Description', { max: 2000 }),
      appliesType,
      body.appliesCategoryId ? int(body.appliesCategoryId, 'Category') : null,
      bool(body.active, true) ? 1 : 0,
    ).first().catch((err) => {
      if (/UNIQUE/i.test(String(err))) throw badRequest('There is already a workflow with that name');
      throw err;
    });
    workflowId = created.id;
  }

  const steps = Array.isArray(body.steps) ? body.steps.slice(0, 30) : [];
  if (steps.length) {
    const statements = [db.prepare('DELETE FROM co_workflow_steps WHERE workflow_id = ?').bind(workflowId)];

    steps.forEach((step, index) => {
      const action = str(step.action, 'Action', { max: 20, fallback: 'action' });
      if (!ACTION_KEYS.includes(action)) throw badRequest(`Step ${index + 1}: that is not something you can ask for`);

      const toUser = step.toUserId ? Number(step.toUserId) : null;
      const toDept = step.toDepartmentId ? Number(step.toDepartmentId) : null;
      const toPermission = str(step.toPermission, 'Permission', { max: 40 });
      if (!toUser && !toDept && !toPermission) {
        throw badRequest(`Step ${index + 1} has nobody to go to. Name a person, a department, or a permission.`);
      }

      statements.push(db.prepare(
        `INSERT INTO co_workflow_steps
           (workflow_id, seq, name, action, to_user_id, to_department_id, to_permission,
            sla_hours, escalate_after_hours, escalate_to_user_id, instruction)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        workflowId,
        index + 1,
        str(step.name, 'Step name', { required: true, max: 120 }),
        action,
        toUser, toDept, toPermission,
        int(step.slaHours ?? 48, 'Hours allowed', { min: 1, max: 8760, fallback: 48 }),
        step.escalateAfterHours ? int(step.escalateAfterHours, 'Escalate after', { min: 1, max: 8760 }) : null,
        step.escalateToUserId ? Number(step.escalateToUserId) : null,
        str(step.instruction, 'Instruction', { max: 2000 }),
      ));
    });

    await db.batch(statements);
  }

  return json({ ok: true, id: workflowId }, { status: id ? 200 : 201 });
}

export async function deleteWorkflow(ctx, id) {
  const { db } = ctx;
  const running = await db.prepare(
    "SELECT COUNT(*) AS n FROM co_workflow_runs WHERE workflow_id = ? AND status = 'running'",
  ).bind(Number(id)).first();
  if (Number(running?.n ?? 0) > 0) {
    throw badRequest(
      `${running.n} letter(s) are part-way through this workflow. `
      + 'Switch it off instead — that stops it starting on anything new and lets those finish.',
    );
  }
  await db.prepare('DELETE FROM co_workflows WHERE id = ?').bind(Number(id)).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Staff profiles
// ---------------------------------------------------------------------------

/** Where somebody sits, what goes under their signature, and who covers them. */
export async function saveStaff(ctx, userId) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const uid = Number(userId);

  const user = await db.prepare('SELECT id FROM users WHERE id = ?').bind(uid).first();
  if (!user) throw notFound('That person could not be found');

  const delegate = body.delegateUserId ? int(body.delegateUserId, 'Delegate') : null;
  if (delegate === uid) throw badRequest('Somebody cannot be their own cover');

  await db.prepare(
    `INSERT INTO co_staff (user_id, department_id, title, signature_name, away_until, delegate_user_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET
       department_id    = excluded.department_id,
       title            = excluded.title,
       signature_name   = excluded.signature_name,
       away_until       = excluded.away_until,
       delegate_user_id = excluded.delegate_user_id`,
  ).bind(
    uid,
    body.departmentId ? int(body.departmentId, 'Department') : null,
    str(body.title, 'Title', { max: 120 }),
    str(body.signatureName, 'Signature name', { max: 200 }),
    str(body.awayUntil, 'Away until', { max: 30 }),
    delegate,
  ).run();

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The sweep, by hand
// ---------------------------------------------------------------------------

/**
 * Run the deadline sweep now rather than waiting for the cron.
 *
 * Here because the cron is invisible: somebody who has just set up escalation
 * needs a way to see it work that does not involve waiting until tomorrow
 * morning and hoping. Everything it does is idempotent, so pressing it twice is
 * the same as pressing it once.
 */
export async function sweepNow(ctx) {
  const result = await runSweep(ctx.db, ctx.env, new Date());
  return json({ ok: true, ...result });
}

/**
 * Send a test message to whoever asked for it.
 *
 * To the person pressing the button and nowhere else. A test that goes to the
 * whole firm is a test nobody presses twice, and the question being answered is
 * only ever "does anything leave the building at all".
 */
export async function emailTest(ctx) {
  const { db, env, session } = ctx;

  if (!session.user.email) {
    throw badRequest(
      'Your own account has no email address, so there is nowhere to send a test. '
      + 'Add one under Users & data first.',
    );
  }
  if (!env.RESEND_API_KEY) {
    throw badRequest(
      'No mail provider key is set on this deployment. '
      + 'Add RESEND_API_KEY as a Worker secret — see “Turning email on” in the setup guide.',
    );
  }

  const settings = await coSettings(db);
  if (!settings.raw.email_from?.trim()) {
    throw badRequest('Set a from address above and save before sending a test.');
  }

  const result = await emailPeople(db, env, {
    kind: 'co_email_test',
    userIds: [session.user.id],
    subject: 'Test message from the correspondence register',
    heading: 'Email is working',
    lead: `Sent by ${session.user.name} from Practice setup. If you can read this, `
      + 'signing invitations, reminders and escalations will reach people the same way.',
    link: '/#/co-mine',
    linkLabel: 'Open the register',
  });

  if (!result.sent) {
    throw badRequest(
      result.reason === 'switched off'
        ? 'Email to the firm is switched off above. Turn it on and save first.'
        : `The provider refused it: ${result.reason ?? 'no reason given'}`,
    );
  }

  return json({ ok: true, to: session.user.email });
}
