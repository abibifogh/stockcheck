import {
  badRequest, csvResponse, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import { parseCsv } from './importing.js';
import {
  compare as compareRanges, loadDataset, overview as overviewReport, periodReport, stockReport,
} from '../lib/maintenance.js';
import { addDays, diffDays, isDay, todayIn } from '../util/dates.js';

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
  const [categories, items, areas, suppliers, settings] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_categories ORDER BY sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM mx_items WHERE active = 1 ORDER BY name').all(),
    ctx.db.prepare('SELECT * FROM mx_areas WHERE active = 1 ORDER BY kind, sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM suppliers ORDER BY name').all().catch(() => ({ results: [] })),
    ctx.db.prepare('SELECT key, value FROM settings').all(),
  ]);

  const map = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));

  return json({
    categories: categories.results ?? [],
    items: items.results ?? [],
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
  const row = await ctx.db.prepare('SELECT * FROM mx_issues WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That entry has already gone.');

  await ctx.db.prepare('DELETE FROM mx_issues WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'mx.issue.delete', id, { day: row.day, itemId: row.item_id, qty: row.qty });
  return json({ ok: true });
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
  const row = await ctx.db.prepare('SELECT * FROM mx_purchases WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That purchase has already gone.');
  await ctx.db.prepare('DELETE FROM mx_purchases WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'mx.purchase.delete', id, { day: row.day, itemId: row.item_id });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export async function saveCounts(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) throw badRequest('Nothing was counted.');

  await ctx.db.batch(counts.map((c) => ctx.db.prepare(
    `INSERT INTO mx_counts (day, item_id, counted_qty, note) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(day, item_id) DO UPDATE SET counted_qty = excluded.counted_qty, note = excluded.note`,
  ).bind(day, Number(c.itemId), Number(c.qty) || 0, c.note ?? null)));

  await audit(ctx, 'mx.count', null, { day, items: counts.length });
  return json({ ok: true, recorded: counts.length });
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
  const [items, categories] = await Promise.all([
    ctx.db.prepare('SELECT * FROM mx_items WHERE active = 1 ORDER BY name').all(),
    ctx.db.prepare('SELECT name FROM mx_categories ORDER BY sort_order, name').all(),
  ]);

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
    'Name', 'Category', 'Unit', 'Restock level', 'On shelf now', 'Price each',
    'Everyday part', 'Note', ...detailLabels,
  ];

  const out = [header];
  for (const row of rows) {
    let parsed = {};
    try { parsed = row.attributes ? JSON.parse(row.attributes) : {}; } catch { parsed = {}; }
    const category = (categories.results ?? []).length
      ? (await ctx.db.prepare('SELECT name FROM mx_categories WHERE id = ?').bind(row.category_id).first())?.name ?? ''
      : '';
    out.push([
      row.name, category, row.unit, row.par_level, row.opening_stock,
      row.default_unit_cost, row.is_common ? 'yes' : '', row.note ?? '',
      ...detailLabels.map((label) => parsed[label] ?? ''),
    ]);
  }

  if (!rows.length) {
    out.push(['LED Bulb 15W', 'Electrical', 'pcs', 20, 0, 30, 'yes', 'example row — delete before importing',
      ...detailLabels.map((l) => (l === 'Size' ? '15W' : l === 'Colour' ? 'Daylight' : ''))]);
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
  if (!mapped.includes('name')) {
    throw badRequest('That file needs a “Name” column. Download the template and fill that in.');
  }
  if (rows.length > 1001) throw badRequest('That is more than 1000 parts in one file.');

  const [existingItems, existingCategories] = await Promise.all([
    ctx.db.prepare('SELECT id, name FROM mx_items').all(),
    ctx.db.prepare('SELECT id, name FROM mx_categories').all(),
  ]);
  const byName = new Map((existingItems.results ?? []).map((r) => [r.name.trim().toLowerCase(), r]));
  const categoryByName = new Map((existingCategories.results ?? []).map((r) => [r.name.trim().toLowerCase(), r]));

  const errors = [];
  const newCategories = new Set();
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

    const name = get('name');
    if (!name) { errors.push(`Row ${line}: no name.`); continue; }
    if (name.length > 100) { errors.push(`Row ${line}: that name is too long.`); continue; }
    if (/^example row/i.test(get('note'))) continue; // the template's own sample

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
    detailColumns: header.filter((_, c) => !mapped[c]).map((x) => String(x).trim()).filter(Boolean),
    errors: errors.slice(0, 25),
    errorCount: errors.length,
  };

  const preview = [...toCreate.slice(0, 10), ...toUpdate.slice(0, 10)].map((r) => ({
    line: r.line,
    name: r.name,
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

  const categoryId = (name) => (name ? categoryByName.get(name.toLowerCase())?.id ?? null : null);

  const statements = [
    ...toCreate.map((r) => ctx.db.prepare(
      `INSERT INTO mx_items (category_id, name, unit, par_level, opening_stock, default_unit_cost, is_common, note, attributes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(categoryId(r.categoryName), r.name, r.unit, r.parLevel, r.openingStock,
      r.defaultUnitCost, r.isCommon ? 1 : 0, r.note, r.attributes)),
    ...toUpdate.map((r) => ctx.db.prepare(
      `UPDATE mx_items SET category_id = ?2, unit = ?3, par_level = ?4, opening_stock = ?5,
              default_unit_cost = ?6, is_common = ?7, note = ?8, attributes = ?9, active = 1
        WHERE id = ?1`,
    ).bind(r.id, categoryId(r.categoryName), r.unit, r.parLevel, r.openingStock,
      r.defaultUnitCost, r.isCommon ? 1 : 0, r.note, r.attributes)),
  ];

  await ctx.db.batch(statements);
  await audit(ctx, 'mx.items.import', null, {
    created: toCreate.length, updated: toUpdate.length, categories: [...newCategories],
  });

  return json({ applied: true, created: toCreate.length, updated: toUpdate.length, summary });
}
