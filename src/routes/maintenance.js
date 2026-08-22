import {
  badRequest, csvResponse, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import { parseCsv } from './importing.js';
import {
  compare as compareRanges, loadDataset, overview as overviewReport, periodReport, stockReport,
} from '../lib/maintenance.js';
import { addDays, diffDays, isDay, todayIn } from '../util/dates.js';
import { announce, readSettings } from '../lib/notify.js';
import { closeDueTasks } from '../lib/stocktakes.js';

/**
 * The maintenance store's API.
 *
 * The issue endpoint is the one that matters. A technician standing in a
 * corridor with a phone should be able to record what they just fitted in a few
 * taps, so it accepts a whole basket in one request and never asks for anything
 * it can work out itself.
 */

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

/** Everything the screens need to draw themselves, in one call. */
export async function bootstrap(ctx) {
  const [categories, items, areas, suppliers, settings, products] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_categories ORDER BY sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM mx_items WHERE active = 1 ORDER BY name').all(),
    ctx.db.prepare('SELECT * FROM mx_areas WHERE active = 1 ORDER BY kind, sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM suppliers ORDER BY name').all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT key, value FROM settings').all(),
    // Absent until 0018 has run, which is not a reason to fail every screen.
    ctx.db.prepare('SELECT id, name FROM mx_products ORDER BY name').all()
      .catch(() => ({ results: [] })),
  ]);

  const map = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));

  return json({
    categories: categories.results ?? [],
    items: items.results ?? [],
    products: products.results ?? [],
    areas: areas.results ?? [],
    suppliers: suppliers.results ?? [],
    settings: {
      currency: map.currency || 'GHS',
      timezone: map.timezone || 'Africa/Accra',
      propertyName: map.property_name || 'Maintenance Store',
      lowCoverDays: Number(map.mx_low_cover_days) || 7,
      supplierMode: map.supplier_mode || 'list',
    },
    today: todayIn(map.timezone || 'Africa/Accra'),
  });
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

/**
 * Record a basket of parts released to one place.
 *
 * Everything goes in one transaction: a half-recorded basket is worse than none
 * at all, because the missing half quietly becomes stock nobody can account for.
 */
export async function createIssue(ctx) {
  const body = await readJson(ctx.request);

  const areaId = body.areaId == null || body.areaId === '' ? null : Number(body.areaId);
  const day = body.day && isDay(body.day) ? body.day : todayIn('Africa/Accra');
  const jobRef = str(body.jobRef, 'Job reference', { max: 60, fallback: '' }) || null;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('Choose at least one item before saving.');
  if (lines.length > 100) throw badRequest('That is a lot of items for one job — 100 is the limit.');

  const clean = [];
  for (const line of lines) {
    const itemId = Number(line.itemId);
    const qty = Number(line.qty);
    if (!Number.isFinite(itemId) || itemId <= 0) throw badRequest('An item was not recognised.');
    if (!Number.isFinite(qty) || qty <= 0) throw badRequest('Every item needs a quantity above zero.');
    if (qty > 100000) throw badRequest('That quantity looks wrong.');
    clean.push({ itemId, qty });
  }

  if (areaId != null) {
    const area = await ctx.db.prepare('SELECT id FROM mx_areas WHERE id = ? AND active = 1')
      .bind(areaId).first();
    if (!area) throw badRequest('That room or area is no longer on the list.');
  }

  try {
    await ctx.db.batch(clean.map((line) => ctx.db.prepare(
      `INSERT INTO mx_issues (day, item_id, area_id, qty, job_ref, note, issued_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(day, line.itemId, areaId, line.qty, jobRef, note, ctx.session.user.name)));
  } catch (err) {
    rethrowConstraint(err, {
      foreignKey: 'One of those items is no longer in the list.',
    });
    throw err;
  }

  await audit(ctx, 'mx.issue', areaId, { day, lines: clean.length, jobRef });
  return json({ ok: true, recorded: clean.length, day }, { status: 201 });
}

/** Recent releases, newest first, for the "what did I just do" list. */
export async function listIssues(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 50, 500);
  const areaId = ctx.url.searchParams.get('areaId');
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');

  const where = [];
  const binds = [];
  if (areaId) { where.push('i.area_id = ?'); binds.push(Number(areaId)); }
  if (from && isDay(from)) { where.push('i.day >= ?'); binds.push(from); }
  if (to && isDay(to)) { where.push('i.day <= ?'); binds.push(to); }

  const rows = await ctx.db.prepare(
    `SELECT i.*, it.name AS item_name, it.unit, a.name AS area_name
       FROM mx_issues i
       JOIN mx_items it ON it.id = i.item_id
       LEFT JOIN mx_areas a ON a.id = i.area_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY i.day DESC, i.id DESC
      LIMIT ?`,
  ).bind(...binds, limit).all();

  return json({ issues: rows.results ?? [] });
}

/** Undo a mistake. Deleting is honest here — the audit log keeps the record. */
export async function deleteIssue(ctx, id) {
  return propose(ctx, { kind: 'issue', action: 'delete', id });
}

/** Ask to correct an issue — the wrong room, the wrong quantity, the wrong day. */
export async function updateIssue(ctx, id) {
  return propose(ctx, { kind: 'issue', action: 'edit', id });
}

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

export async function listPurchases(ctx) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  const where = [];
  const binds = [];
  if (from && isDay(from)) { where.push('p.day >= ?'); binds.push(from); }
  if (to && isDay(to)) { where.push('p.day <= ?'); binds.push(to); }

  const rows = await ctx.db.prepare(
    `SELECT p.*, i.name AS item_name, i.unit
       FROM mx_purchases p
       JOIN mx_items i ON i.id = p.item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.day DESC, p.id DESC
      LIMIT 500`,
  ).bind(...binds).all();

  return json({ purchases: rows.results ?? [] });
}

/** The last price paid for each item, so the delivery form pre-fills itself. */
export async function lastCosts(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT item_id, unit_cost, day FROM mx_purchases p
      WHERE p.id = (SELECT id FROM mx_purchases WHERE item_id = p.item_id ORDER BY day DESC, id DESC LIMIT 1)`,
  ).all();
  return json({
    costs: Object.fromEntries((rows.results ?? []).map((r) => [r.item_id, { unitCost: r.unit_cost, day: r.day }])),
  });
}

/** A whole delivery — several items, one supplier, one date. */
export async function createDelivery(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const supplier = str(body.supplier, 'Supplier', { max: 120, fallback: '' }) || null;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('Add at least one item to the delivery.');
  if (lines.length > 100) throw badRequest('That is a lot of lines for one delivery — 100 is the limit.');

  const clean = lines.map((line) => {
    const itemId = Number(line.itemId);
    const qty = num(line.qty, 'Quantity', { min: 0.0001, max: 1000000 });
    const unitCost = num(line.unitCost, 'Unit cost', { min: 0, max: 1000000 });
    if (!Number.isFinite(itemId) || itemId <= 0) throw badRequest('An item was not recognised.');
    return { itemId, qty, unitCost };
  });

  try {
    await ctx.db.batch(clean.map((line) => ctx.db.prepare(
      'INSERT INTO mx_purchases (day, item_id, qty, unit_cost, supplier, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(day, line.itemId, line.qty, line.unitCost, supplier, note)));
  } catch (err) {
    rethrowConstraint(err, { foreignKey: 'One of those items is no longer in the list.' });
    throw err;
  }

  await audit(ctx, 'mx.delivery', null, { day, lines: clean.length, supplier });
  return json({ ok: true, recorded: clean.length }, { status: 201 });
}

export async function deletePurchase(ctx, id) {
  return propose(ctx, { kind: 'purchase', action: 'delete', id });
}

/** Ask to correct a delivery — a mistyped cost, a wrong quantity, a wrong date. */
export async function updatePurchase(ctx, id) {
  return propose(ctx, { kind: 'purchase', action: 'edit', id });
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Record what was actually on the shelf.
 *
 * A count is a claim, not yet a correction. It is stored as pending and moves
 * no figure until an administrator accepts it — recounting a store is exactly
 * the moment somebody could quietly write off a shortfall, so the person who
 * counts is never the person who decides.
 */
export async function saveCounts(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) throw badRequest('Nothing was counted.');
  if (counts.length > 1000) throw badRequest('That is more than 1000 items in one count.');

  for (const c of counts) {
    const qty = Number(c.qty);
    if (!Number.isFinite(qty) || qty < 0) throw badRequest('A counted quantity cannot be negative.');
    if (qty > 1000000) throw badRequest('That counted quantity looks wrong.');
  }

  await ctx.db.batch(counts.map((c) => ctx.db.prepare(
    `INSERT INTO mx_counts (day, item_id, counted_qty, note, status, counted_by)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
     ON CONFLICT(day, item_id) DO UPDATE SET
       counted_qty = excluded.counted_qty,
       note        = excluded.note,
       counted_by  = excluded.counted_by,
       -- Re-counting the same item on the same day starts the decision again;
       -- an already-accepted figure must not be edited underneath it.
       status      = 'pending',
       reviewed_by = NULL,
       reviewed_at = NULL,
       review_note = NULL`,
  ).bind(day, Number(c.itemId), Number(c.qty) || 0, c.note ?? null, ctx.session.user.name)));

  await audit(ctx, 'mx.count', null, { day, items: counts.length });

  // Somebody has to decide on this, and nothing happens to the shelf until
  // they do — so the people who can decide are told, without the counter
  // having to chase anybody.
  const settings = await readSettings(ctx.db);
  if (settings.notify_count_pending !== '0') {
    const task = announce(ctx.db, ctx.env, {
      kind: 'count_pending',
      audience: 'users',
      title: `${counts.length} counted part${counts.length === 1 ? '' : 's'} waiting for approval`,
      body: `${ctx.session.user.name} counted ${counts.length} item`
        + `${counts.length === 1 ? '' : 's'} on ${day}. `
        + 'Stock stays as it is until the count is accepted.',
      link: '#/mx-stock',
      linkLabel: 'Review the count',
    });
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  // Counting is often the answer to a scheduled task, so close any that this
  // count satisfies rather than making somebody tick it off by hand.
  await closeDueTasks(ctx.db, day, ctx.session.user.name, counts.length).catch(() => {});

  return json({ ok: true, recorded: counts.length, awaitingApproval: true });
}

/**
 * Counts waiting on a decision, with what accepting each one would do.
 *
 * The difference is worked out against the book as it stands now rather than
 * stored when the count was taken, so a delivery keyed in late shows up here
 * before anybody accepts anything.
 */
export async function pendingCounts(ctx) {
  const ds = await loadDataset(ctx.db);
  const rows = await ctx.db.prepare(
    `SELECT c.*, i.name AS item_name, i.unit, i.attributes
       FROM mx_counts c JOIN mx_items i ON i.id = c.item_id
      WHERE c.status = 'pending'
      ORDER BY c.day DESC, i.name`,
  ).all();

  const counts = (rows.results ?? []).map((row) => {
    const book = ds.ledger.stockOn(row.item_id, row.day);
    const unitCost = ds.ledger.unitCostOn(row.item_id, row.day);
    const difference = Math.round((Number(row.counted_qty) - book) * 1000) / 1000;
    return {
      id: row.id,
      day: row.day,
      itemId: row.item_id,
      name: row.item_name,
      unit: row.unit,
      attributes: row.attributes ?? null,
      countedQty: Number(row.counted_qty),
      bookQty: Math.round(book * 1000) / 1000,
      difference,
      differenceValue: Math.round(difference * unitCost * 100) / 100,
      countedBy: row.counted_by,
      note: row.note,
    };
  });

  const byDay = new Map();
  for (const c of counts) {
    if (!byDay.has(c.day)) byDay.set(c.day, { day: c.day, items: 0, shortfall: 0, surplus: 0, net: 0 });
    const g = byDay.get(c.day);
    g.items += 1;
    g.net = Math.round((g.net + c.differenceValue) * 100) / 100;
    if (c.differenceValue < 0) g.shortfall = Math.round((g.shortfall + c.differenceValue) * 100) / 100;
    else g.surplus = Math.round((g.surplus + c.differenceValue) * 100) / 100;
  }

  return json({
    currency: ds.currency,
    counts,
    days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)),
  });
}

/**
 * Accept or reject counts.
 *
 * Accepting is what actually moves the book — until this runs, a count is a
 * note about the shelf and nothing more.
 */
export async function reviewCounts(ctx) {
  const body = await readJson(ctx.request);
  const approve = body.approve === true;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  // Either a list of specific counts, or a whole day's stocktake at once.
  let ids;
  if (Array.isArray(body.ids)) {
    ids = readIds(body.ids);
  } else if (body.day && isDay(body.day)) {
    const rows = await ctx.db.prepare(
      "SELECT id FROM mx_counts WHERE day = ? AND status = 'pending'",
    ).bind(body.day).all();
    ids = (rows.results ?? []).map((r) => r.id);
    if (!ids.length) throw badRequest('There is nothing waiting on that date.');
  } else {
    throw badRequest('Nothing was selected.');
  }

  const holes = ids.map(() => '?').join(',');
  const result = await ctx.db.prepare(
    `UPDATE mx_counts
        SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
      WHERE id IN (${holes}) AND status = 'pending'`,
  ).bind(approve ? 'approved' : 'rejected', ctx.session.user.name, note, ...ids).run();

  const changed = result.meta?.changes ?? 0;
  await audit(ctx, approve ? 'mx.count.approve' : 'mx.count.reject', null, { counts: changed, note });

  return json({ ok: true, [approve ? 'approved' : 'rejected']: changed });
}

/** What was decided, and by whom — the record the approval step exists for. */
export async function countHistory(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT c.*, i.name AS item_name, i.unit
       FROM mx_counts c JOIN mx_items i ON i.id = c.item_id
      WHERE c.status <> 'pending'
      ORDER BY c.reviewed_at DESC, c.id DESC
      LIMIT 100`,
  ).all();

  return json({
    counts: (rows.results ?? []).map((row) => ({
      id: row.id,
      day: row.day,
      name: row.item_name,
      unit: row.unit,
      countedQty: Number(row.counted_qty),
      status: row.status,
      countedBy: row.counted_by,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
    })),
  });
}

// ---------------------------------------------------------------------------
// Changing something already recorded
// ---------------------------------------------------------------------------

/**
 * What each kind of entry is, and which of its columns may be corrected.
 *
 * The item is deliberately not among them. Changing which part an entry is
 * about is not a correction, it is a different entry — and allowing it here
 * would move stock on two items from one approval, which is the one shape a
 * reviewer cannot check at a glance.
 */
const ADJUSTABLE = {
  issue: {
    table: 'mx_issues',
    label: 'issue',
    fields: ['day', 'area_id', 'qty', 'job_ref', 'note'],
  },
  purchase: {
    table: 'mx_purchases',
    label: 'delivery',
    fields: ['day', 'qty', 'unit_cost', 'supplier', 'note'],
  },
};

/** The proposed row, validated now rather than at approval time. */
async function proposedFields(ctx, kind, body, previous) {
  const day = body.day == null ? previous.day : str(body.day, 'Date', { max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const note = body.note === undefined
    ? previous.note
    : (str(body.note, 'Note', { max: 300, fallback: '' }) || null);

  if (kind === 'issue') {
    const qty = num(body.qty ?? previous.qty, 'Quantity', { min: 0.0001, max: 100000 });
    const areaId = body.areaId === undefined
      ? previous.area_id
      : (body.areaId == null || body.areaId === '' ? null : Number(body.areaId));
    if (areaId != null) {
      const area = await ctx.db.prepare('SELECT id FROM mx_areas WHERE id = ? AND active = 1')
        .bind(areaId).first();
      if (!area) throw badRequest('That room or area is no longer on the list.');
    }
    const jobRef = body.jobRef === undefined
      ? previous.job_ref
      : (str(body.jobRef, 'Job reference', { max: 60, fallback: '' }) || null);
    return { day, area_id: areaId, qty, job_ref: jobRef, note };
  }

  const qty = num(body.qty ?? previous.qty, 'Quantity', { min: 0.0001, max: 1000000 });
  const unitCost = num(body.unitCost ?? previous.unit_cost, 'Unit cost', { min: 0, max: 1000000 });
  const supplier = body.supplier === undefined
    ? previous.supplier
    : (str(body.supplier, 'Supplier', { max: 120, fallback: '' }) || null);
  return { day, qty, unit_cost: unitCost, supplier, note };
}

/**
 * Record a request to change or remove something, and change nothing.
 *
 * The entry stays exactly as it is until somebody with the users permission
 * decides — the same rule as a count, for the same reason. An administrator
 * asking goes through here too: it is one path, and the record of who asked and
 * who agreed is worth more than the click it saves them.
 */
async function propose(ctx, { kind, action, id }) {
  const spec = ADJUSTABLE[kind];
  const targetId = Number(id);

  const previous = await ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`)
    .bind(targetId).first();
  if (!previous) throw notFound(`That ${spec.label} has already gone.`);

  // A removal carries a reason and nothing else, and older callers send no body
  // at all — so its parse is allowed to come back empty. An edit's is not: a
  // malformed one there should say so rather than quietly propose no change.
  const body = action === 'delete'
    ? await readJson(ctx.request).catch(() => ({}))
    : await readJson(ctx.request);
  const reason = str(body.reason, 'Reason', { max: 300, fallback: '' }) || null;

  const payload = action === 'edit'
    ? await proposedFields(ctx, kind, body, previous)
    : null;

  // An edit that changes nothing is not a request, it is a stray press. Saying
  // so beats putting a no-op in front of somebody to sign.
  if (payload && spec.fields.every((f) => `${payload[f] ?? ''}` === `${previous[f] ?? ''}`)) {
    throw badRequest('Nothing on that entry was changed.');
  }

  try {
    await ctx.db.prepare(
      `INSERT INTO mx_adjustments (kind, action, target_id, payload, previous, reason, requested_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      kind, action, targetId,
      payload ? JSON.stringify(payload) : null,
      JSON.stringify(previous), reason, ctx.session.user.name,
    ).run();
  } catch (err) {
    // The partial unique index. Two people correcting the same delivery is an
    // ordinary collision, not a server error.
    if (/UNIQUE/i.test(String(err?.message))) {
      throw badRequest(`There is already a change waiting on that ${spec.label}. `
        + 'An administrator has to decide on that one first.');
    }
    throw err;
  }

  await audit(ctx, `mx.${kind}.${action}.request`, targetId, { day: previous.day });

  const settings = await readSettings(ctx.db);
  if (settings.notify_count_pending !== '0') {
    const task = announce(ctx.db, ctx.env, {
      kind: 'mx_adjustment',
      audience: 'users',
      title: `A ${spec.label} is waiting to be ${action === 'delete' ? 'removed' : 'corrected'}`,
      body: `${ctx.session.user.name} asked to ${action === 'delete' ? 'remove' : 'change'} `
        + `a ${spec.label} dated ${previous.day}. Nothing has moved until it is accepted.`,
      link: '#/mx-stock',
      linkLabel: 'Review the request',
    });
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  return json({ ok: true, awaitingApproval: true }, { status: 202 });
}

/** Requests nobody has decided on, with the entry as it stands now. */
export async function pendingAdjustments(ctx) {
  const rows = await ctx.db.prepare(
    "SELECT * FROM mx_adjustments WHERE status = 'pending' ORDER BY id DESC LIMIT 100",
  ).all().catch(() => ({ results: [] }));

  // What was turned down, and can still be accepted. A rejection is a decision
  // for now, not a verdict for ever: the usual reason for one is "I do not
  // believe this yet", and the answer arrives later. Bounded, because this is a
  // list to act on rather than a history — countHistory is the record.
  const turnedDown = await ctx.db.prepare(
    "SELECT * FROM mx_adjustments WHERE status = 'rejected' ORDER BY reviewed_at DESC, id DESC LIMIT 25",
  ).all().catch(() => ({ results: [] }));

  const items = await ctx.db.prepare('SELECT id, name, unit FROM mx_items').all()
    .catch(() => ({ results: [] }));
  const itemById = new Map((items.results ?? []).map((i) => [i.id, i]));
  const areas = await ctx.db.prepare('SELECT id, name FROM mx_areas').all()
    .catch(() => ({ results: [] }));
  const areaById = new Map((areas.results ?? []).map((a) => [a.id, a.name]));

  const parse = (value) => { try { return JSON.parse(value); } catch { return null; } };

  const shape = (row) => {
    const previous = parse(row.previous) ?? {};
    const item = itemById.get(previous.item_id);
    return {
      id: row.id,
      kind: row.kind,
      action: row.action,
      targetId: row.target_id,
      name: item?.name ?? 'a part that has since gone',
      unit: item?.unit ?? '',
      areaName: previous.area_id ? (areaById.get(previous.area_id) ?? null) : null,
      previous,
      payload: parse(row.payload),
      reason: row.reason,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewNote: row.review_note,
    };
  };

  const rejected = (turnedDown.results ?? []).map(shape);
  const open = new Set(
    (rows.results ?? []).map((r) => `${r.kind}:${r.target_id}`),
  );

  return json({
    adjustments: (rows.results ?? []).map(shape),
    rejected: rejected.map((row) => ({
      ...row,
      // Somebody has asked again about the same entry since. Accepting the old
      // one as well would apply two decisions to one row, so the screen says so
      // and the server refuses it.
      superseded: open.has(`${row.kind}:${row.targetId}`),
    })),
  });
}

/**
 * Accept or reject. Accepting is what finally moves the entry.
 *
 * The target is read again here rather than trusted from the request: between
 * asking and deciding, somebody else's accepted request may have removed the
 * very row this one is about.
 */
export async function reviewAdjustments(ctx) {
  const body = await readJson(ctx.request);
  const approve = body.approve === true;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;
  const ids = readIds(body.ids ?? []);
  if (!ids.length) throw badRequest('Nothing was selected.');

  // Rejected as well as pending. A rejection is a decision for now — usually
  // "I do not believe this yet" — and the answer often arrives afterwards, at
  // which point making somebody re-file the identical request would lose who
  // asked, when, and why. Already-approved rows stay out: applying one twice is
  // never a correction.
  const holes = ids.map(() => '?').join(',');
  const rows = await ctx.db.prepare(
    `SELECT * FROM mx_adjustments
      WHERE id IN (${holes}) AND status IN ('pending', 'rejected')`,
  ).bind(...ids).all();

  const waiting = rows.results ?? [];
  if (!waiting.length) throw badRequest('Those requests have already been applied.');

  const statements = [];
  let applied = 0;
  let missing = 0;
  let blocked = 0;

  for (const row of waiting) {
    const spec = ADJUSTABLE[row.kind];
    if (!spec) continue;

    if (!approve) {
      statements.push(decide(ctx, row.id, 'rejected', note));
      continue;
    }

    // Reviving one while a newer request is open on the same entry would put
    // two decisions on one row, in an order nobody chose. The open one is the
    // live question, so that is the one to answer.
    if (row.status === 'rejected') {
      const open = await ctx.db.prepare(
        `SELECT id FROM mx_adjustments
          WHERE kind = ? AND target_id = ? AND status = 'pending' LIMIT 1`,
      ).bind(row.kind, row.target_id).first();
      if (open) {
        blocked += 1;
        continue;
      }
    }

    const target = await ctx.db.prepare(`SELECT id FROM ${spec.table} WHERE id = ?`)
      .bind(row.target_id).first();
    if (!target) {
      // Already gone. Recording it as rejected with the reason is honest; the
      // alternative is a request that stays pending for ever.
      missing += 1;
      statements.push(decide(ctx, row.id, 'rejected', 'That entry no longer exists.'));
      continue;
    }

    if (row.action === 'delete') {
      statements.push(ctx.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).bind(row.target_id));
    } else {
      let payload;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      if (!payload) {
        statements.push(decide(ctx, row.id, 'rejected', 'That request could not be read.'));
        continue;
      }
      const sets = spec.fields.map((f, i) => `${f} = ?${i + 1}`).join(', ');
      statements.push(ctx.db.prepare(
        `UPDATE ${spec.table} SET ${sets} WHERE id = ?${spec.fields.length + 1}`,
      ).bind(...spec.fields.map((f) => payload[f] ?? null), row.target_id));
    }

    applied += 1;
    statements.push(decide(ctx, row.id, 'approved', note));
  }

  const revived = waiting.filter((r) => r.status === 'rejected').length;

  if (statements.length) await ctx.db.batch(statements);
  await audit(ctx, approve ? 'mx.adjustment.approve' : 'mx.adjustment.reject', null, {
    requests: waiting.length, applied, missing, blocked, revived, note,
  });

  return json({
    ok: true,
    decided: waiting.length - blocked,
    applied,
    // Both worth saying out loud rather than counting as accepted: the reviewer
    // pressed accept and these did not happen.
    missing,
    blocked,
    // How many of these had been turned down before, so the screen can say
    // "2 reopened" rather than implying they were new.
    revived,
  });
}

function decide(ctx, id, status, note) {
  return ctx.db.prepare(
    `UPDATE mx_adjustments
        SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
      WHERE id = ? AND status IN ('pending', 'rejected')`,
  ).bind(status, ctx.session.user.name, note, id);
}

// ---------------------------------------------------------------------------
// Setup: items and places
// ---------------------------------------------------------------------------

/**
 * The descriptive variables an administrator has put on a part.
 *
 * Free-form on purpose: every hotel tells its parts apart differently — one by
 * wattage and colour temperature, another by thread size and material — and a
 * fixed set of fields would fit neither. Bounded so the column cannot become a
 * dumping ground, and stored as null rather than "{}" when empty so a part with
 * no variables reads as having none.
 */
export function readAttributes(value) {
  if (value == null || value === '') return null;

  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw badRequest('The part details could not be read.'); }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('The part details could not be read.');

  const clean = {};
  for (const [key, entry] of Object.entries(raw)) {
    const label = String(key).trim();
    const text = entry == null ? '' : String(entry).trim();
    if (!label || !text) continue; // a half-filled row is not a variable
    if (label.length > 40) throw badRequest(`“${label.slice(0, 20)}…” is too long for a label.`);
    if (text.length > 80) throw badRequest(`The value for “${label}” is too long.`);
    clean[label] = text;
  }

  const count = Object.keys(clean).length;
  if (!count) return null;
  if (count > 12) throw badRequest('A part can carry up to 12 details.');
  return JSON.stringify(clean);
}

/**
 * A product and the variants it comes in, created together.
 *
 * The variants are what the store actually holds, so each one becomes a part
 * with its own balance. The product is the name above them.
 *
 * All or nothing: a half-created product leaves variants nobody can find under
 * a heading that does not exist, and the person who typed six sizes would have
 * to work out which four landed.
 */
export async function createProduct(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Product name', { required: true, max: 100 });
  const categoryId = body.categoryId ? Number(body.categoryId) : null;
  const unit = str(body.unit, 'Unit', { max: 20, fallback: 'pcs' }) || 'pcs';
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  const variants = Array.isArray(body.variants) ? body.variants : [];
  if (!variants.length) throw badRequest('Add at least one variant — a size, a colour, a rating.');
  if (variants.length > 50) throw badRequest('That is more than 50 variants for one product.');

  const clean = variants.map((v) => cleanVariant(v, { unit }));
  const labels = new Set(clean.map((v) => v.variant.toLowerCase()));
  if (labels.size !== clean.length) {
    throw badRequest('Two variants have the same label. Each one has to be distinguishable.');
  }

  let product;
  try {
    product = await ctx.db.prepare(
      'INSERT INTO mx_products (name, category_id, note) VALUES (?1, ?2, ?3) RETURNING *',
    ).bind(name, categoryId, note).first();
  } catch (err) {
    rethrowConstraint(err, {
      unique: `There is already a product called "${name}".`,
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }

  try {
    await ctx.db.batch(clean.map((v) => ctx.db.prepare(
      `INSERT INTO mx_items
         (category_id, name, unit, par_level, opening_stock, default_unit_cost,
          is_common, note, attributes, product_id, variant)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      categoryId, variantName(name, v.variant), v.unit, v.parLevel, v.openingStock,
      v.unitCost, v.isCommon, v.note, v.attributes, product.id, v.variant,
    )));
  } catch (err) {
    // The product exists and its variants do not, which is worse than neither.
    await ctx.db.prepare('DELETE FROM mx_products WHERE id = ?').bind(product.id).run().catch(() => {});
    rethrowConstraint(err, {
      unique: 'One of those variants has the same name as a part that already exists.',
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }

  await audit(ctx, 'mx.product.create', product.id, { name, variants: clean.length });
  return json({ product, variants: clean.length }, { status: 201 });
}

/** One more variant of something already stocked. */
export async function addVariant(ctx, id) {
  const body = await readJson(ctx.request);
  const productId = Number(id);

  const product = await ctx.db.prepare('SELECT * FROM mx_products WHERE id = ?')
    .bind(productId).first();
  if (!product) throw notFound('That product no longer exists.');

  const v = cleanVariant(body, { unit: str(body.unit, 'Unit', { max: 20, fallback: 'pcs' }) || 'pcs' });

  const clash = await ctx.db.prepare(
    'SELECT id FROM mx_items WHERE product_id = ? AND lower(variant) = lower(?)',
  ).bind(productId, v.variant).first();
  if (clash) throw badRequest(`${product.name} already comes in ${v.variant}.`);

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO mx_items
         (category_id, name, unit, par_level, opening_stock, default_unit_cost,
          is_common, note, attributes, product_id, variant)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING *`,
    ).bind(
      product.category_id, variantName(product.name, v.variant), v.unit, v.parLevel,
      v.openingStock, v.unitCost, v.isCommon, v.note, v.attributes, productId, v.variant,
    ).first();
    await audit(ctx, 'mx.variant.create', row.id, { product: product.name, variant: v.variant });
    return json({ item: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: 'A part with that name already exists.' });
    throw err;
  }
}

/**
 * Attach a part that already exists to a product.
 *
 * It keeps its id, so every issue, delivery and count ever recorded against it
 * stays where it is. That is the whole reason products are a table of their own
 * rather than a parent row: joining one is a label, not a migration.
 */
export async function attachToProduct(ctx, id) {
  const body = await readJson(ctx.request);
  const itemId = Number(id);
  const productId = body.productId == null ? null : Number(body.productId);

  const item = await ctx.db.prepare('SELECT * FROM mx_items WHERE id = ?').bind(itemId).first();
  if (!item) throw notFound('That part no longer exists.');

  if (productId == null) {
    await ctx.db.prepare('UPDATE mx_items SET product_id = NULL, variant = NULL WHERE id = ?')
      .bind(itemId).run();
    await audit(ctx, 'mx.variant.detach', itemId, { name: item.name });
    return json({ ok: true, productId: null });
  }

  const product = await ctx.db.prepare('SELECT * FROM mx_products WHERE id = ?')
    .bind(productId).first();
  if (!product) throw notFound('That product no longer exists.');

  const variant = str(body.variant, 'Variant', { required: true, max: 60 });
  const clash = await ctx.db.prepare(
    'SELECT id FROM mx_items WHERE product_id = ? AND lower(variant) = lower(?) AND id <> ?',
  ).bind(productId, variant, itemId).first();
  if (clash) throw badRequest(`${product.name} already comes in ${variant}.`);

  await ctx.db.prepare('UPDATE mx_items SET product_id = ?, variant = ? WHERE id = ?')
    .bind(productId, variant, itemId).run();
  await audit(ctx, 'mx.variant.attach', itemId, { product: product.name, variant });
  return json({ ok: true, productId, variant });
}

/** Products with their variants, for the screens that group by them. */
export async function listProducts(ctx) {
  const [products, items] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_products ORDER BY name').all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT * FROM mx_items WHERE product_id IS NOT NULL ORDER BY variant').all()
      .catch(() => ({ results: [] })),
  ]);

  const byProduct = new Map();
  for (const item of items.results ?? []) {
    if (!byProduct.has(item.product_id)) byProduct.set(item.product_id, []);
    byProduct.get(item.product_id).push({
      id: item.id, name: item.name, variant: item.variant, unit: item.unit,
      parLevel: Number(item.par_level) || 0, active: !!item.active,
    });
  }

  return json({
    products: (products.results ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      categoryId: p.category_id,
      note: p.note,
      variants: byProduct.get(p.id) ?? [],
    })),
  });
}

/**
 * A product goes only when nothing hangs off it.
 *
 * Removing the heading and leaving the parts would scatter them back into the
 * flat list under composed names nobody chose — "LED bulb — 40W warm" with
 * nothing to say what it was part of.
 */
export async function deleteProduct(ctx, id) {
  const productId = Number(id);
  const held = await ctx.db.prepare('SELECT COUNT(*) AS n FROM mx_items WHERE product_id = ?')
    .bind(productId).first();
  if ((held?.n ?? 0) > 0) {
    throw badRequest('That product still has variants. Detach or remove them first.');
  }
  const result = await ctx.db.prepare('DELETE FROM mx_products WHERE id = ?').bind(productId).run();
  if (!result.meta?.changes) throw notFound('That product has already gone.');
  await audit(ctx, 'mx.product.delete', productId, null);
  return json({ ok: true });
}

/** The part's own name, composed so it stays unique and reads on its own. */
function variantName(productName, variant) {
  return `${productName} — ${variant}`;
}

function cleanVariant(v, { unit }) {
  return {
    variant: str(v.variant, 'Variant', { required: true, max: 60 }),
    unit: str(v.unit, 'Unit', { max: 20, fallback: unit }) || unit,
    parLevel: num(v.parLevel, 'Restock level', { min: 0, max: 1000000, fallback: 0 }),
    openingStock: num(v.openingStock, 'Opening stock', { min: 0, max: 1000000, fallback: 0 }),
    unitCost: num(v.unitCost, 'Unit cost', { min: 0, max: 1000000, fallback: 0 }),
    isCommon: v.isCommon ? 1 : 0,
    note: str(v.note, 'Note', { max: 300, fallback: '' }) || null,
    attributes: readAttributes(v.attributes),
  };
}

export async function createItem(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 100 });
  const unit = str(body.unit, 'Unit', { max: 20, fallback: 'pcs' }) || 'pcs';

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO mx_items (category_id, name, unit, par_level, opening_stock, default_unit_cost, is_common, note, attributes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) RETURNING *`,
    ).bind(
      body.categoryId ? Number(body.categoryId) : null,
      name, unit,
      num(body.parLevel, 'Restock level', { min: 0, max: 1000000, fallback: 0 }),
      num(body.openingStock, 'Opening stock', { min: 0, max: 1000000, fallback: 0 }),
      num(body.defaultUnitCost, 'Unit cost', { min: 0, max: 1000000, fallback: 0 }),
      body.isCommon ? 1 : 0,
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
      readAttributes(body.attributes),
    ).first();
    await audit(ctx, 'mx.item.create', row.id, { name });
    return json({ item: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, {
      unique: 'There is already an item with that name.',
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }
}

export async function updateItem(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 100 });

  try {
    const row = await ctx.db.prepare(
      `UPDATE mx_items SET category_id = ?2, name = ?3, unit = ?4, par_level = ?5,
              opening_stock = ?6, default_unit_cost = ?7, is_common = ?8, active = ?9, note = ?10,
              attributes = ?11
        WHERE id = ?1 RETURNING *`,
    ).bind(
      Number(id),
      body.categoryId ? Number(body.categoryId) : null,
      name,
      str(body.unit, 'Unit', { max: 20, fallback: 'pcs' }) || 'pcs',
      num(body.parLevel, 'Restock level', { min: 0, max: 1000000, fallback: 0 }),
      num(body.openingStock, 'Opening stock', { min: 0, max: 1000000, fallback: 0 }),
      num(body.defaultUnitCost, 'Unit cost', { min: 0, max: 1000000, fallback: 0 }),
      body.isCommon ? 1 : 0,
      body.active === false ? 0 : 1,
      str(body.note, 'Note', { max: 300, fallback: '' }) || null,
      readAttributes(body.attributes),
    ).first();
    if (!row) throw notFound('That item no longer exists.');
    await audit(ctx, 'mx.item.update', id, { name });
    return json({ item: row });
  } catch (err) {
    rethrowConstraint(err, {
      unique: 'There is already an item with that name.',
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }
}

/**
 * Retire rather than delete once an item has history: deleting would take the
 * issues with it and quietly rewrite what past months cost.
 */
export async function deleteItem(ctx, id) {
  const used = await ctx.db.prepare(
    'SELECT (SELECT COUNT(*) FROM mx_issues WHERE item_id = ?1) + (SELECT COUNT(*) FROM mx_purchases WHERE item_id = ?1) AS n',
  ).bind(Number(id)).first();

  if (used?.n > 0) {
    await ctx.db.prepare('UPDATE mx_items SET active = 0 WHERE id = ?').bind(Number(id)).run();
    await audit(ctx, 'mx.item.retire', id, { history: used.n });
    return json({ ok: true, retired: true });
  }

  await ctx.db.prepare('DELETE FROM mx_items WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'mx.item.delete', id, null);
  return json({ ok: true, retired: false });
}

export async function createCategory(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 60 });
  try {
    const row = await ctx.db.prepare(
      'INSERT INTO mx_categories (name, sort_order) VALUES (?1, ?2) RETURNING *',
    ).bind(name, num(body.sortOrder, 'Order', { min: 0, max: 10000, fallback: 100 })).first();
    return json({ category: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a category with that name.' });
    throw err;
  }
}

export async function listAreas(ctx) {
  const rows = await ctx.db.prepare('SELECT * FROM mx_areas ORDER BY kind, sort_order, name').all();
  return json({ areas: rows.results ?? [] });
}

export async function createArea(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  const kind = body.kind === 'area' ? 'area' : 'room';

  try {
    const row = await ctx.db.prepare(
      'INSERT INTO mx_areas (name, kind, block, sort_order) VALUES (?1, ?2, ?3, ?4) RETURNING *',
    ).bind(
      name, kind,
      str(body.block, 'Block', { max: 60, fallback: '' }) || null,
      num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 100 }),
    ).first();
    await audit(ctx, 'mx.area.create', row.id, { name, kind });
    return json({ area: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a room or area with that name.' });
    throw err;
  }
}

/**
 * Add a whole floor at once.
 *
 * Typing "Room 201" forty times is how a setup screen goes unused and every
 * issue ends up filed against nothing.
 */
export async function createAreaRange(ctx) {
  const body = await readJson(ctx.request);
  const prefix = str(body.prefix, 'Prefix', { max: 30, fallback: 'Room ' });
  const from = Number(body.from);
  const to = Number(body.to);
  const block = str(body.block, 'Block', { max: 60, fallback: '' }) || null;

  if (!Number.isInteger(from) || !Number.isInteger(to)) throw badRequest('Give a first and last number.');
  if (to < from) throw badRequest('The last number is below the first.');
  if (to - from > 300) throw badRequest('That is more than 300 rooms in one go.');

  const statements = [];
  for (let n = from; n <= to; n++) {
    statements.push(ctx.db.prepare(
      'INSERT OR IGNORE INTO mx_areas (name, kind, block, sort_order) VALUES (?1, ?2, ?3, ?4)',
    ).bind(`${prefix}${n}`.trim(), 'room', block, n));
  }

  await ctx.db.batch(statements);
  const after = await ctx.db.prepare('SELECT COUNT(*) AS n FROM mx_areas WHERE kind = ?').bind('room').first();
  await audit(ctx, 'mx.area.range', null, { prefix, from, to, block });

  return json({ ok: true, requested: to - from + 1, rooms: after?.n ?? 0 }, { status: 201 });
}

export async function updateArea(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 80 });
  try {
    const row = await ctx.db.prepare(
      `UPDATE mx_areas SET name = ?2, kind = ?3, block = ?4, sort_order = ?5, active = ?6
        WHERE id = ?1 RETURNING *`,
    ).bind(
      Number(id), name,
      body.kind === 'area' ? 'area' : 'room',
      str(body.block, 'Block', { max: 60, fallback: '' }) || null,
      num(body.sortOrder, 'Order', { min: 0, max: 100000, fallback: 100 }),
      body.active === false ? 0 : 1,
    ).first();
    if (!row) throw notFound('That room or area no longer exists.');
    return json({ area: row });
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a room or area with that name.' });
    throw err;
  }
}

export async function deleteArea(ctx, id) {
  const used = await ctx.db.prepare('SELECT COUNT(*) AS n FROM mx_issues WHERE area_id = ?')
    .bind(Number(id)).first();

  if (used?.n > 0) {
    await ctx.db.prepare('UPDATE mx_areas SET active = 0 WHERE id = ?').bind(Number(id)).run();
    return json({ ok: true, retired: true });
  }
  await ctx.db.prepare('DELETE FROM mx_areas WHERE id = ?').bind(Number(id)).run();
  return json({ ok: true, retired: false });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function overview(ctx) {
  const ds = await loadDataset(ctx.db);
  return json(overviewReport(ds, todayIn(ds.timezone)));
}

/** A range, defaulting to the last 30 days. */
function readRange(ctx, ds) {
  const q = ctx.url.searchParams;
  const to = q.get('to') || todayIn(ds.timezone);
  const from = q.get('from') || addDays(to, -29);
  if (!isDay(from) || !isDay(to)) throw badRequest('Those dates are not valid.');
  if (from > to) throw badRequest('The start date is after the end date.');
  if (diffDays(from, to) > 730) throw badRequest('That range is longer than two years.');
  return { from, to };
}

export async function report(ctx) {
  const ds = await loadDataset(ctx.db);
  const { from, to } = readRange(ctx, ds);
  return json(periodReport(ds, from, to));
}

export async function compare(ctx) {
  const ds = await loadDataset(ctx.db);
  const q = ctx.url.searchParams;

  const read = (fromKey, toKey, label) => {
    const from = q.get(fromKey);
    const to = q.get(toKey);
    if (!isDay(from) || !isDay(to)) throw badRequest(`${label}: both dates are required`);
    if (from > to) throw badRequest(`${label}: the start date is after the end date`);
    if (diffDays(from, to) > 730) throw badRequest(`${label}: that range is longer than two years`);
    return { from, to };
  };

  return json(compareRanges(ds, read('aFrom', 'aTo', 'First period'), read('bFrom', 'bTo', 'Second period')));
}

export async function stock(ctx) {
  const ds = await loadDataset(ctx.db);
  const asOf = ctx.url.searchParams.get('asOf') || todayIn(ds.timezone);
  if (!isDay(asOf)) throw badRequest('That date is not valid.');
  return json(stockReport(ds, asOf));
}

/** One room's whole history, which is the question a manager asks by name. */
export async function areaDetail(ctx, id) {
  const ds = await loadDataset(ctx.db);
  const areaId = Number(id);
  const area = ds.areaById.get(areaId);
  if (!area) throw notFound('That room or area no longer exists.');

  const issues = ds.issues.filter((i) => i.area_id === areaId);
  const perItem = new Map();
  for (const issue of issues) {
    if (!perItem.has(issue.item_id)) perItem.set(issue.item_id, { qty: 0, cost: 0, days: new Set() });
    const rec = perItem.get(issue.item_id);
    rec.qty += Number(issue.qty || 0);
    rec.cost += Number(issue.qty || 0) * ds.ledger.unitCostOn(issue.item_id, issue.day);
    rec.days.add(issue.day);
  }

  const months = new Map();
  for (const issue of issues) {
    const month = issue.day.slice(0, 7);
    const cost = Number(issue.qty || 0) * ds.ledger.unitCostOn(issue.item_id, issue.day);
    months.set(month, (months.get(month) ?? 0) + cost);
  }

  return json({
    area,
    currency: ds.currency,
    totalCost: Math.round(issues.reduce((n, i) => n + Number(i.qty || 0) * ds.ledger.unitCostOn(i.item_id, i.day), 0) * 100) / 100,
    visits: new Set(issues.map((i) => i.day)).size,
    firstIssue: issues.map((i) => i.day).sort()[0] ?? null,
    lastIssue: issues.map((i) => i.day).sort().at(-1) ?? null,
    items: [...perItem.entries()].map(([itemId, rec]) => ({
      itemId,
      name: ds.itemById.get(itemId)?.name ?? `#${itemId}`,
      unit: ds.itemById.get(itemId)?.unit ?? '',
      qty: Math.round(rec.qty * 1000) / 1000,
      cost: Math.round(rec.cost * 100) / 100,
      occasions: rec.days.size,
    })).sort((a, b) => b.cost - a.cost),
    months: [...months.entries()]
      .map(([month, cost]) => ({ month, cost: Math.round(cost * 100) / 100 }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    issues: issues.slice(-100).reverse().map((i) => ({
      id: i.id,
      day: i.day,
      item: ds.itemById.get(i.item_id)?.name ?? `#${i.item_id}`,
      unit: ds.itemById.get(i.item_id)?.unit ?? '',
      qty: i.qty,
      cost: Math.round(Number(i.qty || 0) * ds.ledger.unitCostOn(i.item_id, i.day) * 100) / 100,
      by: i.issued_by,
      jobRef: i.job_ref,
      note: i.note,
    })),
  });
}

// ---------------------------------------------------------------------------
// Bulk upload of parts
// ---------------------------------------------------------------------------

/**
 * The fixed columns. Anything else in the header becomes a detail, so a
 * spreadsheet with Size and Colour columns produces parts with a size and a
 * colour — which is how somebody would lay it out anyway without being told.
 */
const PART_COLUMNS = {
  name: ['name', 'part', 'item', 'partname', 'itemname'],
  // A part that is one of several kinds of the same thing. Product is the name
  // they share; variant is what tells this one apart. Both or neither.
  product: ['product', 'productname', 'belongsto', 'family'],
  variant: ['variant', 'variantlabel', 'kind', 'version'],
  category: ['category', 'group'],
  unit: ['unit', 'measuredin', 'measure', 'uom'],
  parLevel: ['restocklevel', 'parlevel', 'par', 'reorderlevel', 'minimum'],
  openingStock: ['onshelfnow', 'openingstock', 'opening', 'instock', 'quantity', 'qty'],
  defaultUnitCost: ['priceeach', 'unitcost', 'price', 'cost'],
  isCommon: ['everydaypart', 'everyday', 'common'],
  note: ['note', 'notes', 'comment'],
};

export function columnKey(heading) {
  const flat = String(heading ?? '').replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  for (const [key, aliases] of Object.entries(PART_COLUMNS)) {
    if (aliases.includes(flat)) return key;
  }
  return null;
}

export function yesish(value) {
  return ['1', 'y', 'yes', 'true', 'x', 'everyday'].includes(String(value ?? '').trim().toLowerCase());
}

/** A spreadsheet to fill in, pre-loaded with what is already there. */
export async function partsTemplate(ctx) {
  const [items, categories, products] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_items WHERE active = 1 ORDER BY name').all(),
    ctx.db.prepare('SELECT name FROM mx_categories ORDER BY sort_order, name').all(),
    ctx.db.prepare('SELECT id, name FROM mx_products').all().catch(() => ({ results: [] })),
  ]);
  const productName = new Map((products.results ?? []).map((p) => [p.id, p.name]));

  const rows = items.results ?? [];

  // Detail columns come from what this hotel already uses, so the template
  // matches its own vocabulary rather than imposing one.
  const detailLabels = [];
  for (const row of rows) {
    let parsed = {};
    try { parsed = row.attributes ? JSON.parse(row.attributes) : {}; } catch { parsed = {}; }
    for (const label of Object.keys(parsed)) {
      if (!detailLabels.includes(label)) detailLabels.push(label);
    }
  }
  for (const suggested of ['Size', 'Colour']) {
    if (!detailLabels.includes(suggested)) detailLabels.push(suggested);
  }

  const header = [
    'Name', 'Product', 'Variant', 'Category', 'Unit', 'Restock level', 'On shelf now',
    'Price each', 'Everyday part', 'Note', ...detailLabels,
  ];

  const out = [header];
  for (const row of rows) {
    let parsed = {};
    try { parsed = row.attributes ? JSON.parse(row.attributes) : {}; } catch { parsed = {}; }
    const category = (categories.results ?? []).length
      ? (await ctx.db.prepare('SELECT name FROM mx_categories WHERE id = ?').bind(row.category_id).first())?.name ?? ''
      : '';
    out.push([
      row.name, productName.get(row.product_id) ?? '', row.variant ?? '',
      category, row.unit, row.par_level, row.opening_stock,
      row.default_unit_cost, row.is_common ? 'yes' : '', row.note ?? '',
      ...detailLabels.map((label) => parsed[label] ?? ''),
    ]);
  }

  if (!rows.length) {
    // Two rows rather than one, because the thing worth showing is that a
    // product is spelled the same on both and the variant differs. Leaving Name
    // blank is deliberate: it is composed from the two columns beside it.
    out.push(['', 'LED bulb', '15W daylight', 'Electrical', 'pcs', 20, 0, 30, 'yes',
      'example row — delete before importing',
      ...detailLabels.map((l) => (l === 'Size' ? '15W' : l === 'Colour' ? 'Daylight' : ''))]);
    out.push(['', 'LED bulb', '15W warm', 'Electrical', 'pcs', 20, 0, 30, 'yes',
      'example row — delete before importing',
      ...detailLabels.map((l) => (l === 'Size' ? '15W' : l === 'Colour' ? 'Warm' : ''))]);
  }

  return csvResponse('maintenance-parts-template.csv', out);
}

/**
 * Read a filled-in spreadsheet.
 *
 * Nothing is written unless `apply` is set, so the preview and the real import
 * run exactly the same code and cannot disagree about what will happen.
 */
export async function importParts(ctx) {
  const body = await readJson(ctx.request);
  const apply = body.apply === true;
  const overwrite = body.overwrite === true;

  const rows = parseCsv(body.csv ?? '');
  if (rows.length < 2) throw badRequest('That file has no rows in it.');

  const header = rows[0];
  const mapped = header.map(columnKey);
  // A part can be named outright, or described as one variant of a product and
  // have its name composed from the two. Either is enough to know what a row is
  // about; neither leaves nothing to go on.
  const namesVariants = mapped.includes('product') && mapped.includes('variant');
  if (!mapped.includes('name') && !namesVariants) {
    throw badRequest('That file needs a “Name” column, or a “Product” and “Variant” pair. '
      + 'Download the template and fill one in.');
  }
  if (rows.length > 1001) throw badRequest('That is more than 1000 parts in one file.');

  const [existingItems, existingCategories, existingProducts] = await Promise.all([
    ctx.db.prepare('SELECT id, name, product_id, variant FROM mx_items').all()
      .catch(() => ctx.db.prepare('SELECT id, name FROM mx_items').all()),
    ctx.db.prepare('SELECT id, name FROM mx_categories').all(),
    // Missing until 0018 has run. A file that does not mention products imports
    // exactly as it did before; one that does is told why it cannot.
    ctx.db.prepare('SELECT id, name FROM mx_products').all()
      .then((r) => ({ ok: true, rows: r.results ?? [] }))
      .catch(() => ({ ok: false, rows: [] })),
  ]);
  const byName = new Map((existingItems.results ?? []).map((r) => [r.name.trim().toLowerCase(), r]));
  const categoryByName = new Map((existingCategories.results ?? []).map((r) => [r.name.trim().toLowerCase(), r]));
  const productByName = new Map(existingProducts.rows.map((r) => [r.name.trim().toLowerCase(), r]));

  // Which (product, variant) pairs are already taken, and by which part — so a
  // file cannot quietly give one product two variants with the same label.
  const takenVariant = new Map();
  for (const r of existingItems.results ?? []) {
    if (r.product_id && r.variant) takenVariant.set(`${r.product_id}:${r.variant.toLowerCase()}`, r.id);
  }

  const errors = [];
  const newCategories = new Set();
  const newProducts = new Set();
  const seenVariant = new Set();
  const toCreate = [];
  const toUpdate = [];
  const skipped = [];
  const seen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1; // what the spreadsheet calls this row
    const row = rows[i];
    const get = (key) => {
      const at = mapped.indexOf(key);
      return at === -1 ? '' : String(row[at] ?? '').trim();
    };

    if (/^example row/i.test(get('note'))) continue; // the template's own sample

    const product = get('product');
    const variant = get('variant');
    if (product && !variant) {
      errors.push(`Row ${line}: “${product}” needs a variant — the size, colour or rating that tells this one apart.`);
      continue;
    }
    if (variant && !product) {
      errors.push(`Row ${line}: “${variant}” has no product to belong to.`);
      continue;
    }
    if (product && !existingProducts.ok) {
      errors.push(`Row ${line}: this database cannot hold products yet. Run the parts-store update first, or clear the Product and Variant columns.`);
      continue;
    }
    if (product.length > 100 || variant.length > 60) {
      errors.push(`Row ${line}: that product or variant name is too long.`);
      continue;
    }

    // Named outright, or composed from the product and what tells it apart.
    const name = get('name') || (product ? `${product} — ${variant}` : '');
    if (!name) { errors.push(`Row ${line}: no name, and no product and variant to make one from.`); continue; }
    if (name.length > 100) { errors.push(`Row ${line}: that name is too long.`); continue; }

    if (product) {
      const known = productByName.get(product.toLowerCase());
      if (!known) newProducts.add(product);
      const pairKey = `${product.toLowerCase()}::${variant.toLowerCase()}`;
      if (seenVariant.has(pairKey)) {
        errors.push(`Row ${line}: ${product} is given “${variant}” twice in this file.`);
        continue;
      }
      seenVariant.add(pairKey);

      // Already used by a different part in the database.
      const heldBy = known ? takenVariant.get(`${known.id}:${variant.toLowerCase()}`) : null;
      const thisPart = byName.get(name.toLowerCase());
      if (heldBy && heldBy !== thisPart?.id) {
        errors.push(`Row ${line}: ${product} already comes in “${variant}”, as a different part.`);
        continue;
      }
    }

    const key = name.toLowerCase();
    if (seen.has(key)) { errors.push(`Row ${line}: “${name}” appears more than once in this file.`); continue; }
    seen.add(key);

    const number = (value, label) => {
      if (value === '') return 0;
      const n = Number(String(value).replace(/[, ]/g, ''));
      if (!Number.isFinite(n) || n < 0) { errors.push(`Row ${line}: ${label} “${value}” is not a number.`); return null; }
      return n;
    };

    const parLevel = number(get('parLevel'), 'restock level');
    const openingStock = number(get('openingStock'), 'opening stock');
    const unitCost = number(get('defaultUnitCost'), 'price');
    if (parLevel == null || openingStock == null || unitCost == null) continue;

    // Every unrecognised column becomes a detail on the part.
    const details = {};
    for (let c = 0; c < header.length; c++) {
      if (mapped[c]) continue;
      const label = String(header[c] ?? '').trim();
      const value = String(row[c] ?? '').trim();
      if (!label || !value) continue;
      if (label.length > 40 || value.length > 80) {
        errors.push(`Row ${line}: the “${label.slice(0, 20)}” detail is too long.`);
        continue;
      }
      details[label] = value;
    }
    if (Object.keys(details).length > 12) {
      errors.push(`Row ${line}: more than 12 details.`);
      continue;
    }

    const categoryName = get('category');
    if (categoryName && !categoryByName.has(categoryName.toLowerCase())) newCategories.add(categoryName);

    const record = {
      line,
      name,
      productName: product || null,
      variant: variant || null,
      categoryName: categoryName || null,
      unit: get('unit') || 'pcs',
      parLevel,
      openingStock,
      defaultUnitCost: unitCost,
      isCommon: yesish(get('isCommon')),
      note: get('note') || null,
      attributes: Object.keys(details).length ? JSON.stringify(details) : null,
    };

    const already = byName.get(key);
    if (!already) toCreate.push(record);
    else if (overwrite) toUpdate.push({ ...record, id: already.id });
    else skipped.push(record);
  }

  const summary = {
    rowsRead: rows.length - 1,
    willCreate: toCreate.length,
    willUpdate: toUpdate.length,
    willSkip: skipped.length,
    newCategories: [...newCategories],
    newProducts: [...newProducts],
    detailColumns: header.filter((_, c) => !mapped[c]).map((x) => String(x).trim()).filter(Boolean),
    errors: errors.slice(0, 25),
    errorCount: errors.length,
  };

  const preview = [...toCreate.slice(0, 10), ...toUpdate.slice(0, 10)].map((r) => ({
    line: r.line,
    name: r.name,
    product: r.productName,
    variant: r.variant,
    category: r.categoryName,
    unit: r.unit,
    parLevel: r.parLevel,
    openingStock: r.openingStock,
    defaultUnitCost: r.defaultUnitCost,
    attributes: r.attributes,
    action: r.id ? 'update' : 'create',
  }));

  if (!apply) {
    return json({
      applied: false,
      summary,
      preview,
      canApply: (toCreate.length + toUpdate.length) > 0 && errors.length === 0,
    });
  }

  if (errors.length) throw badRequest('Fix the problems listed in the preview first.');
  if (!toCreate.length && !toUpdate.length) throw badRequest('There is nothing in that file to import.');

  // Categories first, so the parts that reference them have something to point
  // at, and re-read to pick up the ids.
  if (newCategories.size) {
    await ctx.db.batch([...newCategories].map((name) => ctx.db.prepare(
      'INSERT OR IGNORE INTO mx_categories (name, sort_order) VALUES (?, 500)',
    ).bind(name)));
    const after = await ctx.db.prepare('SELECT id, name FROM mx_categories').all();
    categoryByName.clear();
    for (const row of after.results ?? []) categoryByName.set(row.name.trim().toLowerCase(), row);
  }

  // Products next, for the same reason and in the same way: a part that names
  // one needs something to point at.
  if (newProducts.size) {
    await ctx.db.batch([...newProducts].map((name) => ctx.db.prepare(
      'INSERT OR IGNORE INTO mx_products (name) VALUES (?)',
    ).bind(name)));
    const after = await ctx.db.prepare('SELECT id, name FROM mx_products').all();
    productByName.clear();
    for (const row of after.results ?? []) productByName.set(row.name.trim().toLowerCase(), row);
  }

  const categoryId = (name) => (name ? categoryByName.get(name.toLowerCase())?.id ?? null : null);
  const productId = (name) => (name ? productByName.get(name.toLowerCase())?.id ?? null : null);

  const statements = [
    ...toCreate.map((r) => ctx.db.prepare(
      `INSERT INTO mx_items (category_id, name, unit, par_level, opening_stock, default_unit_cost, is_common, note, attributes, product_id, variant)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(categoryId(r.categoryName), r.name, r.unit, r.parLevel, r.openingStock,
      r.defaultUnitCost, r.isCommon ? 1 : 0, r.note, r.attributes,
      productId(r.productName), r.variant)),
    // An existing part named in a file with a product joins it here, keeping
    // its id and everything ever recorded against it — the same as attaching
    // one by hand. A row that names no product leaves the columns alone rather
    // than detaching a part somebody grouped deliberately.
    ...toUpdate.map((r) => (r.productName
      ? ctx.db.prepare(
        `UPDATE mx_items SET category_id = ?2, unit = ?3, par_level = ?4, opening_stock = ?5,
                default_unit_cost = ?6, is_common = ?7, note = ?8, attributes = ?9,
                product_id = ?10, variant = ?11, active = 1
          WHERE id = ?1`,
      ).bind(r.id, categoryId(r.categoryName), r.unit, r.parLevel, r.openingStock,
        r.defaultUnitCost, r.isCommon ? 1 : 0, r.note, r.attributes,
        productId(r.productName), r.variant)
      : ctx.db.prepare(
        `UPDATE mx_items SET category_id = ?2, unit = ?3, par_level = ?4, opening_stock = ?5,
                default_unit_cost = ?6, is_common = ?7, note = ?8, attributes = ?9, active = 1
          WHERE id = ?1`,
      ).bind(r.id, categoryId(r.categoryName), r.unit, r.parLevel, r.openingStock,
        r.defaultUnitCost, r.isCommon ? 1 : 0, r.note, r.attributes))),
  ];

  await ctx.db.batch(statements);
  await audit(ctx, 'mx.items.import', null, {
    created: toCreate.length, updated: toUpdate.length,
    categories: [...newCategories], products: [...newProducts],
  });

  return json({
    applied: true,
    created: toCreate.length,
    updated: toUpdate.length,
    products: newProducts.size,
    summary,
  });
}

// ---------------------------------------------------------------------------
// Removing several at once
// ---------------------------------------------------------------------------

/** A list of row ids from the browser, cleaned up and bounded. */
export function readIds(value) {
  if (!Array.isArray(value)) throw badRequest('Nothing was selected.');
  const ids = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw badRequest('Nothing was selected.');
  if (ids.length > 500) throw badRequest('That is more than 500 at once.');
  return ids;
}

/**
 * Which of these ids have history behind them.
 *
 * Anything that has been issued, bought or worked in is retired rather than
 * deleted — deleting would take its history with it and quietly rewrite what
 * past months cost.
 */
async function withHistory(db, ids, queries) {
  const holes = ids.map(() => '?').join(',');
  const found = new Set();
  for (const sql of queries) {
    const rows = await db.prepare(sql.replace('__IN__', holes)).bind(...ids).all();
    for (const row of rows.results ?? []) found.add(row.id);
  }
  return found;
}

/** Split a removal into "safe to delete" and "must be retired", then do both. */
async function removeMany(ctx, { ids, table, historyQueries, action }) {
  const keep = await withHistory(ctx.db, ids, historyQueries);
  const retire = ids.filter((id) => keep.has(id));
  const drop = ids.filter((id) => !keep.has(id));

  // Counted from what the database actually changed rather than from what was
  // asked for: an id that no longer exists must not be reported as removed.
  let retired = 0;
  let deleted = 0;

  if (retire.length) {
    const result = await ctx.db.prepare(
      `UPDATE ${table} SET active = 0 WHERE id IN (${retire.map(() => '?').join(',')}) AND active = 1`,
    ).bind(...retire).run();
    retired = result.meta?.changes ?? retire.length;
  }
  if (drop.length) {
    const result = await ctx.db.prepare(
      `DELETE FROM ${table} WHERE id IN (${drop.map(() => '?').join(',')})`,
    ).bind(...drop).run();
    deleted = result.meta?.changes ?? drop.length;
  }

  await audit(ctx, action, null, { deleted, retired });
  return json({ ok: true, deleted, retired });
}

export async function removeItems(ctx) {
  const ids = readIds((await readJson(ctx.request)).ids);
  return removeMany(ctx, {
    ids,
    table: 'mx_items',
    action: 'mx.items.remove',
    historyQueries: [
      'SELECT DISTINCT item_id AS id FROM mx_issues WHERE item_id IN (__IN__)',
      'SELECT DISTINCT item_id AS id FROM mx_purchases WHERE item_id IN (__IN__)',
      'SELECT DISTINCT item_id AS id FROM mx_counts WHERE item_id IN (__IN__)',
    ],
  });
}

export async function removeAreas(ctx) {
  const ids = readIds((await readJson(ctx.request)).ids);
  return removeMany(ctx, {
    ids,
    table: 'mx_areas',
    action: 'mx.areas.remove',
    historyQueries: ['SELECT DISTINCT area_id AS id FROM mx_issues WHERE area_id IN (__IN__)'],
  });
}
