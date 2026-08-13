import { api } from '../api.js';
import { state } from '../app.js';
import { prepareNewPassword } from '../crypto.js';
import { fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, table } from './components.js';

/** Administrator screen: who can use the system, notifications, and data. */
export async function renderAdmin() {
  const [users, notifications, summary, locks, days] = await Promise.all([
    api.users(),
    api.notifications(),
    api.dataSummary(),
    api.locks(),
    api.recentDays(60),
  ]);

  const host = h('div');
  const reload = async () => mount(host, await renderAdmin());

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Users & data'),
        h('div.sub', 'Who can sign in, what they can see, closed periods and bulk entry'),
      ),
    ),
    usersCard(users, reload),
    locksCard(locks.locks || [], reload),
    importCard(reload),
    submissionsCard(days.days || [], reload),
    notificationsCard(notifications, reload),
    inAppCard(notifications, reload),
    pushCard(notifications, reload),
    eraseCard(summary, reload),
  );
  return host;
}

// ---------------------------------------------------------------------------
// Closed periods
// ---------------------------------------------------------------------------

function locksCard(locks, reload) {
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const reason = h('input', { type: 'text', placeholder: 'e.g. July reported to the owner' });

  const add = async (event) => {
    if (!from.value || !to.value) { toast('Choose both dates', 'bad'); return; }
    event.target.disabled = true;
    try {
      await api.createLock({ from: from.value, to: to.value, reason: reason.value.trim() || null });
      toast('Period closed', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('Closed periods', {
    note: 'Nothing inside a closed period can be added, changed or deleted',
    wide: true,
  },
    table([
      { key: 'from_day', label: 'From', format: (v) => fmtDay(v, { withYear: true }) },
      { key: 'to_day', label: 'To', format: (v) => fmtDay(v, { withYear: true }) },
      { key: 'reason', label: 'Reason', format: (v) => v || h('span.muted', '—') },
      { key: 'created_by', label: 'Closed by', format: (v) => h('span.muted', v || '—') },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('button.btn-sm.btn-danger', {
          onclick: async () => {
            if (!confirm(`Reopen ${row.from_day} to ${row.to_day}? Those days become editable again.`)) return;
            try {
              await api.deleteLock(id);
              toast('Period reopened', 'good');
              reload();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Reopen'),
      },
    ], locks, { empty: 'No closed periods. Every recorded day can still be edited.' }),

    h('div', { style: { marginTop: '.9rem' } },
      h('h3', { style: { marginBottom: '.5rem' } }, 'Close a period'),
      h('div.field-row',
        h('label.field', h('span', 'From'), from),
        h('label.field', h('span', 'To'), to),
        h('label.field', h('span', 'Reason (optional)'), reason),
      ),
      h('button.btn-primary', { onclick: add }, 'Close this period'),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'Close a month once you have reported on it. After that its figures cannot move — not by a '
      + 'cook correcting a sheet, not by an import, not by a deletion. Reopening is recorded in the log.'),
  );
}

// ---------------------------------------------------------------------------
// Bulk import
// ---------------------------------------------------------------------------

function importCard(reload) {
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv' });
  const overwrite = h('select',
    h('option', { value: '0' }, 'Skip days that are already recorded'),
    h('option', { value: '1' }, 'Overwrite days that are already recorded'),
  );
  const markSubmitted = h('select',
    h('option', { value: '1' }, 'Mark imported days as submitted'),
    h('option', { value: '0' }, 'Import as drafts'),
  );

  const resultHost = h('div');
  let csvText = null;
  let previewOk = false;

  const applyBtn = h('button.btn-primary', {
    disabled: true,
    onclick: async (event) => {
      if (!csvText || !previewOk) return;
      if (!confirm('Import these rows now? Days shown as “will write” will be created or replaced.')) return;
      event.target.disabled = true;
      try {
        const result = await api.importDays({
          csv: csvText,
          apply: true,
          overwrite: overwrite.value === '1',
          submit: markSubmitted.value === '1',
        });
        toast(`Imported ${result.written} days`, 'good');
        reload();
      } catch (err) {
        toast(err.message, 'bad');
        event.target.disabled = false;
      }
    },
  }, 'Import for real');

  const preview = async () => {
    if (!csvText) { toast('Choose a file first', 'bad'); return; }
    mount(resultHost, h('div.skeleton', { style: { height: '60px' } }));
    try {
      const result = await api.importDays({
        csv: csvText,
        apply: false,
        overwrite: overwrite.value === '1',
        submit: markSubmitted.value === '1',
      });
      previewOk = result.canApply;
      applyBtn.disabled = !previewOk;
      mount(resultHost, previewReport(result));
    } catch (err) {
      previewOk = false;
      applyBtn.disabled = true;
      mount(resultHost, h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div', h('div.alert-title', 'That file could not be read'), h('div.alert-detail', err.message))));
    }
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    csvText = await file.text();
    previewOk = false;
    applyBtn.disabled = true;
    preview();
  });

  return card('Bulk entry from a spreadsheet', {
    note: 'For catching up on a backlog or importing paper records',
    wide: true,
  },
    h('div.btn-row', { style: { marginBottom: '.8rem' } },
      h('a.btn.btn-sm', { href: api.importTemplateUrl(), download: '' }, '⬇ Download the template'),
    ),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'The template has one column per ingredient and one row per day. Fill it in with a '
      + 'spreadsheet, save as CSV, then choose it below. Nothing is written until you have seen '
      + 'the preview and pressed Import.'),
    h('div.field-row',
      h('label.field', h('span', 'Your filled-in file'), fileInput),
      h('label.field', h('span', 'If a day already exists'), overwrite),
      h('label.field', h('span', 'Status of imported days'), markSubmitted),
    ),
    h('div.btn-row', h('button', { onclick: preview }, 'Check the file'), applyBtn),
    h('div', { style: { marginTop: '.9rem' } }, resultHost),
  );
}

function previewReport(result) {
  const s = result.summary;
  const problems = s.errors || [];

  return h('div',
    h('div.grid.grid-4', { style: { marginBottom: '.8rem' } },
      h('div.stat', h('div.stat-label', 'Rows read'), h('div.stat-value', fmtNum(s.rowsRead, 0))),
      h('div.stat',
        h('div.stat-label', 'Will be written'),
        h('div.stat-value', { style: { color: 'var(--good)' } }, fmtNum(s.willWrite, 0))),
      h('div.stat',
        h('div.stat-label', 'Will be skipped'),
        h('div.stat-value', { style: { color: s.willSkip ? 'var(--warn)' : 'inherit' } }, fmtNum(s.willSkip, 0))),
      h('div.stat',
        h('div.stat-label', 'Ingredient columns matched'),
        h('div.stat-value', fmtNum(s.matchedColumns, 0))),
    ),

    problems.length
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix first`),
          h('div.alert-detail', problems.slice(0, 6).map((e) => h('div', `Line ${e.line}: ${e.message}`)))))
      : null,

    s.unknownColumns?.length
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'Some columns were not recognised and will be ignored'),
          h('div.alert-detail', s.unknownColumns.join(', '))))
      : null,

    s.incompleteRows
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', `${s.incompleteRows} row(s) are missing some everyday items`),
          h('div.alert-detail', 'They will still import, but those items will count as never recorded rather than zero.')))
      : null,

    table([
      { key: 'day', label: 'Date', format: (v) => fmtDay(v) },
      { key: 'inhouse', label: 'In-house', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'outside', label: 'Outside', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'filled', label: 'Items', align: 'right', format: (v) => fmtNum(v, 0) },
      {
        key: 'skipped',
        label: 'Action',
        format: (v, r) => (v
          ? h('span.pill.warn', r.skipReason || 'skipped')
          : r.exists ? h('span.pill.info', 'replace') : h('span.pill.good', 'create')),
      },
      {
        key: 'missingCore',
        label: 'Missing everyday items',
        format: (v) => (v?.length ? h('span.muted', v.slice(0, 4).join(', ') + (v.length > 4 ? '…' : '')) : h('span.muted', 'none')),
      },
    ], result.rows, { empty: 'Nothing readable in that file.' }),
  );
}

// ---------------------------------------------------------------------------
// Deleting a submitted day
// ---------------------------------------------------------------------------

function submissionsCard(days, reload) {
  return card('Recorded days', {
    note: 'Delete a day that was entered by mistake',
    wide: true,
  },
    table([
      { key: 'day', label: 'Date', format: (v) => fmtDay(v, { withYear: true }) },
      { key: 'inhouse_guests', label: 'In-house', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'outside_guests', label: 'Outside', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'lines', label: 'Items', align: 'right', format: (v) => fmtNum(v, 0) },
      { key: 'submitted_by', label: 'Submitted by', format: (v) => v || h('span.muted', 'draft') },
      {
        key: 'pending',
        label: '',
        format: (v) => (v ? h('span.pill.warn', 'change waiting') : null),
      },
      {
        key: 'day',
        label: '',
        format: (day, row) => h('button.btn-sm.btn-danger', {
          onclick: async () => {
            if (!confirm(
              `Delete the whole sheet for ${day}?\n\n`
              + `${row.inhouse_guests + row.outside_guests} guests and ${row.lines} recorded items will be removed.\n\n`
              + 'This cannot be undone.',
            )) return;
            try {
              const result = await api.deleteDay(day);
              toast(`${day} deleted (${result.removedLines} items)`, 'good');
              reload();
            } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'Delete'),
      },
    ], days, { empty: 'No days recorded yet.' }),
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const ROLE_PILL = { cook: '', manager: 'info', admin: 'good' };

function usersCard(data, reload) {
  const { users, roles, permissions } = data;
  const recovery = data.recovery ?? {};

  // The one failure mode the app cannot prevent on its own, so it watches for
  // it instead: an emergency PIN that somebody's everyday PIN has taken over.
  const recoveryBanner = recovery.conflictsWith
    ? h('div.alert.high',
      h('span.alert-icon', '⛔'),
      h('div',
        h('div.alert-title', 'The emergency PIN no longer works'),
        h('div.alert-detail',
          `It is the same as ${recovery.conflictsWith}'s everyday PIN, so signing in with it opens `
          + `${recovery.conflictsWith}'s account instead of letting you back in. `
          + 'Change MANAGER_PIN on the server to something nobody here uses — while you can still '
          + 'sign in normally.'),
      ))
    : !recovery.configured
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', 'No emergency PIN is set'),
          h('div.alert-detail',
            'If every administrator forgets their password, there is no way back into this site. '
            + 'Set MANAGER_PIN on the server, or make sure at least two people can sign in as '
            + 'administrators.'),
        ))
      : !recovery.enabled
        ? h('div.alert.info',
          h('span.alert-icon', 'ℹ️'),
          h('div',
            h('div.alert-title', 'The emergency PIN is switched off'),
            h('div.alert-detail',
              'Administrators can only sign in with their email address and password. You can turn '
              + 'it back on under Setup → Emergency access.'),
          ))
        : null;

  return card('People', {
    note: `${users.filter((u) => u.active).length} active`,
    wide: true,
    actions: h('button.btn-sm.btn-primary', {
      onclick: () => userDialog(null, roles, permissions, reload),
    }, '+ Add person'),
  },
    table([
      {
        key: 'name',
        label: 'Name',
        format: (v, r) => h('div',
          h('div', v),
          r.note ? h('small.muted', r.note) : null,
        ),
      },
      {
        key: 'role',
        label: 'Role',
        format: (v) => h(`span.pill${ROLE_PILL[v] ? `.${ROLE_PILL[v]}` : ''}`,
          roles.find((r) => r.key === v)?.label ?? v),
      },
      {
        key: 'signsInWith',
        label: 'Signs in with',
        format: (v, r) => (v === 'password'
          ? h('div',
            h('div', h(`span.pill.${r.needsPasswordReset ? 'bad' : 'info'}`,
              r.needsPasswordReset ? 'password needs resetting' : 'email & password')),
            h('small.muted', r.email || 'no address set'))
          : h('span.pill', 'PIN')),
      },
      {
        key: 'permissions',
        label: 'Can open',
        format: (list, r) => h('div.btn-row',
          list.map((p) => h('span.pill', permissions.find((x) => x.key === p)?.label ?? p)),
          r.customPermissions ? h('span.pill.info', 'custom') : null,
        ),
      },
      {
        key: 'last_login_at',
        label: 'Last signed in',
        format: (v) => (v ? h('span.muted', v.slice(0, 16).replace('T', ' ')) : h('span.muted', 'never')),
      },
      {
        key: 'active',
        label: 'Status',
        format: (v) => (v ? h('span.pill.good', 'active') : h('span.pill.warn', 'disabled')),
      },
      {
        key: 'id',
        label: '',
        format: (id, row) => h('div.btn-row',
          h('button.btn-sm', { onclick: () => userDialog(row, roles, permissions, reload) }, 'Edit'),
          h('button.btn-sm.btn-danger', {
            onclick: async () => {
              if (!confirm(`Remove ${row.name}? They will no longer be able to sign in.`)) return;
              try {
                await api.deleteUser(id);
                toast(`${row.name} removed`, 'good');
                reload();
              } catch (err) { toast(err.message, 'bad'); }
            },
          }, 'Remove'),
        ),
      },
    ], users, { empty: 'Nobody has been added yet — everyone is still using the shared setup PINs.' }),

    recoveryBanner,

    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
      'Administrators sign in with an email address and a password. Cooks and managers use their '
      + 'own PIN, which is faster on a kitchen tablet — and everyone can change their own from '
      + '“My account”. Every day sheet records who entered it. If you ever lock yourself out, the '
      + 'MANAGER_PIN set on the server still works as a way back in; it can be switched off under '
      + 'Setup once you no longer want it.'),
  );
}

function userDialog(existing, roles, permissions, onSaved) {
  const value = existing || { name: '', role: 'cook', customPermissions: null, active: true, note: '' };

  const name = h('input', { type: 'text', value: value.name, placeholder: 'e.g. Ama Mensah' });
  const pin = h('input', {
    type: 'text', inputmode: 'numeric', maxlength: 10,
    placeholder: existing ? 'leave blank to keep the current PIN' : '4 to 10 digits',
  });
  const email = h('input', {
    type: 'email', value: value.email || '', placeholder: 'name@niceoperation.com',
  });
  const password = h('input', {
    type: 'password', autocomplete: 'new-password',
    placeholder: existing?.hasPassword ? 'leave blank to keep the current password' : 'at least 10 characters',
  });

  // Administrators sign in with credentials; everyone else with a PIN. The
  // form follows the role rather than showing both and hoping.
  const pinField = h('label.field', h('span', existing ? 'New PIN (optional)' : 'PIN'), pin);
  const emailField = h('label.field', h('span', 'Email address'), email);
  const passwordField = h('label.field',
    h('span', existing?.hasPassword ? 'New password (optional)' : 'Password'), password);

  const applyCredentialFields = () => {
    const isAdmin = roleSelect.value === 'admin';
    pinField.classList.toggle('hidden', isAdmin);
    emailField.classList.toggle('hidden', !isAdmin);
    passwordField.classList.toggle('hidden', !isAdmin);
  };
  const note = h('input', { type: 'text', value: value.note || '', placeholder: 'Job title, shift…' });
  const active = h('select',
    h('option', { value: '1', selected: value.active }, 'Active'),
    h('option', { value: '0', selected: !value.active }, 'Disabled'),
  );

  // Permission checkboxes, which follow the role until they are touched.
  let custom = Array.isArray(value.customPermissions) ? [...value.customPermissions] : null;
  const boxes = new Map();

  const roleSelect = h('select', roles.map((r) =>
    h('option', { value: r.key, selected: r.key === value.role }, r.label)));

  const roleHint = h('p.muted', { style: { fontSize: '.8rem', margin: '.2rem 0 .6rem' } });

  const applyRoleDefaults = () => {
    const role = roles.find((r) => r.key === roleSelect.value);
    roleHint.textContent = role?.detail ?? '';
    if (custom) return; // the admin has taken manual control
    for (const [key, box] of boxes) box.checked = role?.defaults.includes(key) ?? false;
  };

  const permissionList = h('div', { style: { display: 'grid', gap: '.4rem' } },
    permissions.map((p) => {
      const box = h('input', {
        type: 'checkbox',
        checked: (custom ?? roles.find((r) => r.key === value.role)?.defaults ?? []).includes(p.key),
        style: { width: 'auto', margin: 0 },
        onchange: () => { custom = [...boxes].filter(([, b]) => b.checked).map(([k]) => k); },
      });
      boxes.set(p.key, box);
      return h('label', {
        style: { display: 'flex', gap: '.5rem', alignItems: 'flex-start', cursor: 'pointer' },
      },
        box,
        h('span',
          h('span', { style: { fontWeight: 600, fontSize: '.88rem' } }, p.label),
          h('span.muted', { style: { display: 'block', fontSize: '.78rem' } }, p.detail),
        ),
      );
    }),
  );

  roleSelect.addEventListener('change', () => { applyRoleDefaults(); applyCredentialFields(); });
  applyRoleDefaults();

  const resetToRole = h('button.btn-sm.btn-ghost', {
    onclick: () => { custom = null; applyRoleDefaults(); toast('Back to the standard access for this role'); },
  }, 'Use the standard access for this role');

  // A modal dialog sits in the browser's top layer, above every toast. Form
  // problems are shown in the form itself, where the person is already looking
  // and where the message stays put while they fix it.
  const problem = h('div.form-error.hidden');
  const showProblem = (message) => {
    problem.textContent = message;
    problem.classList.remove('hidden');
    problem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const clearProblem = () => problem.classList.add('hidden');

  const save = async (event) => {
    clearProblem();
    const selected = [...boxes].filter(([, b]) => b.checked).map(([k]) => k);
    const isAdmin = roleSelect.value === 'admin';

    if (!name.value.trim()) { showProblem('Enter a name for this person.'); return; }
    if (!selected.length) { showProblem('Tick at least one section they can open.'); return; }

    if (isAdmin) {
      if (!email.value.trim()) {
        showProblem('An administrator signs in with an email address — enter one.');
        return;
      }
      if (!existing?.hasPassword && !password.value) {
        showProblem('Set a password of at least 10 characters. A few unrelated words works well.');
        return;
      }
      if (password.value && password.value.length < 10) {
        showProblem('The password must be at least 10 characters. A few unrelated words works well.');
        return;
      }
      if (password.value && /^\d+$/.test(password.value)) {
        showProblem('A password of only digits is a PIN. Include some words or letters.');
        return;
      }
    } else if (!existing && !pin.value.trim()) {
      showProblem('Give this person a PIN of 4 to 10 digits.');
      return;
    }

    const role = roles.find((r) => r.key === roleSelect.value);
    const matchesRole = role
      && selected.length === role.defaults.length
      && selected.every((p) => role.defaults.includes(p));

    const body = {
      name: name.value.trim(),
      role: roleSelect.value,
      // Only store an override when it actually differs from the role, so
      // changing a role later still moves that person's access with it.
      permissions: matchesRole ? null : selected,
      note: note.value.trim() || null,
      active: active.value === '1',
    };
    if (isAdmin) {
      body.email = email.value.trim();
      // Stretched here, in the browser: the server has a 10ms CPU budget and
      // the raw password should not travel further than it must.
      if (password.value) Object.assign(body, await prepareNewPassword(password.value));
    } else if (pin.value.trim()) {
      body.pin = pin.value.trim();
    }

    event.target.disabled = true;
    try {
      if (existing) await api.updateUser(existing.id, body);
      else await api.createUser(body);
      toast(existing ? 'Saved' : `${body.name} can now sign in`, 'good');
      dialog.close();
      onSaved();
    } catch (err) {
      showProblem(err.message);
      event.target.disabled = false;
    }
  };

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--surface)', color: 'var(--text)',
      maxWidth: '620px', width: '92vw', padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', existing ? `Edit ${existing.name}` : 'Add a person'),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Role'), roleSelect),
      h('label.field', h('span', 'Status'), active),
      pinField,
      emailField,
      passwordField,
    ),
    roleHint,
    h('label.field', h('span', 'Note (optional)'), note),
    h('div', { style: { marginTop: '.4rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Sections this person can open'),
      permissionList,
      h('div', { style: { marginTop: '.5rem' } }, resetToRole),
    ),
    problem,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, existing ? 'Save changes' : 'Add person'),
    ),
  );

  applyCredentialFields();
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function notificationsCard(data, reload) {
  const enabled = h('select',
    h('option', { value: '1', selected: data.enabled }, 'Send an email on every submission'),
    h('option', { value: '0', selected: !data.enabled }, 'Do not send emails'),
  );
  const from = h('input', {
    type: 'text', value: data.from,
    placeholder: 'Breakfast <breakfast@niceoperation.com>',
  });
  const siteUrl = h('input', {
    type: 'text', value: data.siteUrl,
    placeholder: 'https://breakfast.niceoperation.com',
  });

  const recipients = [...data.recipients];
  const listHost = h('div', { style: { display: 'grid', gap: '.4rem' } });

  const paintRecipients = () => {
    mount(listHost, recipients.length
      ? recipients.map((address, index) => h('div', {
        style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '.4rem' },
      },
        h('input', {
          type: 'email', value: address,
          oninput: (e) => { recipients[index] = e.target.value.trim(); },
        }),
        h('button.btn-sm.btn-ghost', {
          onclick: () => { recipients.splice(index, 1); paintRecipients(); },
        }, '✕'),
      ))
      : h('p.muted', { style: { fontSize: '.85rem', margin: 0 } }, 'No recipients yet — nobody will be emailed.'));
  };
  paintRecipients();

  const providerWarning = data.providerConfigured
    ? null
    : h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'Email is not connected yet'),
        h('div.alert-detail',
          'A sending key has not been added to the server, so nothing can go out. '
          + 'See "Turning on email" in the setup guide — it is a one-off step.'),
      ));

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.updateNotifications({
        enabled: enabled.value === '1',
        recipients: recipients.filter(Boolean),
        from: from.value.trim(),
        siteUrl: siteUrl.value.trim(),
      });
      toast('Notification settings saved', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const sendTest = async (event) => {
    event.target.disabled = true;
    event.target.textContent = 'Sending…';
    try {
      const result = await api.testNotification();
      if (result.ok) toast('Test email sent — check the inbox', 'good');
      else toast(`Not sent: ${result.result?.detail || 'see the log below'}`, 'bad');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
      event.target.textContent = 'Send a test now';
    }
  };

  return card('Daily email', {
    note: 'Sent when the kitchen submits a day, with that morning’s analysis',
    wide: true,
  },
    providerWarning,
    h('div.field-row',
      h('label.field', h('span', 'When to send'), enabled),
      h('label.field', h('span', 'From address'), from),
      h('label.field', h('span', 'Site address (for the link in the email)'), siteUrl),
    ),
    h('div', { style: { marginTop: '.4rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Send to'),
      listHost,
      h('button.btn-sm', {
        style: { marginTop: '.5rem' },
        onclick: () => { recipients.push(''); paintRecipients(); },
      }, '+ Add recipient'),
    ),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn-primary', { onclick: save }, 'Save'),
      h('button', { onclick: sendTest }, 'Send a test now'),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem' } },
      'The “from” address must be at a domain you have verified with your email provider. '
      + 'Sending from a Gmail or Yahoo address will not work — mail providers reject it.'),
    data.log?.length
      ? h('div', { style: { marginTop: '.6rem' } },
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Recent sends'),
        table([
          { key: 'at', label: 'When', format: (v) => h('span.muted', String(v).slice(0, 16).replace('T', ' ')) },
          { key: 'day', label: 'For day', format: (v) => (v ? fmtDay(v) : '—') },
          {
            key: 'status',
            label: 'Result',
            format: (v) => h(`span.pill.${v === 'sent' ? 'good' : v === 'skipped' ? 'warn' : 'bad'}`, v),
          },
          { key: 'recipients', label: 'To', format: (v) => v || h('span.muted', '—') },
          { key: 'detail', label: 'Detail', format: (v) => (v ? h('span.muted', v) : '—') },
        ], data.log))
      : null,
  );
}

// ---------------------------------------------------------------------------
// Phone alerts
// ---------------------------------------------------------------------------

/**
 * The list of devices, and the master switch.
 *
 * Turning alerts on is done by each person on each of their own devices, from
 * My account — permission to show a notification is granted by a browser to a
 * site and cannot be handed out from here. What an administrator gets is the
 * ability to see who is being alerted, retire a phone that has been lost or
 * replaced, and switch the whole thing off.
 */
/**
 * The bell, and the two things besides the breakfast sheet that ring it.
 *
 * Kept apart from the email card because these reach people who are already
 * looking at the system, and need no domain, key or verified sender to work.
 */
function inAppCard(data, reload) {
  const inApp = h('select',
    h('option', { value: '1', selected: data.inAppEnabled }, 'Show notifications in the bell'),
    h('option', { value: '0', selected: !data.inAppEnabled }, 'Turn the bell off'),
  );
  const countPending = h('select',
    h('option', { value: '1', selected: data.countPendingEnabled }, 'Tell administrators'),
    h('option', { value: '0', selected: !data.countPendingEnabled }, 'Say nothing'),
  );
  const stocktakeDue = h('select',
    h('option', { value: '1', selected: data.stocktakeDueEnabled }, 'Tell the people asked'),
    h('option', { value: '0', selected: !data.stocktakeDueEnabled }, 'Say nothing'),
  );

  const save = async (event) => {
    event.target.disabled = true;
    try {
      await api.updateNotifications({
        // Only the switches on this card are sent; the rest keep what they had.
        inAppEnabled: inApp.value === '1',
        countPendingEnabled: countPending.value === '1',
        stocktakeDueEnabled: stocktakeDue.value === '1',
        recipients: data.recipients,
        from: data.from,
        siteUrl: data.siteUrl,
        enabled: data.enabled,
        pushEnabled: data.pushEnabled,
      });
      toast('Saved', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('In-app notifications', {
    note: 'The bell at the top of every screen',
    wide: true,
  },
    h('p.muted', { style: { fontSize: '.87rem', marginTop: 0 } },
      'These need no email account and no setup. Everybody sees what their own access allows: '
      + 'a submitted breakfast sheet reaches whoever can read reports, a count waiting for '
      + 'approval — in the parts store or the craft shop — reaches administrators, and a '
      + 'scheduled stock count that has come round reaches whoever was asked to do it.'),
    h('div.field-row',
      h('label.field', h('span', 'The bell'), inApp),
      h('label.field', h('span', 'A stock count needs approving'), countPending),
      h('label.field', h('span', 'A scheduled stock count is due'), stocktakeDue),
    ),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn-primary', { onclick: save }, 'Save'),
    ),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.8rem', marginBottom: 0 } },
      'The last two are also emailed, to whoever holds the matching access and has an '
      + 'email address on their account, plus everybody on the daily-email list above.'),
  );
}

function pushCard(data, reload) {
  const enabled = h('select',
    h('option', { value: '1', selected: data.pushEnabled }, 'Alert every subscribed device'),
    h('option', { value: '0', selected: !data.pushEnabled }, 'Do not send alerts'),
  );

  const save = async (event) => {
    event.target.disabled = true;
    try {
      // Sent alongside the email settings, which is the only thing this
      // endpoint updates — resend them unchanged.
      await api.updateNotifications({
        enabled: data.enabled,
        recipients: data.recipients,
        from: data.from,
        siteUrl: data.siteUrl,
        pushEnabled: enabled.value === '1',
      });
      toast('Alert settings saved', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  const remove = async (device) => {
    if (!confirm(`Stop alerting ${device.label || 'this device'}?`)) return;
    try {
      await api.removePushDevice(device.id);
      toast('Device removed');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return card('Phone alerts', {
    note: 'A notification the moment a day is submitted',
    wide: true,
  },
    h('p.muted', { style: { fontSize: '.87rem' } },
      'Each person turns these on for themselves, on each device they want alerted, under '
      + '“My account”. A phone and a computer count as two devices.'),
    h('div.field-row',
      h('label.field', h('span', 'When a day is submitted'), enabled),
    ),
    h('div', { style: { marginTop: '.8rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Devices being alerted'),
      data.devices?.length
        ? table([
          { key: 'label', label: 'Device', format: (v) => v || h('span.muted', 'Unnamed device') },
          { key: 'name', label: 'Person', format: (v) => v || h('span.muted', 'Emergency access') },
          { key: 'created_at', label: 'Added', format: (v) => h('span.muted', String(v).slice(0, 10)) },
          {
            key: 'id',
            label: '',
            align: 'right',
            format: (_v, row) => h('button.btn-sm.btn-ghost', { onclick: () => remove(row) }, 'Remove'),
          },
        ], data.devices)
        : h('p.muted', { style: { fontSize: '.85rem', margin: 0 } },
          'Nobody has turned alerts on yet. Open “My account” and choose “Alert me on this device”.'),
    ),
    h('div.btn-row', { style: { marginTop: '1rem' } },
      h('button.btn-primary', { onclick: save }, 'Save'),
    ),
    data.pushLog?.length
      ? h('div', { style: { marginTop: '.6rem' } },
        h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Recent alerts'),
        table([
          { key: 'at', label: 'When', format: (v) => h('span.muted', String(v).slice(0, 16).replace('T', ' ')) },
          { key: 'day', label: 'For day', format: (v) => (v ? fmtDay(v) : '—') },
          {
            key: 'status',
            label: 'Result',
            format: (v) => h(`span.pill.${v === 'sent' ? 'good' : v === 'skipped' ? 'warn' : 'bad'}`, v),
          },
          { key: 'sent', label: 'Devices', align: 'right' },
          { key: 'detail', label: 'Detail', format: (v) => (v ? h('span.muted', v) : '—') },
        ], data.pushLog))
      : null,
  );
}

// ---------------------------------------------------------------------------
// Erasing data
// ---------------------------------------------------------------------------

function eraseCard(data, reload) {
  const counts = data.counts || {};

  const scope = h('select',
    h('option', { value: 'records' }, 'Recorded days, usage, deliveries and stock counts'),
    h('option', { value: 'everything' }, 'All of that, plus the whole ingredient list'),
  );
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date' });
  const confirmBox = h('input', { type: 'text', placeholder: `Type ${data.confirmPhrase} to confirm` });

  const erase = async (event) => {
    const scopeLabel = scope.value === 'everything'
      ? 'every recorded day AND the entire ingredient list'
      : 'every recorded day, delivery and stock count';
    const ranged = from.value || to.value;
    const message = ranged
      ? `Delete recorded days between ${from.value || 'the beginning'} and ${to.value || 'today'}?\n\nThis cannot be undone.`
      : `Delete ${scopeLabel}?\n\nThis cannot be undone.`;

    if (!confirm(message)) return;

    event.target.disabled = true;
    try {
      const result = await api.eraseData({
        confirm: confirmBox.value.trim(),
        scope: scope.value,
        from: from.value || null,
        to: to.value || null,
      });
      toast(`Erased ${result.removed.days} days and ${result.removed.purchases} deliveries`, 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
      event.target.disabled = false;
    }
  };

  return card('Erase data', {
    note: 'For clearing out a trial run before going live',
    wide: true,
  },
    h('div.grid.grid-4', { style: { marginBottom: '1rem' } },
      h('div.stat',
        h('div.stat-label', 'Recorded days'),
        h('div.stat-value', fmtNum(counts.days, 0)),
        h('div.stat-sub', counts.first_day ? `${fmtDay(counts.first_day)} → ${fmtDay(counts.last_day)}` : 'none yet'),
      ),
      h('div.stat',
        h('div.stat-label', 'Usage lines'),
        h('div.stat-value', fmtNum(counts.usage_rows, 0)),
      ),
      h('div.stat',
        h('div.stat-label', 'Deliveries'),
        h('div.stat-value', fmtNum(counts.purchases, 0)),
      ),
      h('div.stat',
        h('div.stat-label', 'Kept either way'),
        h('div.stat-value', fmtNum(counts.users, 0)),
        h('div.stat-sub', 'people, and all your settings'),
      ),
    ),

    h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', 'This cannot be undone'),
        h('div.alert-detail',
          'There is no undo and no recycle bin. If you only want to remove a few bad mornings, '
          + 'set a date range below rather than erasing everything. '
          + 'Your people, PINs and settings are never touched.'),
      )),

    h('div.field-row',
      h('label.field', h('span', 'What to erase'), scope),
      h('label.field', h('span', 'From (optional)'), from),
      h('label.field', h('span', 'To (optional)'), to),
      h('label.field', h('span', `Type ${data.confirmPhrase}`), confirmBox),
    ),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Leave both dates empty to erase everything of the chosen kind. A date range only applies to '
      + 'recorded days, usage, deliveries and counts — never to the ingredient list.'),
    h('button.btn-danger', { onclick: erase }, 'Erase permanently'),
  );
}
