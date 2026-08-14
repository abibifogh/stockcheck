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

// ------------------------------------------------------------- signatures --

/**
 * The signature control, used in three places: a partner signing internally, a
 * client signing from a link, and somebody saving the signature they will sign
 * with from now on.
 *
 * Four ways to produce one, offered in the order people actually want them:
 *
 *   Saved     what they set up once and now reuse. Absent when there is none.
 *   Draw      a finger on a phone, a trackpad on a laptop.
 *   Upload    a photograph or a scan of a real signature.
 *   Type      a name in a script face.
 *
 * None of them is more secure than another, and the control does not pretend
 * otherwise. The security is the seal — computed from who placed it and a
 * secret held on the server — and a drawn squiggle adds nothing to it. What it
 * adds is that people will actually use the system, and a signing process
 * people refuse to use is not secure either.
 */
export function signaturePad({
  saved = null, defaultName = '', offerSave = false, width = 460,
} = {}) {
  const name = h('input', {
    value: defaultName,
    maxlength: 200,
    placeholder: 'Your name as it should appear',
  });

  // ------------------------------------------------------------ drawing --
  const canvas = h('canvas', {
    width: 900,
    height: 280,
    style: {
      border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)',
      width: '100%', maxWidth: `${width}px`, aspectRatio: '900 / 280',
      touchAction: 'none', background: '#ffffff', cursor: 'crosshair',
    },
  });
  const context = canvas.getContext('2d');
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#101418';

  let drawing = false;
  let drawn = false;
  const at = (event) => {
    const box = canvas.getBoundingClientRect();
    return [
      (event.clientX - box.left) * (canvas.width / box.width),
      (event.clientY - box.top) * (canvas.height / box.height),
    ];
  };
  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    drawn = true;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(...at(event));
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    context.lineTo(...at(event));
    context.stroke();
  });
  canvas.addEventListener('pointerup', () => { drawing = false; });
  canvas.addEventListener('pointerleave', () => { drawing = false; });

  const clearDrawing = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  };

  // ------------------------------------------------------------ uploading --
  let uploaded = null;
  const preview = h('img', {
    alt: '',
    style: {
      display: 'none', maxHeight: '110px', maxWidth: '100%',
      background: '#fff', padding: '.4rem', borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border)',
    },
  });
  const uploadError = h('div.form-error', { style: { display: 'none' } });
  const file = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp',
    onchange: async (event) => {
      const chosen = event.target.files?.[0];
      uploadError.style.display = 'none';
      if (!chosen) return;
      // 2 MB is a generous photograph of a signature and a mean scan of a page.
      // The point of the limit is to catch somebody uploading the whole
      // contract by mistake, which they will.
      if (chosen.size > 2 * 1024 * 1024) {
        uploadError.textContent = 'That image is over 2 MB. A photograph of a signature should be well under it.';
        uploadError.style.display = '';
        event.target.value = '';
        return;
      }
      try {
        uploaded = await readAsDataUrl(chosen);
        preview.src = uploaded;
        preview.style.display = '';
      } catch {
        uploadError.textContent = 'That file could not be read as an image.';
        uploadError.style.display = '';
      }
    },
  });

  // ---------------------------------------------------------------- panes --
  const panes = {
    saved: h('div',
      saved?.image
        ? h('img', {
          src: saved.image,
          alt: 'Your saved signature',
          style: {
            maxHeight: '110px', maxWidth: '100%', background: '#fff',
            padding: '.4rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
          },
        })
        : h('p.muted', 'You have not saved a signature yet.'),
    ),
    draw: h('div',
      canvas,
      h('div.btn-row', { style: { marginTop: '.4rem' } },
        h('button.btn-sm', { onclick: clearDrawing }, 'Clear'),
        h('span.muted', { style: { fontSize: '.8rem' } }, 'Use a finger, a stylus or the trackpad'),
      ),
    ),
    upload: h('div', file, uploadError, preview,
      h('p.muted', { style: { fontSize: '.8rem' } },
        'A photograph or scan of your signature. PNG, JPEG or WebP, under 2 MB. '
        + 'A white background looks best against the document.')),
    typed: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Your name is recorded as typed, in a script face. This is a signature in law in most '
        + 'places, and it is the option that always works on any device.')),
  };

  const available = [
    ...(saved?.image ? [['saved', 'My saved signature']] : []),
    ['draw', 'Draw it'],
    ['upload', 'Upload an image'],
    ['typed', 'Type it'],
  ];

  let mode = available[0][0];
  const showPane = () => {
    for (const [key, pane] of Object.entries(panes)) {
      pane.style.display = key === mode ? '' : 'none';
    }
  };

  const tabs = h('div.seg',
    ...available.map(([key, label]) => {
      const button = h('button', {
        class: key === mode ? 'active' : '',
        onclick: () => {
          mode = key;
          [...tabs.children].forEach((c) => c.classList.toggle('active', c === button));
          showPane();
        },
      }, label);
      return button;
    }),
  );
  showPane();

  const save = h('input', { type: 'checkbox' });
  const saveRow = offerSave
    ? h('label.inline-check', save,
      h('span', saved?.image ? 'Replace my saved signature with this one' : 'Save this as my signature'))
    : null;

  const element = h('div',
    field('Name', name),
    field('Signature', h('div', tabs, h('div', { style: { marginTop: '.6rem' } }, ...Object.values(panes)))),
    saveRow,
  );

  return {
    element,
    nameInput: name,

    /**
     * What was actually produced, or an error a person can act on.
     *
     * Throws rather than returning null so every caller reports the same thing
     * in the same place — the dialog's own error line, never a toast behind a
     * modal where nobody reads it.
     */
    value() {
      const typedName = name.value.trim();
      if (!typedName) throw new Error('Type your name — that is the assertion being recorded');

      if (mode === 'typed') return { method: 'typed', image: null, name: typedName };
      if (mode === 'saved') {
        if (!saved?.image) throw new Error('There is no saved signature to use');
        return { method: saved.method || 'drawn', image: saved.image, name: typedName };
      }
      if (mode === 'upload') {
        if (!uploaded) throw new Error('Choose an image of your signature, or switch to typing it');
        return { method: 'uploaded', image: uploaded, name: typedName };
      }
      if (!drawn) throw new Error('Draw your signature in the box, or switch to typing it');
      return { method: 'drawn', image: canvas.toDataURL('image/png'), name: typedName };
    },

    /** Whether the person asked for this to become their saved signature. */
    wantsSave() {
      // A saved signature has to be an image. "Save my typed name" would store
      // nothing that could be shown next time.
      return Boolean(offerSave && save.checked && mode !== 'typed' && mode !== 'saved');
    },
  };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}
