import { HttpError, badRequest, bool, int, isMissingTable, json, num, readJson, str } from '../lib/http.js';
import { entryHints, loadDataset } from '../lib/analytics.js';
import { notifyDaySubmitted } from '../lib/email.js';
import { pingDaySubmitted } from '../lib/push.js';
import { announce, notify, readSettings } from '../lib/notify.js';
import { assertDayWritable, lockCovering, locksFor } from '../lib/locks.js';
import { isDay, todayIn } from '../util/dates.js';

/**
 * The day sheet: guest counts plus one quantity per ingredient.
 * GET returns the saved sheet alongside the "usual" hints that let a cook fill
 * the whole form with a couple of taps.
 */
export async function getDay(ctx, day) {
  if (!isDay(day)) throw badRequest('Invalid date');
  const { db } = ctx;

  const [service, usage, locks, pending] = await Promise.all([
    db.prepare('SELECT * FROM service_days WHERE day = ?').bind(day).first(),
    db.prepare('SELECT ingredient_id, qty FROM usage WHERE day = ?').bind(day).all(),
    locksFor(db),
    db.prepare("SELECT id, submitted_by, submitted_at FROM day_revisions WHERE day = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
      .bind(day).first()
      .catch((err) => {
        if (isMissingTable(err)) return null;
        throw err;
      }),
  ]);

  const ds = await loadDataset(db);
  const guests = (Number(service?.inhouse_guests) || 0) + (Number(service?.outside_guests) || 0);

  // Somebody whose whole job here is the entry screen. Anyone who can also see
  // reports is reviewing rather than recording, and needs the figures in front
  // of them.
  const entryOnly = ctx.session.permissions.length === 1
    && ctx.session.permissions[0] === 'entry';

  // A submitted day opens as a blank sheet for the kitchen. Re-submitting is
  // still allowed and still goes for approval — but it is entered as a fresh
  // count rather than as a nudge to figures already agreed, which is the whole
  // point of asking for it again. The stored figures are untouched; they are
  // simply not sent to a browser that has no business redisplaying them.
  const clearForEntry = entryOnly && Boolean(service?.submitted_at);

  // The fee is set by an administrator, not typed each morning. A day already
  // recorded keeps whatever was charged then, so changing the fee later never
  // rewrites past revenue.
  const currentFee = Number(ds.settings.outsider_fee) || 0;
  const lock = lockCovering(locks, day);

  return json({
    day,
    today: todayIn(ds.timezone),
    service: clearForEntry
      ? {
          ...service,
          inhouse_guests: null,
          outside_guests: null,
          note: null,
          // Kept: the screen must still say the day was submitted, or a cook
          // has no way of knowing they are sending a correction.
          submitted_at: service.submitted_at,
        }
      : service ?? {
        day,
        inhouse_guests: null,
        outside_guests: null,
        outsider_fee: currentFee,
        note: null,
        submitted_at: null,
      },
    // Tells the screen to explain itself, so a blank form does not read as
    // lost work.
    clearedForEntry: clearForEntry,
    outsiderFee: service ? Number(service.outsider_fee) || 0 : currentFee,
    allowFillUsual: ds.settings.allow_fill_usual !== '0',
    requireComplete: ds.settings.require_complete_entry !== '0',
    // Everyday items are what a complete sheet means; occasional items stay
    // optional so a rule meant to catch forgetfulness does not become busywork.
    requiredIngredientIds: ds.ingredients.filter((i) => i.active && i.is_core).map((i) => i.id),
    // Restricting the list to everyday items is about keeping the morning
    // short, so it applies to people whose whole job here is the entry screen.
    // Anyone who can also see reports keeps the full list, since they are the
    // ones who need an occasional item when it actually gets used.
    restrictToEveryday: ds.settings.restrict_cooks_to_everyday === '1' && entryOnly,
    locked: Boolean(lock),
    lock: lock ? { from: lock.from_day, to: lock.to_day, reason: lock.reason } : null,
    pendingRevision: pending ?? null,
    usage: clearForEntry
      ? {}
      : Object.fromEntries((usage.results ?? []).map((r) => [r.ingredient_id, r.qty])),
    hints: entryHints(ds, day, guests),
  });
}

/**
 * Save (or re-save) a day sheet.
 *
 * Three rules govern what happens here, in order:
 *
 *  1. A closed period is closed — nothing inside it moves.
 *  2. A submission must be complete. Zeros are fine and often correct; a
 *     *missing* figure is not, because it is indistinguishable from "we forgot"
 *     and it silently drags every average down.
 *  3. Re-submitting a day that was already submitted does not overwrite it.
 *     The proposed sheet is parked for review, so yesterday's agreed numbers
 *     cannot quietly become something else.
 */
export async function saveDay(ctx, day) {
  if (!isDay(day)) throw badRequest('Invalid date');
  const { db, session } = ctx;
  const body = await readJson(ctx.request);

  await assertDayWritable(db, day);

  const inhouse = int(body.inhouse_guests, 'In-house guests', { min: 0, max: 100000, fallback: 0 });
  const outside = int(body.outside_guests, 'Outside guests', { min: 0, max: 100000, fallback: 0 });
  const note = str(body.note, 'Note', { max: 1000 });
  const submit = bool(body.submit, false);

  const [settingsRows, existing] = await Promise.all([
    db.prepare('SELECT key, value FROM settings').all(),
    db.prepare('SELECT * FROM service_days WHERE day = ?').bind(day).first(),
  ]);
  const settings = Object.fromEntries((settingsRows.results ?? []).map((r) => [r.key, r.value]));

  const fee = existing ? Number(existing.outsider_fee) || 0 : Number(settings.outsider_fee) || 0;
  const alreadySubmitted = Boolean(existing?.submitted_at);

  const usage = body.usage && typeof body.usage === 'object' ? body.usage : {};
  const entries = Object.entries(usage);
  if (entries.length > 1000) throw badRequest('Too many line items in one save');

  const ingredientRows = await db.prepare(
    'SELECT id, name, unit, is_core, active FROM ingredients',
  ).all();
  const ingredients = ingredientRows.results ?? [];
  const validIds = new Set(ingredients.map((r) => r.id));

  // Normalise the incoming quantities once; both the completeness check and the
  // write path work from the same picture.
  const proposed = new Map();
  const cleared = [];
  for (const [rawId, rawQty] of entries) {
    const ingredientId = Number(rawId);
    if (!validIds.has(ingredientId)) continue;
    if (rawQty === null || rawQty === '') {
      cleared.push(ingredientId);
      continue;
    }
    proposed.set(ingredientId, num(rawQty, `Quantity for ingredient ${ingredientId}`, { min: 0, max: 1e6 }));
  }

  if (submit) {
    if (settings.require_complete_entry !== '0') {
      const required = ingredients.filter((i) => i.active && i.is_core);
      const missing = required.filter((i) => !proposed.has(i.id));
      if (missing.length) {
        throw new HttpError(
          422,
          `${missing.length} everyday ${missing.length === 1 ? 'item has' : 'items have'} no figure yet. `
          + 'Enter a number for each — use 0 if none was used.',
          { missing: missing.map((i) => ({ id: i.id, name: i.name, unit: i.unit })) },
        );
      }
    }
    if (inhouse + outside === 0) {
      throw new HttpError(422, 'Enter the guest count before submitting the day.', { field: 'guests' });
    }
  }

  // ---- re-submission goes to review rather than straight through ----------
  let needsApproval = submit
    && alreadySubmitted
    && settings.require_resubmit_approval !== '0'
    && !ctx.session.permissions.includes('approvals');

  // Without the revisions table there is nowhere to park a proposal. Falling
  // back to a direct save loses the review step, but losing a recorded morning
  // would be worse, and the missing table is itself reported elsewhere.
  if (needsApproval) {
    try {
      await db.prepare("SELECT 1 FROM day_revisions LIMIT 1").first();
    } catch (err) {
      if (!isMissingTable(err)) throw err;
      needsApproval = false;
    }
  }

  if (needsApproval) {
    const currentUsage = await db.prepare('SELECT ingredient_id, qty FROM usage WHERE day = ?')
      .bind(day).all();

    const payload = {
      inhouse_guests: inhouse,
      outside_guests: outside,
      note,
      usage: Object.fromEntries(proposed),
      cleared,
    };
    const previous = {
      inhouse_guests: existing.inhouse_guests,
      outside_guests: existing.outside_guests,
      note: existing.note,
      usage: Object.fromEntries((currentUsage.results ?? []).map((r) => [r.ingredient_id, r.qty])),
    };

    await db.batch([
      // Only the newest proposal for a day stays pending; an earlier one that
      // nobody got to is superseded rather than queued behind it.
      db.prepare("UPDATE day_revisions SET status = 'superseded', reviewed_at = datetime('now') WHERE day = ? AND status = 'pending'")
        .bind(day),
      db.prepare(
        `INSERT INTO day_revisions (day, status, payload, previous, submitted_by)
         VALUES (?, 'pending', ?, ?, ?)`,
      ).bind(day, JSON.stringify(payload), JSON.stringify(previous), session.user.name),
      db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
        `${session.user.name} (${session.user.role})`,
        'day.revision_proposed',
        day,
        JSON.stringify({ inhouse, outside, lines: proposed.size }),
      ),
    ]);

    // Nobody was told. A proposal moves nothing until it is accepted, so it can
    // sit for a week with every screen looking correct and the cook assuming it
    // went through — which is exactly how a corrected sheet gets forgotten.
    const settings = await readSettings(db).catch(() => ({}));
    if (settings.notify_count_pending !== '0') {
      const task = announce(db, ctx.env, {
        kind: 'day_revision',
        audience: 'approvals',
        title: `${day}: ${describeAmendment(previous, payload)}`,
        body: `${session.user.name} amended the sheet for ${day}. `
          + 'The recorded figures stay exactly as they are until somebody accepts it.',
        link: '#/approvals',
        linkLabel: 'Review the change',
      });
      if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
      else await task.catch(() => {});
    }

    return json({
      ok: true,
      day,
      pendingApproval: true,
      submitted: false,
      message: 'This day was already submitted, so your changes have been sent for approval. '
        + 'The recorded figures stay as they are until a manager accepts them.',
    });
  }

  // ---- ordinary save ------------------------------------------------------
  const statements = [
    db.prepare(
      `INSERT INTO service_days (day, inhouse_guests, outside_guests, outsider_fee, note, submitted_at, submitted_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?6 = 1 THEN datetime('now') ELSE NULL END, ?7, datetime('now'))
       ON CONFLICT(day) DO UPDATE SET
         inhouse_guests = ?2,
         outside_guests = ?3,
         outsider_fee   = ?4,
         note           = ?5,
         submitted_at   = CASE WHEN ?6 = 1 THEN datetime('now') ELSE service_days.submitted_at END,
         submitted_by   = CASE WHEN ?6 = 1 THEN ?7 ELSE service_days.submitted_by END,
         updated_at     = datetime('now')`,
    ).bind(day, inhouse, outside, fee, note, submit ? 1 : 0, session.user.name),
  ];

  for (const [ingredientId, qty] of proposed) {
    statements.push(
      db.prepare(
        `INSERT INTO usage (day, ingredient_id, qty, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(day, ingredient_id) DO UPDATE SET qty = ?3, updated_at = datetime('now')`,
      ).bind(day, ingredientId, qty),
    );
  }
  for (const ingredientId of cleared) {
    statements.push(
      db.prepare('DELETE FROM usage WHERE day = ? AND ingredient_id = ?').bind(day, ingredientId),
    );
  }

  statements.push(
    db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      `${session.user.name} (${session.user.role})`,
      submit ? 'day.submit' : 'day.save',
      day,
      JSON.stringify({ inhouse, outside, lines: proposed.size, cleared: cleared.length }),
    ),
  );

  await db.batch(statements);

  if (submit) {
    // Both alerts, neither able to hold up the response: the kitchen has
    // finished, and whether a mail server or a push service is having a bad
    // morning is not the cook's problem.
    const details = { day, submittedBy: session.user.name, resubmission: alreadySubmitted };
    const task = Promise.all([
      notifyDaySubmitted(db, ctx.env, details),
      pingDaySubmitted(db, details),
      notify(db, {
        kind: 'day_submitted',
        audience: 'reports',
        title: `${alreadySubmitted ? 'Updated' : 'New'} breakfast report for ${day}`,
        body: `${session.user.name} recorded ${inhouse + outside} guests `
          + `(${inhouse} in-house, ${outside} outside) across ${proposed.size} items.`,
        link: `#/daily?day=${day}`,
      }),
    ]);
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  return json({
    ok: true,
    day,
    saved: proposed.size,
    cleared: cleared.length,
    submitted: submit,
    outsider_fee: fee,
  });
}

/** Recent day sheets, for the "recent entries" strip on the entry screen. */
export async function listDays(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 30, 200);
  const rows = await ctx.db.prepare(
    `SELECT s.day, s.inhouse_guests, s.outside_guests, s.submitted_at, s.submitted_by,
            (SELECT COUNT(*) FROM usage u WHERE u.day = s.day) AS lines,
            (SELECT COUNT(*) FROM day_revisions r WHERE r.day = s.day AND r.status = 'pending') AS pending
     FROM service_days s
     ORDER BY s.day DESC
     LIMIT ?`,
  ).bind(limit).all();
  return json({ days: rows.results ?? [] });
}

/** Remove a day's sheet entirely. Administrators only. */
export async function deleteDay(ctx, day) {
  if (!isDay(day)) throw badRequest('Invalid date');
  await assertDayWritable(ctx.db, day);

  const existing = await ctx.db.prepare('SELECT * FROM service_days WHERE day = ?').bind(day).first();
  if (!existing) throw badRequest('There is no sheet recorded for that day');

  const lines = await ctx.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE day = ?').bind(day).first();

  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM usage WHERE day = ?').bind(day),
    ctx.db.prepare('DELETE FROM service_days WHERE day = ?').bind(day),
    ctx.db.prepare("UPDATE day_revisions SET status = 'superseded' WHERE day = ? AND status = 'pending'").bind(day),
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)').bind(
      `${ctx.session.user.name} (${ctx.session.user.role})`,
      'day.delete',
      day,
      JSON.stringify({
        inhouse: existing.inhouse_guests,
        outside: existing.outside_guests,
        lines: lines?.n ?? 0,
      }),
    ),
  ]);

  return json({ ok: true, day, removedLines: lines?.n ?? 0 });
}

/**
 * A title that says what kind of amendment this is, not merely that there was
 * one.
 *
 * "A sheet was changed" tells an approver nothing they can weigh; the counts
 * tell them whether this is a typo or a rewritten day, which is what decides
 * how carefully to look. Deliberately no cost figure — that needs prices, and
 * this runs on the write path where a slow query would sit between a cook and
 * their save button.
 */
function describeAmendment(previous, payload) {
  const before = previous.usage ?? {};
  const after = payload.usage ?? {};
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);

  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const id of ids) {
    const a = before[id];
    const b = after[id];
    if (a == null && b != null) added += 1;
    else if (a != null && b == null) removed += 1;
    else if (Number(a) !== Number(b)) changed += 1;
  }

  const guests = (Number(payload.inhouse_guests) || 0) + (Number(payload.outside_guests) || 0)
    - ((Number(previous.inhouse_guests) || 0) + (Number(previous.outside_guests) || 0));

  const bits = [];
  if (changed) bits.push(`${changed} ${changed === 1 ? 'figure' : 'figures'} changed`);
  if (added) bits.push(`${added} added`);
  if (removed) bits.push(`${removed} removed`);
  if (guests) bits.push(`${guests > 0 ? '+' : '\u2212'}${Math.abs(guests)} guests`);
  return bits.length ? bits.join(', ') : 'an amendment is waiting';
}
