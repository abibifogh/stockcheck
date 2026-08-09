import { badRequest, bool, json, notFound, readJson, str } from '../lib/http.js';
import {
  getPepper, hashPin, isReservedPin, normaliseEmail, storedPassword,
} from '../lib/auth.js';
import {
  PERMISSIONS, PERMISSION_KEYS, ROLES, effectivePermissions, isRole,
} from '../lib/permissions.js';
import { isEmail, notifyDaySubmitted, parseRecipients } from '../lib/email.js';
import { isDay } from '../util/dates.js';

const PIN_RE = /^\d{4,10}$/;
const MIN_PASSWORD = 10;

// Deliberately identical for "a colleague has it" and "the server reserves it".
export const PIN_TAKEN = 'That PIN is not available. Please choose a different one.';

/**
 * Administrators sign in with an email address and password; everyone else
 * uses a PIN. Validated here rather than only in the form, so the rule holds
 * however the request arrives.
 */
function readCredentials(body, role, { existing = null } = {}) {
  const isAdmin = role === 'admin';

  if (isAdmin) {
    const email = normaliseEmail(str(body.email, 'Email address', { max: 200, fallback: '' }));
    if (!email && !existing?.email) throw badRequest('An administrator needs an email address to sign in with');
    if (email && !isEmail(email)) throw badRequest('That does not look like an email address');

    // The browser stretches the password and sends the derived key with the
    // salt it used; the raw password never reaches here. Length and shape are
    // checked in the browser, where the password still exists.
    const password = body.passwordKey
      ? {
          passwordKey: String(body.passwordKey),
          salt: str(body.passwordSalt, 'Password salt', { required: true, max: 64 }),
          iterations: body.passwordIterations,
        }
      : null;

    if (!password && !existing?.password_hash) {
      throw badRequest(`An administrator needs a password of at least ${MIN_PASSWORD} characters`);
    }

    return { isAdmin, email: email || existing?.email, password, pin: null };
  }

  // Everyone else: a PIN, required on creation.
  const pin = str(body.pin, 'PIN', { max: 10, fallback: '' });
  if (!pin && !existing?.pin_hash) throw badRequest('Give this person a PIN of 4 to 10 digits');
  if (pin && !PIN_RE.test(pin)) throw badRequest('The PIN must be 4 to 10 digits');

  // A demoted administrator keeps their address on file but stops using it.
  const email = normaliseEmail(str(body.email, 'Email address', { max: 200, fallback: '' }));
  if (email && !isEmail(email)) throw badRequest('That does not look like an email address');

  return { isAdmin, email: email || null, password: body.password ? String(body.password) : null, pin };
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    signsInWith: row.role === 'admin' ? 'password' : 'pin',
    // Only the current format counts. A password stored under the old
    // server-side scheme can no longer be verified, so the account needs a new
    // one — showing it as "no password" makes the form ask for exactly that.
    hasPassword: typeof row.password_hash === 'string' && row.password_hash.startsWith('pbkdf2c$'),
    needsPasswordReset: typeof row.password_hash === 'string'
      && row.password_hash.length > 0
      && !row.password_hash.startsWith('pbkdf2c$'),
    role: row.role,
    permissions: effectivePermissions(row),
    customPermissions: row.permissions ? JSON.parse(row.permissions) : null,
    active: Boolean(row.active),
    note: row.note ?? null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

/**
 * The state of the emergency recovery PIN.
 *
 * A user PIN can never be set to the recovery PIN — that is refused. The
 * reverse is not something this app can refuse, because the recovery PIN is
 * set on the server, outside it. If somebody changes it to a value a cook
 * already uses, the users table is consulted first and the cook silently
 * shadows it: the way back in stops working, and nobody finds out until the
 * day it is needed. So it is checked and reported here instead.
 */
async function recoveryStatus(ctx) {
  const configured = Boolean(ctx.env.MANAGER_PIN);

  const setting = await ctx.db.prepare(
    "SELECT value FROM settings WHERE key = 'allow_recovery_pin'",
  ).first();
  const enabled = setting?.value !== '0';

  let conflictsWith = null;
  if (configured) {
    const hash = await hashPin(ctx.env.MANAGER_PIN, await getPepper(ctx.db));
    const clash = await ctx.db.prepare(
      'SELECT name FROM users WHERE pin_hash = ? AND active = 1',
    ).bind(hash).first();
    if (clash) conflictsWith = clash.name;
  }

  return { configured, enabled, conflictsWith };
}

export async function listUsers(ctx) {
  const rows = await ctx.db.prepare(
    'SELECT * FROM users ORDER BY active DESC, role, name',
  ).all();

  return json({
    users: (rows.results ?? []).map(publicUser),
    roles: ROLES,
    permissions: PERMISSIONS,
    recovery: await recoveryStatus(ctx),
  });
}

function readPermissions(body) {
  if (body.permissions == null) return null; // use role defaults
  if (!Array.isArray(body.permissions)) throw badRequest('Permissions must be a list');
  const clean = body.permissions.filter((p) => PERMISSION_KEYS.includes(p));
  if (!clean.length) throw badRequest('Give the person at least one section they can open');
  return JSON.stringify(clean);
}

export async function createUser(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  const role = str(body.role, 'Role', { required: true, max: 20 });
  if (!isRole(role)) throw badRequest('Unknown role');

  const creds = readCredentials(body, role);
  const permissions = readPermissions(body);
  const note = str(body.note, 'Note', { max: 300 });

  if (creds.pin && await isReservedPin(creds.pin, ctx.env)) throw badRequest(PIN_TAKEN);

  const pepper = await getPepper(ctx.db);
  const pinHash = creds.pin ? await hashPin(creds.pin, pepper) : null;
  const passwordHash = creds.password ? await storedPassword(creds.password, pepper) : null;

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO users (name, pin_hash, email, password_hash, role, permissions, active, note)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING *`,
    ).bind(name, pinHash, creds.email, passwordHash, role, permissions, note).first();

    await audit(ctx, 'user.create', String(row.id), { name, role, signIn: creds.isAdmin ? 'password' : 'pin' });
    return json({ user: publicUser(row) }, { status: 201 });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw badRequest(creds.isAdmin
        ? 'That email address is already in use by another account.'
        : PIN_TAKEN);
    }
    throw err;
  }
}

export async function updateUser(ctx, id) {
  const body = await readJson(ctx.request);
  const userId = Number(id);

  const existing = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!existing) throw notFound('User not found');

  const name = str(body.name, 'Name', { required: true, max: 80 });
  const role = str(body.role, 'Role', { required: true, max: 20 });
  if (!isRole(role)) throw badRequest('Unknown role');

  const permissions = readPermissions(body);
  const active = bool(body.active, true);
  const note = str(body.note, 'Note', { max: 300 });

  // Never let the last way in disappear. Demoting or deactivating yourself is
  // fine as long as somebody else can still reach the Users screen.
  if (existing.role === 'admin' && (role !== 'admin' || !active)) {
    const others = await ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    ).bind(userId).first();
    if (!others?.n) {
      throw badRequest('This is the only active administrator. Add another one before changing this account.');
    }
  }

  const creds = readCredentials(body, role, { existing });

  // Promoting somebody to administrator retires their PIN, so the short code
  // they have been typing all along stops being a way into the cost reports.
  if (creds.pin && await isReservedPin(creds.pin, ctx.env)) throw badRequest(PIN_TAKEN);

  let pinHash = creds.isAdmin ? null : existing.pin_hash;
  if (creds.pin) pinHash = await hashPin(creds.pin, await getPepper(ctx.db));

  let passwordHash = existing.password_hash;
  if (creds.password) passwordHash = await storedPassword(creds.password, await getPepper(ctx.db));

  try {
    const row = await ctx.db.prepare(
      `UPDATE users SET name = ?, role = ?, permissions = ?, active = ?, note = ?,
                        pin_hash = ?, email = ?, password_hash = ?
       WHERE id = ? RETURNING *`,
    ).bind(
      name, role, permissions, active ? 1 : 0, note,
      pinHash, creds.email ?? null, passwordHash, userId,
    ).first();

    await audit(ctx, 'user.update', String(userId), {
      name, role, active,
      pinChanged: Boolean(creds.pin),
      passwordChanged: Boolean(creds.password),
    });
    return json({ user: publicUser(row) });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw badRequest(creds.isAdmin
        ? 'That email address is already in use by another account.'
        : PIN_TAKEN);
    }
    throw err;
  }
}

export async function deleteUser(ctx, id) {
  const userId = Number(id);
  const existing = await ctx.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!existing) throw notFound('User not found');

  if (existing.role === 'admin') {
    const others = await ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id != ?",
    ).bind(userId).first();
    if (!others?.n) throw badRequest('You cannot remove the only administrator.');
  }

  await ctx.db.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  await audit(ctx, 'user.delete', String(userId), { name: existing.name });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function getNotifications(ctx) {
  const rows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));

  const recent = await ctx.db.prepare(
    'SELECT * FROM email_log ORDER BY at DESC LIMIT 20',
  ).all();

  return json({
    enabled: settings.notify_on_submit === '1',
    recipients: parseRecipients(settings.notify_recipients),
    from: settings.email_from || '',
    siteUrl: settings.site_url || '',
    // The key itself is never returned — only whether one is present.
    providerConfigured: Boolean(ctx.env.RESEND_API_KEY),
    log: recent.results ?? [],
  });
}

export async function updateNotifications(ctx) {
  const body = await readJson(ctx.request);

  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((r) => String(r).trim()).filter(Boolean)
    : parseRecipients(body.recipients);

  const invalid = recipients.filter((r) => !isEmail(r));
  if (invalid.length) throw badRequest(`Not a valid email address: ${invalid[0]}`);
  if (recipients.length > 25) throw badRequest('That is a lot of recipients — 25 is the limit');

  const from = str(body.from, 'From address', { max: 200, fallback: '' }) || '';
  if (from && !isEmail(from.replace(/^.*<([^>]+)>.*$/, '$1'))) {
    throw badRequest('The "from" address does not look like an email address');
  }

  const siteUrl = str(body.siteUrl, 'Site address', { max: 300, fallback: '' }) || '';
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    throw badRequest('The site address should start with https://');
  }

  const enabled = bool(body.enabled, true) ? '1' : '0';

  await ctx.db.batch([
    setting(ctx.db, 'notify_on_submit', enabled),
    setting(ctx.db, 'notify_recipients', JSON.stringify(recipients)),
    setting(ctx.db, 'email_from', from),
    setting(ctx.db, 'site_url', siteUrl.replace(/\/+$/, '')),
  ]);

  await audit(ctx, 'notifications.update', null, { enabled, recipients: recipients.length });
  return getNotifications(ctx);
}

/** Send the most recent day's email now, so the admin can prove it works. */
export async function testNotification(ctx) {
  const latest = await ctx.db.prepare(
    'SELECT day FROM service_days ORDER BY day DESC LIMIT 1',
  ).first();

  if (!latest) throw badRequest('There are no recorded days yet to send a summary for.');

  await notifyDaySubmitted(ctx.db, ctx.env, {
    day: latest.day,
    submittedBy: `${ctx.session.user.name} (test)`,
    resubmission: false,
  });

  const result = await ctx.db.prepare(
    'SELECT * FROM email_log ORDER BY at DESC LIMIT 1',
  ).first();

  return json({ ok: result?.status === 'sent', result });
}

function setting(db, key, value) {
  return db.prepare(
    'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
  ).bind(key, value);
}

// ---------------------------------------------------------------------------
// Erasing data
// ---------------------------------------------------------------------------

const CONFIRM_PHRASE = 'ERASE';

/** What is about to be deleted, so the confirmation is an informed one. */
export async function dataSummary(ctx) {
  const row = await ctx.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM service_days) AS days,
       (SELECT COUNT(*) FROM usage)        AS usage_rows,
       (SELECT COUNT(*) FROM purchases)    AS purchases,
       (SELECT COUNT(*) FROM stock_counts) AS stock_counts,
       (SELECT COUNT(*) FROM ingredients)  AS ingredients,
       (SELECT COUNT(*) FROM categories)   AS categories,
       (SELECT COUNT(*) FROM users)        AS users,
       (SELECT MIN(day) FROM service_days) AS first_day,
       (SELECT MAX(day) FROM service_days) AS last_day`,
  ).first();

  return json({ counts: row ?? {}, confirmPhrase: CONFIRM_PHRASE });
}

/**
 * Erase recorded activity so the system can go live on clean numbers after a
 * trial run. Two scopes:
 *
 *   'records'  — days, usage, purchases and counts. Keeps the ingredient
 *                catalogue, users and settings. This is what "clear the test
 *                entries" almost always means.
 *   'everything' — the above plus categories and ingredients, back to an empty
 *                catalogue. Users and settings still survive, because being
 *                locked out of your own site is never the intent.
 *
 * A date range may be given instead, to remove a few bad days rather than all
 * of them.
 */
export async function eraseData(ctx) {
  const body = await readJson(ctx.request);

  if (str(body.confirm, 'Confirmation', { max: 40 }) !== CONFIRM_PHRASE) {
    throw badRequest(`Type ${CONFIRM_PHRASE} exactly to confirm.`);
  }

  const scope = str(body.scope, 'Scope', { max: 20, fallback: 'records' });
  if (!['records', 'everything'].includes(scope)) throw badRequest('Unknown scope');

  const from = body.from ? str(body.from, 'From date', { max: 10 }) : null;
  const to = body.to ? str(body.to, 'To date', { max: 10 }) : null;
  if (from && !isDay(from)) throw badRequest('Invalid start date');
  if (to && !isDay(to)) throw badRequest('Invalid end date');
  if (from && to && from > to) throw badRequest('The start date is after the end date');

  if (scope === 'everything' && (from || to)) {
    throw badRequest('A date range only applies to recorded days, not to the ingredient list.');
  }

  const before = await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM service_days) AS days,
            (SELECT COUNT(*) FROM purchases) AS purchases`,
  ).first();

  const statements = [];
  const range = (column) => {
    const clauses = [];
    const binds = [];
    if (from) { clauses.push(`${column} >= ?`); binds.push(from); }
    if (to) { clauses.push(`${column} <= ?`); binds.push(to); }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', binds };
  };

  for (const table of ['usage', 'service_days', 'purchases', 'stock_counts']) {
    const { where, binds } = range('day');
    statements.push(ctx.db.prepare(`DELETE FROM ${table}${where}`).bind(...binds));
  }

  if (scope === 'everything') {
    // Ingredients first — categories are referenced by them.
    statements.push(ctx.db.prepare('DELETE FROM ingredients'));
    statements.push(ctx.db.prepare('DELETE FROM categories'));
  }

  statements.push(
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
      .bind(
        actorName(ctx),
        'data.erase',
        scope,
        JSON.stringify({ from, to, daysBefore: before?.days ?? 0, purchasesBefore: before?.purchases ?? 0 }),
      ),
  );

  await ctx.db.batch(statements);

  const after = await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM service_days) AS days,
            (SELECT COUNT(*) FROM purchases) AS purchases,
            (SELECT COUNT(*) FROM ingredients) AS ingredients`,
  ).first();

  return json({
    ok: true,
    scope,
    range: from || to ? { from, to } : null,
    removed: {
      days: (before?.days ?? 0) - (after?.days ?? 0),
      purchases: (before?.purchases ?? 0) - (after?.purchases ?? 0),
    },
    remaining: after,
  });
}

function actorName(ctx) {
  const user = ctx.session?.user;
  return user ? `${user.name} (${user.role})` : 'unknown';
}

function audit(ctx, action, entity, detail) {
  return ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(actorName(ctx), action, entity, detail ? JSON.stringify(detail) : null)
    .run()
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Closed periods
// ---------------------------------------------------------------------------

export async function listLocks(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM period_locks ORDER BY from_day DESC').all();
  return json({ locks: rows.results ?? [] });
}

export async function createLock(ctx) {
  const body = await readJson(ctx.request);
  const from = str(body.from, 'Start date', { required: true, max: 10 });
  const to = str(body.to, 'End date', { required: true, max: 10 });
  if (!isDay(from) || !isDay(to)) throw badRequest('Invalid dates');
  if (from > to) throw badRequest('The start date is after the end date');

  const reason = str(body.reason, 'Reason', { max: 200 });

  const clash = await ctx.db.prepare(
    'SELECT * FROM period_locks WHERE NOT (to_day < ? OR from_day > ?) LIMIT 1',
  ).bind(from, to).first();
  if (clash) {
    throw badRequest(`That overlaps an existing lock (${clash.from_day} to ${clash.to_day}).`);
  }

  const row = await ctx.db.prepare(
    'INSERT INTO period_locks (from_day, to_day, reason, created_by) VALUES (?, ?, ?, ?) RETURNING *',
  ).bind(from, to, reason, actorName(ctx)).first();

  await audit(ctx, 'period.lock', `${from}..${to}`, { reason });
  return json({ lock: row }, { status: 201 });
}

/** Unlocking is itself recorded — reopening a closed month is a real decision. */
export async function deleteLock(ctx, id) {
  const existing = await ctx.db.prepare('SELECT * FROM period_locks WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('That lock no longer exists');

  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM period_locks WHERE id = ?').bind(id),
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      actorName(ctx),
      'period.unlock',
      `${existing.from_day}..${existing.to_day}`,
      JSON.stringify({ reason: existing.reason }),
    ),
  ]);

  return json({ ok: true });
}

/** The audit trail, so an owner can see who changed what and when. */
export async function auditTrail(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500);
  const rows = await ctx.db.prepare(
    'SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?',
  ).bind(limit).all();
  return json({ entries: rows.results ?? [] });
}
