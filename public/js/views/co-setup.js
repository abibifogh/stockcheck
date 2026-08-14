import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, table } from './components.js';
import {
  ACTION_LABEL, TYPE_LABEL, act, dialogActions, field, fmtWhen, modal,
  personOptions, refreshCo, select,
} from './co-common.js';

/**
 * Setting the practice up.
 *
 * Everything here is the sort of thing a firm changes twice a year and then
 * forgets about — which is exactly why it is data rather than code. A firm that
 * needed a deploy to add a department would instead file everything under
 * General for ever.
 */
export async function renderCoSetup() {
  const data = await api.coSetup();
  const host = h('div');
  const reload = async () => { refreshCo(); mount(host, await renderCoSetup()); };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Practice setup'),
        h('div.sub', 'Departments, categories, templates, workflows and who sits where'),
      ),
      h('button.btn-sm', {
        title: 'Run the deadline sweep now instead of waiting for the hour',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const result = await api.coSweepNow();
            toast(result.skipped
              ? 'The sweep is switched off'
              : `${result.reminded} reminded, ${result.escalated} escalated, `
                + `${result.occurrencesCreated} meeting${result.occurrencesCreated === 1 ? '' : 's'} rolled forward`,
            'good');
          } catch (err) {
            toast(err.message, 'bad');
          }
          e.target.disabled = false;
        },
      }, 'Run the sweep now'),
    ),

    settingsCard(data, reload),
    emailCard(data, reload),
    departmentsCard(data, reload),
    categoriesCard(data, reload),
    workflowsCard(data, reload),
    templatesCard(data, reload),
    staffCard(data, reload),
    numberingCard(data),
  );

  return host;
}

// ---------------------------------------------------------------------------

function settingsCard(data, reload) {
  const s = data.settings;
  const firmName = h('input', { value: s.firmName, maxlength: 200 });
  const timezone = h('input', { value: s.timezone, maxlength: 60 });
  const refDigits = h('input', { type: 'number', min: '3', max: '8', value: s.refDigits });
  const defaultDue = h('input', { type: 'number', min: '1', max: '8760', value: s.defaultDueHours });
  const grace = h('input', { type: 'number', min: '0', max: '720', value: s.escalationGrace });
  const lead = h('input', { type: 'number', min: '0', max: '720', value: s.reminderLead });
  const sweep = h('input', { type: 'checkbox', checked: s.sweepEnabled });

  const days = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];
  const dayBoxes = days.map(([n, label]) => {
    const box = h('input', { type: 'checkbox', checked: s.workingDays.includes(n) });
    return { n, el: h('label.inline-check', box, h('span', label)), box };
  });

  return card('The firm', {
    wide: true,
    actions: h('button.btn-sm.btn-primary', {
      onclick: () => act(api.coUpdateSetup({
        firmName: firmName.value.trim(),
        timezone: timezone.value.trim(),
        refDigits: Number(refDigits.value),
        defaultDueHours: Number(defaultDue.value),
        escalationGrace: Number(grace.value),
        reminderLead: Number(lead.value),
        sweepEnabled: sweep.checked,
        workingDays: dayBoxes.filter((d) => d.box.checked).map((d) => d.n),
      }), 'Saved', reload),
    }, 'Save'),
  },
    h('div.field-row',
      field('Firm name', firmName, 'Appears on letters built from a template'),
      field('Time zone', timezone, 'e.g. Africa/Accra'),
      field('Digits in a reference', refDigits, `TAX-2026-${'0'.repeat(Math.max(0, s.refDigits - 1))}7`),
    ),
    h('div.field-row',
      field('Default deadline (hours)', defaultDue, 'When neither the category nor the person sets one'),
      field('Escalate after (hours late)', grace, 'Zero escalates the moment a deadline passes'),
      field('Remind before (hours)', lead, 'How far ahead of a deadline the warning goes out'),
    ),
    field('Working days', h('div.btn-row', ...dayBoxes.map((d) => d.el)),
      'Deadlines set in hours skip the rest — a Friday afternoon deadline lands on Monday'),
    h('label.inline-check', sweep, h('span', 'Run the hourly sweep (reminders, escalations, recurring meetings)')),
  );
}

/**
 * Email.
 *
 * Its own card because it is the one part of setup with an outside dependency,
 * and the one people get wrong. The banner at the top is the honest answer to
 * "will anything actually leave the building" — a firm can tick both switches,
 * fill in a from-address, and still send nothing because no provider key exists
 * on the deployment, which is a Worker secret rather than anything on a screen.
 */
function emailCard(data, reload) {
  const s = data.settings;
  const from = h('input', { type: 'email', value: s.emailFrom, maxlength: 200, placeholder: 'practice@yourfirm.com' });
  const senderName = h('input', { value: s.emailSenderName, maxlength: 120, placeholder: s.firmName });
  const replyTo = h('input', { type: 'email', value: s.emailReplyTo, maxlength: 200, placeholder: 'office@yourfirm.com' });
  const siteUrl = h('input', { value: s.siteUrl, maxlength: 200, placeholder: 'https://cms.yourfirm.com' });
  const toRecipients = h('input', { type: 'checkbox', checked: s.emailRecipients });
  const toStaff = h('input', { type: 'checkbox', checked: s.emailStaff });

  const save = () => act(api.coUpdateSetup({
    emailFrom: from.value.trim(),
    emailSenderName: senderName.value.trim(),
    emailReplyTo: replyTo.value.trim(),
    siteUrl: siteUrl.value.trim().replace(/\/+$/, ''),
    emailRecipients: toRecipients.checked,
    emailStaff: toStaff.checked,
  }), 'Saved', reload);

  const sendTest = async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Sending…';
    try {
      const result = await api.coEmailTest();
      toast(`Sent to ${result.to}. Check your inbox — and the spam folder.`, 'good');
    } catch (err) {
      toast(err.message, 'bad');
    }
    event.target.disabled = false;
    event.target.textContent = 'Send a test to myself';
  };

  return card('Email', {
    wide: true,
    note: 'Signing invitations, reminders to clients who have not signed, and escalations.',
    actions: h('div.btn-row',
      h('button.btn-sm', { onclick: sendTest }, 'Send a test to myself'),
      h('button.btn-sm.btn-primary', { onclick: save }, 'Save'),
    ),
  },
    s.emailConfigured
      ? (s.emailFrom
        ? h('div.alert.good',
          h('span.alert-icon', '✓'),
          h('div',
            h('div.alert-title', 'Email is set up'),
            h('div.alert-detail', `Messages go out from ${s.emailFrom}. Press “Send a test to myself” to prove it.`)))
        : h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Almost there'),
            h('div.alert-detail', 'A provider key is set on this deployment, but no from-address. '
              + 'Fill one in below and save — it has to be an address your domain authorises the provider to send as.'))))
      : h('div.alert.info',
        h('span.alert-icon', 'ℹ️'),
        h('div',
          h('div.alert-title', 'No mail provider on this deployment'),
          h('div.alert-detail',
            'Nothing is emailed. The bell still works, and signing links can still be copied out by '
            + 'hand when a request is sent. To turn email on, add RESEND_API_KEY as a Worker secret — '
            + 'see “Turning email on” in the setup guide.'))),

    h('div.field-row',
      field('From address', from, 'The address your provider is authorised to send as'),
      field('Sender name', senderName, 'What a client sees in their inbox'),
    ),
    h('div.field-row',
      field('Replies go to', replyTo, 'Blank sends replies to the from-address — usually a mailbox nobody watches'),
      field('Site address', siteUrl, 'Every link in every message is built from this'),
    ),

    h('div', { style: { marginTop: '.6rem' } },
      h('label.inline-check', toRecipients,
        h('span', 'Email people outside the firm — signing invitations, reminders, receipts')),
      h('label.inline-check', toStaff,
        h('span', 'Email the firm’s own people — work routed to them, escalations, a client signing or declining')),
    ),

    h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
      'The bell is unaffected by either switch and needs no configuration. Email is the second '
      + 'channel, for the people who do not live in the app — which, on the day something is late, '
      + 'is usually the person you need.'),
  );
}

function departmentsCard(data, reload) {
  return card('Departments', {
    wide: true,
    note: 'A route can go to a department instead of a person. The head is who a late one escalates to.',
    actions: h('button.btn-sm', { onclick: () => openDepartment(null, data, reload) }, '+ Add'),
  }, table([
    { key: 'name', label: 'Department' },
    { key: 'code', label: 'Code', format: (v) => h('code.mono', v) },
    { key: 'head_name', label: 'Head', format: (v) => v ?? h('span.muted', 'nobody set') },
    { key: 'active', label: '', format: (v) => (v ? '' : h('span.pill', 'inactive')) },
    {
      key: 'id',
      label: '',
      align: 'right',
      format: (id, r) => h('button.btn-sm', { onclick: () => openDepartment(r, data, reload) }, 'Edit'),
    },
  ], data.departments, { empty: 'No departments.' }));
}

function openDepartment(department, data, reload) {
  const name = h('input', { value: department?.name ?? '', maxlength: 120 });
  const code = h('input', { value: department?.code ?? '', maxlength: 10, placeholder: 'TAX' });
  const head = select(personOptions(data.staff, { blank: '— nobody —' }), { value: department?.head_user_id ?? '' });
  const order = h('input', { type: 'number', value: department?.sort_order ?? 100 });
  const active = h('input', { type: 'checkbox', checked: department ? Boolean(department.active) : true });

  const dialog = modal(department ? `Edit ${department.name}` : 'Add a department', {},
    field('Name', name),
    h('div.field-row', field('Code', code), field('Order', order)),
    field('Head of department', head, 'Overdue work in this department escalates to them'),
    department ? h('label.inline-check', active, h('span', 'Active')) : null,
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    const body = {
      name: name.value.trim(),
      code: code.value.trim(),
      headUserId: head.value || null,
      sortOrder: Number(order.value) || 100,
      ...(department ? { active: active.checked } : {}),
    };
    if (!body.name || !body.code) throw new Error('A department needs a name and a short code');
    if (department) await api.coUpdateDepartment(department.id, body);
    else await api.coCreateDepartment(body);
    toast('Saved', 'good');
    await reload();
  }));
}

function categoriesCard(data, reload) {
  return card('Categories', {
    wide: true,
    note: 'What a letter is about. Decides its reference prefix, its default deadline, '
      + 'how long it is kept, and which workflow starts on its own.',
    actions: h('button.btn-sm', { onclick: () => openCategory(null, data, reload) }, '+ Add'),
  }, table([
    { key: 'name', label: 'Category' },
    { key: 'prefix', label: 'Prefix', format: (v) => (v ? h('code.mono', v) : h('span.muted', 'by kind')) },
    {
      key: 'default_due_hours',
      label: 'Deadline',
      align: 'right',
      format: (v) => (v ? `${v}h` : h('span.muted', 'default')),
    },
    { key: 'retention_years', label: 'Kept', align: 'right', format: (v) => `${v} yrs` },
    { key: 'workflow_name', label: 'Starts', format: (v) => v ?? h('span.muted', 'nothing') },
    { key: 'active', label: '', format: (v) => (v ? '' : h('span.pill', 'inactive')) },
    {
      key: 'id',
      label: '',
      align: 'right',
      format: (id, r) => h('button.btn-sm', { onclick: () => openCategory(r, data, reload) }, 'Edit'),
    },
  ], data.categories, { empty: 'No categories.' }));
}

function openCategory(category, data, reload) {
  const name = h('input', { value: category?.name ?? '', maxlength: 120 });
  const prefix = h('input', { value: category?.prefix ?? '', maxlength: 8, placeholder: 'TAX' });
  const retention = h('input', { type: 'number', min: '1', max: '50', value: category?.retention_years ?? 6 });
  const due = h('input', { type: 'number', min: '1', max: '8760', value: category?.default_due_hours ?? '' });
  const workflow = select(
    [{ value: '', label: '— none —' }, ...data.workflows.map((w) => ({ value: w.id, label: w.name }))],
    { value: category?.workflow_id ?? '' },
  );
  const order = h('input', { type: 'number', value: category?.sort_order ?? 100 });
  const active = h('input', { type: 'checkbox', checked: category ? Boolean(category.active) : true });

  const dialog = modal(category ? `Edit ${category.name}` : 'Add a category', {},
    field('Name', name),
    h('div.field-row',
      field('Reference prefix', prefix, 'Blank uses the kind: IN, OUT, MEM, CIR'),
      field('Order', order),
    ),
    h('div.field-row',
      field('Default deadline (hours)', due),
      field('Retention (years)', retention, 'How long a file in this category must be kept'),
    ),
    field('Workflow to start', workflow, 'Runs as soon as a letter in this category is registered'),
    category ? h('label.inline-check', active, h('span', 'Active')) : null,
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    const body = {
      name: name.value.trim(),
      prefix: prefix.value.trim() || null,
      retentionYears: Number(retention.value) || 6,
      defaultDueHours: due.value ? Number(due.value) : null,
      workflowId: workflow.value || null,
      sortOrder: Number(order.value) || 100,
      ...(category ? { active: active.checked } : {}),
    };
    if (!body.name) throw new Error('A category needs a name');
    if (category) await api.coUpdateCoCategory(category.id, body);
    else await api.coCreateCoCategory(body);
    toast('Saved', 'good');
    await reload();
  }));
}

function workflowsCard(data, reload) {
  return card('Workflows', {
    wide: true,
    note: 'A workflow is a list of steps. Each opens one route; the next opens when that one closes. '
      + 'A rejection stops the run and sends the letter back to whoever wrote it.',
    actions: h('button.btn-sm', { onclick: () => openWorkflow(null, data, reload) }, '+ Add'),
  },
    data.workflows.length
      ? h('div', data.workflows.map((workflow) => h('div', {
        style: { padding: '.7rem 0', borderTop: '1px solid var(--border)' },
      },
        h('div.btn-row',
          h('b', workflow.name),
          workflow.active ? null : h('span.pill', 'off'),
          workflow.applies_type ? h('span.pill.info', `every ${TYPE_LABEL[workflow.applies_type] ?? workflow.applies_type}`) : null,
          workflow.applies_category_id
            ? h('span.pill.info',
              data.categories.find((c) => c.id === workflow.applies_category_id)?.name ?? 'a category')
            : null,
          h('div', { style: { marginLeft: 'auto' } },
            h('button.btn-sm', { onclick: () => openWorkflow(workflow, data, reload) }, 'Edit'),
            h('button.btn-sm.btn-ghost', {
              onclick: () => {
                if (!window.confirm(`Delete "${workflow.name}"? Letters part-way through it are refused — switch it off instead.`)) return;
                act(api.coDeleteWorkflow(workflow.id), 'Deleted', reload).catch(() => {});
              },
            }, '✕'),
          ),
        ),
        workflow.description ? h('p.muted', { style: { fontSize: '.85rem', margin: '.2rem 0' } }, workflow.description) : null,
        h('ol', { style: { margin: '.3rem 0 0', paddingLeft: '1.2rem', fontSize: '.86rem' } },
          workflow.steps.map((step) => h('li',
            h('b', step.name),
            ` — ${ACTION_LABEL[step.action] ?? step.action}, to `,
            step.to_user_name ?? step.to_department_name ?? `anyone with ${step.to_permission}`,
            h('span.muted', `, ${step.sla_hours}h allowed`),
            step.escalate_to_name ? h('span.muted', `, escalates to ${step.escalate_to_name}`) : null,
          )),
        ),
      )))
      : h('div.empty', h('p', 'No workflows. Letters are routed by hand until you add one.')));
}

function openWorkflow(workflow, data, reload) {
  const name = h('input', { value: workflow?.name ?? '', maxlength: 200 });
  const description = h('textarea', { rows: 2, value: workflow?.description ?? '' });
  const appliesType = select(
    [{ value: '', label: '— not by kind —' },
      ...Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))],
    { value: workflow?.applies_type ?? '' },
  );
  const appliesCategory = select(
    [{ value: '', label: '— not by category —' },
      ...data.categories.map((c) => ({ value: c.id, label: c.name }))],
    { value: workflow?.applies_category_id ?? '' },
  );
  const active = h('input', { type: 'checkbox', checked: workflow ? Boolean(workflow.active) : true });

  const steps = h('div', { style: { display: 'grid', gap: '.6rem' } });

  const addStep = (step = null) => {
    const stepName = h('input', { value: step?.name ?? '', placeholder: 'What this step is', maxlength: 120 });
    const action = select(
      Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label })),
      { value: step?.action ?? 'action' },
    );
    const toUser = select(personOptions(data.staff, { blank: '— a person —' }), { value: step?.to_user_id ?? '' });
    const toDept = select(
      [{ value: '', label: '— or a department —' },
        ...data.departments.map((d) => ({ value: d.id, label: d.name }))],
      { value: step?.to_department_id ?? '' },
    );
    const toPermission = select(
      [{ value: '', label: '— or anyone who… —' },
        ...data.permissions.map((p) => ({ value: p.key, label: p.label }))],
      { value: step?.to_permission ?? '' },
    );
    const sla = h('input', { type: 'number', min: '1', max: '8760', value: step?.sla_hours ?? 48 });
    const escalateTo = select(personOptions(data.staff, { blank: '— head of department —' }),
      { value: step?.escalate_to_user_id ?? '' });
    const instruction = h('input', { value: step?.instruction ?? '', placeholder: 'What to tell them', maxlength: 300 });

    const row = h('div', {
      style: { border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '.6rem' },
    },
      h('div.btn-row',
        h('b', { style: { fontSize: '.85rem' } }, `Step ${steps.children.length + 1}`),
        h('button.btn-sm.btn-ghost', {
          style: { marginLeft: 'auto' },
          onclick: () => row.remove(),
        }, '✕'),
      ),
      h('div.field-row', field('Name', stepName), field('Asking for', action), field('Hours allowed', sla)),
      h('div.field-row', field('To a person', toUser), field('Or a department', toDept), field('Or anyone who…', toPermission)),
      h('div.field-row', field('Escalates to', escalateTo), field('Instruction', instruction)),
    );
    row.fields = { stepName, action, toUser, toDept, toPermission, sla, escalateTo, instruction };
    steps.append(row);
  };

  (workflow?.steps ?? []).forEach((step) => addStep(step));
  if (!workflow?.steps?.length) addStep();

  const dialog = modal(workflow ? `Edit ${workflow.name}` : 'Add a workflow', { width: '860px' },
    field('Name', name),
    field('What it is for', description),
    h('div.field-row',
      field('Starts automatically for', appliesType),
      field('…or for this category', appliesCategory, 'Category wins where both are set'),
    ),
    workflow ? h('label.inline-check', active, h('span', 'Active')) : null,
    field('Steps', h('div', steps,
      h('button.btn-sm', { style: { marginTop: '.5rem' }, onclick: () => addStep() }, '+ Add a step'))),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Saving replaces every step. Letters already part-way through keep their step number and '
      + 'carry on against the new list — a firm that reorders its approvals means it from now on, '
      + 'not retrospectively.'),
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    const body = {
      name: name.value.trim(),
      description: description.value.trim(),
      appliesType: appliesType.value || null,
      appliesCategoryId: appliesCategory.value || null,
      active: workflow ? active.checked : true,
      steps: [...steps.children].map((row) => ({
        name: row.fields.stepName.value.trim(),
        action: row.fields.action.value,
        toUserId: row.fields.toUser.value || null,
        toDepartmentId: row.fields.toUser.value ? null : (row.fields.toDept.value || null),
        toPermission: row.fields.toUser.value || row.fields.toDept.value
          ? null : (row.fields.toPermission.value || null),
        slaHours: Number(row.fields.sla.value) || 48,
        escalateToUserId: row.fields.escalateTo.value || null,
        instruction: row.fields.instruction.value.trim() || null,
      })).filter((step) => step.name),
    };
    if (!body.name) throw new Error('A workflow needs a name');
    if (!body.steps.length) throw new Error('A workflow with no steps would leave a letter with nobody holding it');
    await api.coSaveWorkflow(workflow?.id ?? null, body);
    toast('Saved', 'good');
    await reload();
  }));
}

function templatesCard(data, reload) {
  return card('Templates', {
    wide: true,
    note: 'Placeholders are {{double_braced}} and filled from the client, the engagement and today’s '
      + 'date. Anything the system cannot fill is left on the page rather than blanked.',
    actions: h('button.btn-sm', { onclick: () => openTemplate(null, data, reload) }, '+ Add'),
  }, table([
    { key: 'name', label: 'Template' },
    { key: 'type', label: 'Kind', format: (v) => h('span.pill', TYPE_LABEL[v] ?? v) },
    { key: 'subject', label: 'Subject line' },
    { key: 'active', label: '', format: (v) => (v ? '' : h('span.pill', 'inactive')) },
    {
      key: 'id',
      label: '',
      align: 'right',
      format: (id, r) => h('div.btn-row', { style: { justifyContent: 'flex-end' } },
        h('button.btn-sm', { onclick: () => openTemplate(r, data, reload) }, 'Edit'),
        h('button.btn-sm.btn-ghost', {
          onclick: () => {
            if (!window.confirm(`Delete the "${r.name}" template?`)) return;
            act(api.coDeleteTemplate(id), 'Deleted', reload).catch(() => {});
          },
        }, '✕'),
      ),
    },
  ], data.templates, { empty: 'No templates yet.' }));
}

function openTemplate(template, data, reload) {
  const name = h('input', { value: template?.name ?? '', maxlength: 200 });
  const type = select(
    Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })),
    { value: template?.type ?? 'outgoing' },
  );
  const category = select(
    [{ value: '', label: '— none —' }, ...data.categories.map((c) => ({ value: c.id, label: c.name }))],
    { value: template?.category_id ?? '' },
  );
  const subject = h('input', { value: template?.subject ?? '', maxlength: 300 });
  const body = h('textarea', { rows: 16, value: template?.body ?? '' });
  const note = h('input', { value: template?.note ?? '', maxlength: 200 });
  const active = h('input', { type: 'checkbox', checked: template ? Boolean(template.active) : true });

  const dialog = modal(template ? `Edit ${template.name}` : 'Add a template', { width: '800px' },
    h('div.field-row', field('Name', name), field('Kind', type), field('Category', category)),
    field('Subject', subject),
    field('Body', body),
    field('Note for whoever uses it', note),
    template ? h('label.inline-check', active, h('span', 'Active')) : null,
    h('div', { style: { fontSize: '.82rem' } },
      h('p.muted', { style: { marginBottom: '.3rem' } }, 'Placeholders filled from the client:'),
      h('p.mono', { style: { marginTop: 0 } },
        '{{client_name}} {{client_contact}} {{client_address}} {{client_tin}} {{client_code}}'),
      h('p.muted', { style: { marginBottom: '.3rem' } }, 'From the engagement:'),
      h('p.mono', { style: { marginTop: 0 } },
        '{{engagement}} {{engagement_ref}} {{period}} {{period_end}} {{statutory_due}}'),
      h('p.muted', { style: { marginBottom: '.3rem' } },
        'From the letter being answered, when the template is opened on a reply:'),
      h('p.mono', { style: { marginTop: 0 } },
        '{{their_ref}} {{our_ref}} {{their_subject}} {{their_date}}'),
      h('p.muted', { style: { marginBottom: '.3rem' } }, 'Always available:'),
      h('p.mono', { style: { marginTop: 0 } }, '{{firm_name}} {{signer_name}} {{today}} {{year}}'),
      h('p.muted', { style: { marginBottom: 0 } },
        'Anything the system cannot fill is left on the page as a prompt rather than blanked — '
        + 'a gap in a letter that went out is worse than a placeholder somebody has to notice.')),
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    const payload = {
      name: name.value.trim(),
      type: type.value,
      categoryId: category.value || null,
      subject: subject.value.trim(),
      body: body.value,
      note: note.value.trim(),
      ...(template ? { active: active.checked } : {}),
    };
    if (!payload.name || !payload.subject || !payload.body) {
      throw new Error('A template needs a name, a subject and a body');
    }
    if (template) await api.coUpdateTemplate(template.id, payload);
    else await api.coCreateTemplate(payload);
    toast('Saved', 'good');
    await reload();
  }));
}

function staffCard(data, reload) {
  return card('People', {
    wide: true,
    note: 'Where somebody sits, what appears under their signature, and who covers them while they '
      + 'are away. Accounts themselves are managed under Users & data.',
  }, table([
    { key: 'name', label: 'Person', format: (name, r) => h('div', h('div', name), h('small.muted', r.role)) },
    { key: 'department_name', label: 'Department', format: (v) => v ?? h('span.muted', 'none') },
    { key: 'title', label: 'Title', format: (v) => v ?? h('span.muted', '—') },
    { key: 'signature_name', label: 'Signs as', format: (v, r) => v ?? h('span.muted', r.name) },
    {
      key: 'away_until',
      label: 'Away',
      format: (until, r) => (until && new Date(until) > new Date()
        ? h('div',
          h('span.pill.warn', `until ${fmtWhen(until)}`),
          r.delegate_name ? h('div', h('small.muted', `covered by ${r.delegate_name}`)) : null)
        : h('span.muted', '—')),
    },
    {
      key: 'id',
      label: '',
      align: 'right',
      format: (id, r) => h('button.btn-sm', { onclick: () => openStaff(r, data, reload) }, 'Edit'),
    },
  ], data.staff, { empty: 'Nobody has an account yet.' }));
}

function openStaff(person, data, reload) {
  const department = select(
    [{ value: '', label: '— none —' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))],
    { value: person.department_id ?? '' },
  );
  const title = h('input', { value: person.title ?? '', maxlength: 120, placeholder: 'e.g. FCCA, Audit Manager' });
  const signatureName = h('input', { value: person.signature_name ?? '', maxlength: 200, placeholder: person.name });
  const awayUntil = h('input', { type: 'date', value: (person.away_until ?? '').slice(0, 10) });
  const delegate = select(
    personOptions(data.staff.filter((s) => s.id !== person.id), { blank: '— nobody —' }),
    { value: person.delegate_user_id ?? '' },
  );

  const dialog = modal(person.name, {},
    h('div.field-row', field('Department', department), field('Title', title)),
    field('Signs as', signatureName, 'What appears under a signature on a letter'),
    h('div.field-row',
      field('Away until', awayUntil),
      field('Covered by', delegate, 'They see this person’s work and hear about it going late'),
    ),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Nothing is reassigned while somebody is away. The work stays theirs; their cover can simply '
      + 'see it and act on it, which is what stops a week of leave turning into a week of silence.'),
  );

  dialog.append(dialogActions(dialog, 'Save', async () => {
    await api.coSaveStaff(person.id, {
      departmentId: department.value || null,
      title: title.value.trim(),
      signatureName: signatureName.value.trim(),
      awayUntil: awayUntil.value ? `${awayUntil.value}T23:59:59Z` : null,
      delegateUserId: delegate.value || null,
    });
    toast('Saved', 'good');
    await reload();
  }));
}

function numberingCard(data) {
  return card('The reference register', {
    wide: true,
    note: 'One counter per prefix per year. Numbers are issued when a letter is logged and never '
      + 'reused — a gap is a question with an answer, a repeat is two letters filed as one.',
  }, table([
    { key: 'prefix', label: 'Prefix', format: (v) => h('code.mono', v) },
    { key: 'year', label: 'Year' },
    { key: 'next', label: 'Next number', align: 'right' },
    {
      key: 'next',
      label: 'Which will be',
      align: 'right',
      format: (next, r) => h('code.mono',
        `${r.prefix}-${r.year}-${String(next).padStart(data.settings.refDigits, '0')}`),
    },
  ], data.numbering, { empty: 'Nothing has been registered yet.' }));
}
