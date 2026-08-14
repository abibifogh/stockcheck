import { api } from '../api.js';
import { navigate } from '../app.js';
import { h, toast } from '../util.js';
import {
  TYPE_LABEL, caseOptions, co, dialogActions, field, inHours, modal,
  partyOptions, refreshCo, select, toStamp,
} from './co-common.js';

/**
 * Registering a letter.
 *
 * One dialog for all four kinds, because the fields barely differ and four
 * near-identical forms is four places for them to drift apart. What does differ
 * is what the form leads with: an incoming letter asks who it came from and
 * when it arrived, an outgoing one asks who it is going to and offers the
 * templates.
 *
 * The deadline is filled in for you from the category, and can be overridden.
 * A field that starts empty is a field most letters go out without.
 */
export async function openCompose({ boot = null, type = 'incoming', caseId = null, replyTo = null } = {}) {
  const data = boot ?? await co();

  let kind = type;
  const subject = h('input', { placeholder: 'What the letter is about', maxlength: 300 });
  const body = h('textarea', { rows: 12, placeholder: 'The text of the letter, or a note of what it said' });
  const summary = h('input', { placeholder: 'One line for the register (optional)', maxlength: 200 });
  const theirRef = h('input', { placeholder: 'Their reference, from their letterhead', maxlength: 100 });
  const letterDate = h('input', { type: 'date' });
  const dueAt = h('input', { type: 'datetime-local' });

  const party = select(partyOptions(data.parties), {});
  const kase = select(caseOptions(data.cases), { value: caseId ?? '' });
  const category = select(
    [{ value: '', label: '— none —' }, ...data.categories.map((c) => ({ value: c.id, label: c.name }))],
    {
      onchange: (value) => {
        // The category decides the deadline unless somebody has already set
        // one by hand. Overwriting a typed date would be the form arguing with
        // the person filling it in.
        const chosen = data.categories.find((c) => String(c.id) === String(value));
        const hours = chosen?.default_due_hours ?? data.settings.defaultDueHours;
        if (!dueAt.dataset.touched) dueAt.value = inHours(hours);
      },
    },
  );
  dueAt.addEventListener('input', () => { dueAt.dataset.touched = '1'; });
  dueAt.value = inHours(data.settings.defaultDueHours);

  const department = select(
    [{ value: '', label: '— none —' }, ...data.departments.map((d) => ({ value: d.id, label: d.name }))],
    { value: data.user.departmentId ?? '' },
  );
  const priority = select(
    [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]
      .map(([value, label]) => ({ value, label })),
    { value: 'normal' },
  );
  const channel = select(
    [{ value: '', label: '— not recorded —' },
      ...['email', 'post', 'courier', 'hand', 'fax', 'portal']
        .map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) }))],
    { value: 'email' },
  );
  const confidentiality = select(
    [['normal', 'Normal'], ['confidential', 'Confidential'],
      ...(data.permissions.includes('co_oversight') ? [['restricted', 'Restricted — partners only']] : [])]
      .map(([value, label]) => ({ value, label })),
    { value: 'normal' },
  );

  const workflow = select(
    [{ value: '', label: 'Whatever the category says' },
      { value: 'none', label: 'None — I will route it myself' },
      ...data.workflows.map((w) => ({ value: w.id, label: w.name }))],
    {},
  );

  const templatePicker = select(
    [{ value: '', label: '— start from a template —' },
      ...data.templates.map((t) => ({ value: t.id, label: t.name }))],
    {
      onchange: async (value) => {
        if (!value) return;
        try {
          const rendered = await api.coRenderTemplate(value, {
            party: party.value || undefined,
            case: kase.value || undefined,
            // When this is a reply, the template can quote their reference back
            // at them without anybody retyping it.
            letter: replyTo ?? undefined,
          });
          subject.value = rendered.subject;
          body.value = rendered.body;
          const unfilled = rendered.body.match(/\{\{\s*[a-z0-9_]+\s*\}\}/gi);
          if (unfilled?.length) {
            toast(`${unfilled.length} placeholder${unfilled.length === 1 ? '' : 's'} left to fill in`, '');
          }
        } catch (err) {
          toast(err.message, 'bad');
        }
      },
    },
  );

  // The type switch rebuilds only the labels that actually change, so switching
  // does not throw away anything already typed.
  const incomingOnly = h('div');
  const outgoingOnly = h('div');
  const applyKind = () => {
    incomingOnly.style.display = kind === 'incoming' ? '' : 'none';
    outgoingOnly.style.display = kind === 'outgoing' ? '' : 'none';
  };

  const typeSeg = h('div.seg',
    ...Object.entries(TYPE_LABEL).map(([value, label]) => {
      const button = h('button', {
        class: value === kind ? 'active' : '',
        onclick: () => {
          kind = value;
          [...typeSeg.children].forEach((c) => c.classList.toggle('active', c === button));
          applyKind();
        },
      }, label);
      return button;
    }),
  );

  const receivedAt = h('input', { type: 'datetime-local', value: inHours(0) });
  incomingOnly.append(
    field('Received on', receivedAt),
    field('Their reference', theirRef),
  );
  outgoingOnly.append(field('Start from a template', templatePicker));
  applyKind();

  const dialog = modal('Register correspondence', { width: '760px' },
    field('Kind', typeSeg),
    h('div.field-row',
      field('Client or other party', party),
      field('Engagement', kase),
    ),
    field('Subject', subject),
    incomingOnly,
    outgoingOnly,
    field('The letter', body),
    field('One-line summary', summary),
    h('div.field-row',
      field('Category', category),
      field('Department', department),
      field('Date on the letter', letterDate),
    ),
    h('div.field-row',
      field('Priority', priority),
      field('Channel', channel),
      field('Confidentiality', confidentiality),
    ),
    h('div.field-row',
      field('Deadline', dueAt, 'Working hours only — a Friday afternoon deadline lands on Monday'),
      field('Workflow', workflow, 'Starts as soon as it is registered'),
    ),
  );

  dialog.append(dialogActions(dialog, 'Register it', async () => {
    if (!subject.value.trim()) throw new Error('A letter needs a subject — it is what the register shows');

    const created = await api.coCreateLetter({
      type: kind,
      subject: subject.value.trim(),
      body: body.value.trim() || undefined,
      summary: summary.value.trim() || undefined,
      partyId: party.value || undefined,
      caseId: kase.value || undefined,
      categoryId: category.value || undefined,
      departmentId: department.value || undefined,
      priority: priority.value,
      channel: channel.value || undefined,
      confidentiality: confidentiality.value,
      theirRef: kind === 'incoming' ? (theirRef.value.trim() || undefined) : undefined,
      letterDate: letterDate.value || undefined,
      receivedAt: kind === 'incoming' ? toStamp(receivedAt.value) : undefined,
      dueAt: toStamp(dueAt.value) || undefined,
      // 'none' is a real answer, and different from "not chosen": it means do
      // not start the category's workflow either.
      workflowId: workflow.value && workflow.value !== 'none' ? workflow.value : undefined,
      noWorkflow: workflow.value === 'none' ? true : undefined,
    });

    toast(`Registered as ${created.letter.ref}`, 'good');

    if (replyTo) {
      await api.coLinkLetter(created.letter.id, { otherId: replyTo, kind: 'reply_to' }).catch(() => {});
    }
    refreshCo();
    navigate('co-letter', { id: created.letter.id });
  }));

  setTimeout(() => subject.focus(), 0);
  return dialog;
}
