// Shared furniture for the correspondence screens.
//
// The bootstrap — departments, categories, the client list, who works here — is
// wanted by every screen and changes rarely, so it is fetched once and kept.
// Anything that edits it calls `refreshCo()` rather than reloading the page.

import { api } from '../api.js';
import { h, toast } from '../util.js';

let cache = null;

export async function co(force = false) {
  if (!cache || force) cache = await api.coBootstrap();
  return cache;
}

export function refreshCo() {
  cache = null;
}

/** What is already loaded, for code drawing a row inside a render pass. */
export function coCached() {
  return cache;
}

// ------------------------------------------------------------- vocabulary --

export const TYPE_LABEL = {
  incoming: 'Incoming',
  outgoing: 'Outgoing',
  memo: 'Memo',
  circular: 'Circular',
};

export const STATUS_LABEL = {
  draft: 'Draft',
  registered: 'Registered',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
  dispatched: 'Sent',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const STATUS_PILL = {
  draft: '',
  registered: 'info',
  in_progress: 'info',
  awaiting_approval: 'warn',
  approved: 'good',
  dispatched: 'good',
  closed: '',
  cancelled: 'bad',
};

export const ACTION_LABEL = {
  action: 'For action',
  review: 'For review',
  approve: 'For approval',
  sign: 'For signature',
  information: 'For information',
};

export function statusPill(status) {
  const cls = STATUS_PILL[status] ?? '';
  return h(`span.pill${cls ? `.${cls}` : ''}`, STATUS_LABEL[status] ?? status);
}

export function priorityPill(priority) {
  if (priority === 'urgent') return h('span.pill.bad', 'Urgent');
  if (priority === 'high') return h('span.pill.warn', 'High');
  if (priority === 'low') return h('span.pill', 'Low');
  return null;
}

/**
 * The lock on a restricted file, shown wherever one is listed.
 *
 * Only somebody already allowed to see it ever sees this — a restricted letter
 * is absent from everybody else's register rather than greyed out — so the
 * marker is a reminder to be careful, not a barrier.
 */
export function confidentialityPill(level) {
  if (level === 'restricted') return h('span.pill.bad', '🔒 Restricted');
  if (level === 'confidential') return h('span.pill.warn', 'Confidential');
  return null;
}

// -------------------------------------------------------------- date and time --

/** '14 Aug, 09:30' — enough to act on, short enough for a table cell. */
export function fmtWhen(stamp) {
  if (!stamp) return '—';
  const date = new Date(String(stamp).includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return String(stamp).slice(0, 16).replace('T', ' ');
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDate(stamp) {
  if (!stamp) return '—';
  const date = new Date(String(stamp).slice(0, 10));
  if (Number.isNaN(date.getTime())) return String(stamp).slice(0, 10);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A deadline, coloured by how much of it is left.
 *
 * "Overdue" and "in 3 hours" are different problems, and a column that renders
 * both as a date makes the reader work out which is which for every row.
 */
export function dueCell(dueAt, { settled = false } = {}) {
  if (!dueAt) return h('span.muted', 'no deadline');
  const left = (new Date(dueAt).getTime() - Date.now()) / 3600_000;
  if (Number.isNaN(left)) return h('span.muted', String(dueAt));

  if (settled) return h('span.muted', fmtWhen(dueAt));
  if (left < 0) {
    const late = Math.abs(left);
    return h('span.pill.bad', late >= 48
      ? `${Math.round(late / 24)} days late`
      : `${Math.round(late)}h late`);
  }
  if (left < 24) return h('span.pill.warn', `in ${Math.max(1, Math.round(left))}h`);
  return h('span', fmtWhen(dueAt));
}

/** An <input type="datetime-local"> value from now plus a number of hours. */
export function inHours(hours) {
  return localInput(new Date(Date.now() + hours * 3600_000));
}

/**
 * A stored instant as a `datetime-local` value, in the browser's own zone.
 *
 * The pair to `toStamp`. Deadlines are stored in UTC and shown in whatever zone
 * the person is sitting in, and the two halves of that conversion have to agree
 * — so they live next to each other rather than being written out again in each
 * form that needs one.
 */
export function localInput(value) {
  if (!value) return '';
  const date = value instanceof Date
    ? value
    : new Date(String(value).includes('T') ? value : `${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What the API stores: an ISO instant. Local wall-clock in, UTC out. */
export function toStamp(localValue) {
  if (!localValue) return null;
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ------------------------------------------------------------------- forms --

/** A <select>. `options` is [{value, label}]; a null value renders as blank. */
export function select(options, { value = null, onchange = null, ...props } = {}) {
  const el = h('select', props,
    ...options.map((option) => h('option', {
      value: option.value ?? '',
      selected: String(option.value ?? '') === String(value ?? ''),
    }, option.label)),
  );
  if (onchange) el.addEventListener('change', () => onchange(el.value || null));
  return el;
}

export function field(label, control, hint) {
  return h('label.field',
    h('span', label),
    control,
    hint ? h('small.muted', hint) : null,
  );
}

/**
 * A modal. Returns the dialog so a caller can close it after a successful save.
 *
 * Errors go inside the form rather than into a toast: a dialog sits in the
 * browser's top layer and a message behind it is a message nobody reads.
 */
export function modal(title, { width = '560px' } = {}, ...children) {
  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: width, width: '94vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', title),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    ...children,
  );
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  return dialog;
}

/** The footer every dialog has: cancel on the left, the real button on the right. */
export function dialogActions(dialog, label, onSave, { danger = false } = {}) {
  const error = h('div.form-error', { style: { display: 'none' } });
  const save = h(`button.${danger ? 'btn-danger' : 'btn-primary'}`, {
    onclick: async () => {
      save.disabled = true;
      error.style.display = 'none';
      try {
        await onSave();
        dialog.close();
      } catch (err) {
        error.textContent = err.message || String(err);
        error.style.display = '';
        save.disabled = false;
      }
    },
  }, label);

  return h('div',
    error,
    h('div.btn-row', { style: { justifyContent: 'flex-end', marginTop: '.6rem' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      save,
    ),
  );
}

/** Run something, report it, and reload the screen. The shape of every action. */
export async function act(promise, message, reload) {
  try {
    const result = await promise;
    if (message) toast(message, 'good');
    if (reload) await reload();
    return result;
  } catch (err) {
    toast(err.message || String(err), 'bad');
    throw err;
  }
}

// ------------------------------------------------------------------ people --

export function personOptions(staff, { blank = '— nobody —' } = {}) {
  return [{ value: '', label: blank }, ...staff.map((s) => ({ value: s.id, label: s.name }))];
}

export function partyOptions(parties, { blank = '— none —' } = {}) {
  return [{ value: '', label: blank }, ...parties.map((p) => ({
    value: p.id,
    label: p.kind === 'client' ? p.name : `${p.name} (${p.kind})`,
  }))];
}

export function caseOptions(cases, { blank = '— not linked —' } = {}) {
  return [{ value: '', label: blank }, ...cases.map((c) => ({
    value: c.id, label: `${c.ref} · ${c.title}`,
  }))];
}
