import {
  badRequest, csvResponse, json, notFound, num, readJson, rethrowConstraint, str,
} from '../lib/http.js';
import {
  compare as compareRanges, loadDataset, overview as overviewReport, periodReport, stockReport,
} from '../lib/shop.js';
import { readAttributes } from './maintenance.js';
import { addDays, isDay, todayIn } from '../util/dates.js';
import { announce, readSettings } from '../lib/notify.js';

/**
 * The craft shop's API.
 *
 * The sale endpoint is the one that matters. Somebody is standing at a counter
 * with a customer waiting, so a sale goes in as one request — lines, payment
 * and change together — and nothing about it can be half-recorded. Everything
 * else on this screen exists to keep that one call fast.
 */

const PAYMENT_METHODS = ['cash', 'card'];

async function audit(ctx, action, entity, detail) {
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    action, entity == null ? null : String(entity),
    detail ? JSON.stringify(detail) : null,
  ).run().catch(() => {});
}

const money = (value) => Math.round(Number(value) * 100) / 100;

/**
 * Everything the till needs, in one call.
 *
 * Cost prices are left out unless the person asking can see reports. The
 * assistant needs the selling price and nothing else, and a screen that quietly
 * carries what everything cost you is a screen somebody will eventually read
 * over a shoulder.
 */
export async function bootstrap(ctx) {
  const [categories, items, settings] = await Promise.all([
    ctx.db.prepare('SELECT * FROM shop_categories ORDER BY sort_order, name').all(),
    ctx.db.prepare('SELECT * FROM shop_items WHERE active = 1 ORDER BY name').all(),
    ctx.db.prepare('SELECT key, value FROM settings').all(),
  ]);

  const map = Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value]));
  const seesCost = ctx.session.permissions.includes('shop_reports')
    || ctx.session.permissions.includes('shop_stock')
    || ctx.session.permissions.includes('shop_setup');

  return json({
    categories: categories.results ?? [],
    items: (items.results ?? []).map((i) => ({
      id: i.id,
      name: i.name,
      sku: i.sku,
      categoryId: i.category_id,
      unit: i.unit,
      sellPrice: Number(i.sell_price) || 0,
      attributes: i.attributes ?? null,
      isCommon: Number(i.is_common) === 1,
      ...(seesCost ? {
        unitCost: Number(i.default_unit_cost) || 0,
        parLevel: Number(i.par_level) || 0,
        openingStock: Number(i.opening_stock) || 0,
      } : {}),
    })),
    settings: {
      currency: map.currency || 'GHS',
      timezone: map.timezone || 'Africa/Accra',
      shopName: map.shop_name || 'Craft Shop',
      lowCoverDays: Number(map.shop_low_cover_days) || 21,
    },
    seesCost,
    today: todayIn(map.timezone || 'Africa/Accra'),
  });
}

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------

/**
 * Ring up one sale.
 *
 * The whole basket, the payment method and the change all go in together, in
 * one batch. A sale that is half-written is worse than one that failed: the
 * customer has walked off with the goods and the shelf still says they are
 * there.
 *
 * Prices are taken from the item list on the server, not from what the browser
 * sent. The browser decides what to buy; the shop decides what it costs.
 */
export async function createSale(ctx) {
  const body = await readJson(ctx.request);

  const settings = await readSettings(ctx.db);
  const today = todayIn(settings.timezone || 'Africa/Accra');
  const day = body.day && isDay(body.day) ? body.day : today;
  if (day > today) throw badRequest('A sale cannot be dated in the future.');

  const method = String(body.paymentMethod ?? 'cash').toLowerCase();
  if (!PAYMENT_METHODS.includes(method)) {
    throw badRequest('Payment must be cash or card.');
  }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('There is nothing in the basket.');
  if (lines.length > 100) throw badRequest('That is a lot for one sale — 100 lines is the limit.');

  const wanted = new Map();
  for (const line of lines) {
    const itemId = Number(line.itemId);
    const qty = num(line.qty, 'Quantity', { min: 0.0001, max: 100000 });
    if (!Number.isFinite(itemId) || itemId <= 0) throw badRequest('A product was not recognised.');
    wanted.set(itemId, (wanted.get(itemId) ?? 0) + qty);
  }

  const holes = [...wanted.keys()].map(() => '?').join(',');
  const rows = await ctx.db.prepare(
    `SELECT id, name, sell_price FROM shop_items WHERE id IN (${holes}) AND active = 1`,
  ).bind(...wanted.keys()).all();

  const priced = new Map((rows.results ?? []).map((r) => [r.id, r]));
  const missing = [...wanted.keys()].filter((id) => !priced.has(id));
  if (missing.length) {
    throw badRequest('Something in the basket is no longer on the product list. Reload and try again.');
  }

  const clean = [...wanted.entries()].map(([itemId, qty]) => {
    const item = priced.get(itemId);
    const unitPrice = money(item.sell_price);
    // A price of zero is almost always a product somebody never got round to
    // pricing, and letting it through means giving stock away at the counter.
    if (!(unitPrice > 0)) {
      throw badRequest(`“${item.name}” has no selling price set. A manager can set one under Shop setup.`);
    }
    return { itemId, qty, unitPrice, lineTotal: money(unitPrice * qty) };
  });

  const total = money(clean.reduce((n, l) => n + l.lineTotal, 0));

  // Cash gets a drawer reckoning; a card does not. Tendered is optional even
  // for cash — plenty of sales are paid with the exact note.
  let tendered = null;
  let changeDue = null;
  if (method === 'cash' && body.tendered != null && body.tendered !== '') {
    tendered = num(body.tendered, 'Amount given', { min: 0, max: 10000000 });
    if (tendered < total) {
      throw badRequest(`That is less than the total of ${total.toFixed(2)}.`);
    }
    changeDue = money(tendered - total);
  }

  const sale = await ctx.db.prepare(
    `INSERT INTO shop_sales (day, payment_method, total, tendered, change_due, sold_by, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id, at`,
  ).bind(
    day, method, total, tendered, changeDue, ctx.session.user.name,
    str(body.note, 'Note', { max: 200, fallback: '' }) || null,
  ).first();

  try {
    await ctx.db.batch(clean.map((line) => ctx.db.prepare(
      'INSERT INTO shop_sale_lines (sale_id, item_id, qty, unit_price, line_total) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(sale.id, line.itemId, line.qty, line.unitPrice, line.lineTotal)));
  } catch (err) {
    // A sale with no lines is a phantom in every report. Take it back out.
    await ctx.db.prepare('DELETE FROM shop_sales WHERE id = ?').bind(sale.id).run().catch(() => {});
    rethrowConstraint(err, { foreignKey: 'One of those products is no longer on the list.' });
    throw err;
  }

  await audit(ctx, 'shop.sale', sale.id, { day, method, total, lines: clean.length });

  return json({
    ok: true,
    id: sale.id,
    day,
    at: sale.at,
    total,
    tendered,
    changeDue,
    paymentMethod: method,
    soldBy: ctx.session.user.name,
    lines: clean.map((l) => ({
      itemId: l.itemId,
      name: priced.get(l.itemId).name,
      qty: l.qty,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    })),
  }, { status: 201 });
}

/** Recent sales, for the strip under the till and for the day's reckoning. */
export async function listSales(ctx) {
  const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 25, 200);
  const day = ctx.url.searchParams.get('day');
  const mine = ctx.url.searchParams.get('mine') === '1';

  const where = [];
  const binds = [];
  if (day && isDay(day)) { where.push('s.day = ?'); binds.push(day); }
  if (mine) { where.push('s.sold_by = ?'); binds.push(ctx.session.user.name); }

  const rows = await ctx.db.prepare(
    `SELECT s.*, COUNT(l.id) AS line_count, SUM(l.qty) AS units
       FROM shop_sales s LEFT JOIN shop_sale_lines l ON l.sale_id = s.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY s.id
      ORDER BY s.id DESC
      LIMIT ?`,
  ).bind(...binds, limit).all();

  return json({
    sales: (rows.results ?? []).map((s) => ({
      id: s.id,
      day: s.day,
      at: s.at,
      paymentMethod: s.payment_method,
      total: Number(s.total) || 0,
      tendered: s.tendered == null ? null : Number(s.tendered),
      changeDue: s.change_due == null ? null : Number(s.change_due),
      soldBy: s.sold_by,
      note: s.note,
      lineCount: Number(s.line_count) || 0,
      units: Number(s.units) || 0,
      voided: Number(s.voided) === 1,
      voidedBy: s.voided_by,
      voidReason: s.void_reason,
    })),
  });
}

/** One sale in full, for the receipt and for deciding whether to void it. */
export async function getSale(ctx, id) {
  const sale = await ctx.db.prepare('SELECT * FROM shop_sales WHERE id = ?').bind(Number(id)).first();
  if (!sale) throw notFound('That sale could not be found.');

  const lines = await ctx.db.prepare(
    `SELECT l.*, i.name, i.unit, i.attributes
       FROM shop_sale_lines l JOIN shop_items i ON i.id = l.item_id
      WHERE l.sale_id = ? ORDER BY l.id`,
  ).bind(sale.id).all();

  return json({
    id: sale.id,
    day: sale.day,
    at: sale.at,
    paymentMethod: sale.payment_method,
    total: Number(sale.total) || 0,
    tendered: sale.tendered == null ? null : Number(sale.tendered),
    changeDue: sale.change_due == null ? null : Number(sale.change_due),
    soldBy: sale.sold_by,
    note: sale.note,
    voided: Number(sale.voided) === 1,
    voidedBy: sale.voided_by,
    voidedAt: sale.voided_at,
    voidReason: sale.void_reason,
    lines: (lines.results ?? []).map((l) => ({
      itemId: l.item_id,
      name: l.name,
      unit: l.unit,
      attributes: l.attributes ?? null,
      qty: Number(l.qty) || 0,
      unitPrice: Number(l.unit_price) || 0,
      lineTotal: Number(l.line_total) || 0,
    })),
  });
}

/**
 * Take a sale back out — without deleting it.
 *
 * A voided sale stays visible, with who voided it and why. A till that lets
 * somebody quietly remove a sale is a till that gets robbed, and the whole
 * value of a stock system that starts at the counter is that the counter cannot
 * be edited afterwards.
 */
export async function voidSale(ctx, id) {
  const body = await readJson(ctx.request).catch(() => ({}));
  const reason = str(body.reason, 'Reason', { max: 200, fallback: '' }) || null;
  if (!reason) throw badRequest('Say why this sale is being voided.');

  const sale = await ctx.db.prepare('SELECT * FROM shop_sales WHERE id = ?').bind(Number(id)).first();
  if (!sale) throw notFound('That sale could not be found.');
  if (Number(sale.voided) === 1) throw badRequest('That sale has already been voided.');

  await ctx.db.prepare(
    `UPDATE shop_sales
        SET voided = 1, voided_by = ?, voided_at = datetime('now'), void_reason = ?
      WHERE id = ?`,
  ).bind(ctx.session.user.name, reason, sale.id).run();

  await audit(ctx, 'shop.sale.void', sale.id, { day: sale.day, total: sale.total, reason });
  return json({ ok: true });
}

/**
 * The day's reckoning: what should be in the drawer, and what is on the card
 * machine.
 *
 * The point of separating them is that only one of the two can be short.
 */
export async function tillReport(ctx) {
  const settings = await readSettings(ctx.db);
  const day = ctx.url.searchParams.get('day') || todayIn(settings.timezone || 'Africa/Accra');
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const rows = await ctx.db.prepare(
    `SELECT payment_method, COUNT(*) AS n, SUM(total) AS total
       FROM shop_sales WHERE day = ? AND voided = 0 GROUP BY payment_method`,
  ).bind(day).all();

  const voided = await ctx.db.prepare(
    'SELECT COUNT(*) AS n, SUM(total) AS total FROM shop_sales WHERE day = ? AND voided = 1',
  ).bind(day).first();

  const byPerson = await ctx.db.prepare(
    `SELECT sold_by, COUNT(*) AS n, SUM(total) AS total
       FROM shop_sales WHERE day = ? AND voided = 0
      GROUP BY sold_by ORDER BY total DESC`,
  ).bind(day).all();

  const methods = Object.fromEntries((rows.results ?? []).map((r) => [
    r.payment_method, { count: Number(r.n) || 0, total: money(r.total || 0) },
  ]));

  return json({
    day,
    currency: settings.currency || 'GHS',
    cash: methods.cash ?? { count: 0, total: 0 },
    card: methods.card ?? { count: 0, total: 0 },
    total: money((methods.cash?.total ?? 0) + (methods.card?.total ?? 0)),
    saleCount: (methods.cash?.count ?? 0) + (methods.card?.count ?? 0),
    voided: { count: Number(voided?.n) || 0, total: money(voided?.total || 0) },
    byPerson: (byPerson.results ?? []).map((r) => ({
      name: r.sold_by || 'not recorded',
      count: Number(r.n) || 0,
      total: money(r.total || 0),
    })),
  });
}

// ---------------------------------------------------------------------------
// Buying stock in
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
       FROM shop_purchases p JOIN shop_items i ON i.id = p.item_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.day DESC, p.id DESC LIMIT 500`,
  ).bind(...binds).all();

  return json({ purchases: rows.results ?? [] });
}

export async function lastCosts(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT item_id, unit_cost, day FROM shop_purchases p
      WHERE p.id = (SELECT id FROM shop_purchases WHERE item_id = p.item_id ORDER BY day DESC, id DESC LIMIT 1)`,
  ).all();
  return json({
    costs: Object.fromEntries((rows.results ?? [])
      .map((r) => [r.item_id, { unitCost: r.unit_cost, day: r.day }])),
  });
}

export async function createDelivery(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const supplier = str(body.supplier, 'Supplier', { max: 120, fallback: '' }) || null;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw badRequest('Add at least one product to the delivery.');
  if (lines.length > 100) throw badRequest('That is a lot of lines for one delivery — 100 is the limit.');

  const clean = lines.map((line) => {
    const itemId = Number(line.itemId);
    const qty = num(line.qty, 'Quantity', { min: 0.0001, max: 1000000 });
    const unitCost = num(line.unitCost, 'Unit cost', { min: 0, max: 1000000 });
    if (!Number.isFinite(itemId) || itemId <= 0) throw badRequest('A product was not recognised.');
    return { itemId, qty, unitCost };
  });

  try {
    await ctx.db.batch(clean.map((line) => ctx.db.prepare(
      'INSERT INTO shop_purchases (day, item_id, qty, unit_cost, supplier, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(day, line.itemId, line.qty, line.unitCost, supplier, note)));
  } catch (err) {
    rethrowConstraint(err, { foreignKey: 'One of those products is no longer on the list.' });
    throw err;
  }

  await audit(ctx, 'shop.delivery', null, { day, lines: clean.length, supplier });
  return json({ ok: true, recorded: clean.length }, { status: 201 });
}

export async function deletePurchase(ctx, id) {
  const row = await ctx.db.prepare('SELECT * FROM shop_purchases WHERE id = ?').bind(Number(id)).first();
  if (!row) throw notFound('That purchase has already gone.');
  await ctx.db.prepare('DELETE FROM shop_purchases WHERE id = ?').bind(Number(id)).run();
  await audit(ctx, 'shop.purchase.delete', id, { day: row.day, itemId: row.item_id });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Stock and counts
// ---------------------------------------------------------------------------

export async function stock(ctx) {
  const ds = await loadDataset(ctx.db);
  const asOf = ctx.url.searchParams.get('asOf') || todayIn(ds.timezone);
  if (!isDay(asOf)) throw badRequest('That date is not valid.');
  return json(stockReport(ds, asOf));
}

export async function saveCounts(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('That date is not valid.');

  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) throw badRequest('Nothing was counted.');
  if (counts.length > 1000) throw badRequest('That is more than 1000 products in one count.');

  for (const c of counts) {
    const qty = Number(c.qty);
    if (!Number.isFinite(qty) || qty < 0) throw badRequest('A counted quantity cannot be negative.');
    if (qty > 1000000) throw badRequest('That counted quantity looks wrong.');
  }

  await ctx.db.batch(counts.map((c) => ctx.db.prepare(
    `INSERT INTO shop_counts (day, item_id, counted_qty, note, status, counted_by)
     VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
     ON CONFLICT(day, item_id) DO UPDATE SET
       counted_qty = excluded.counted_qty,
       note        = excluded.note,
       counted_by  = excluded.counted_by,
       status      = 'pending',
       reviewed_by = NULL,
       reviewed_at = NULL,
       review_note = NULL`,
  ).bind(day, Number(c.itemId), Number(c.qty) || 0, c.note ?? null, ctx.session.user.name)));

  await audit(ctx, 'shop.count', null, { day, items: counts.length });

  const settings = await readSettings(ctx.db);
  // Shares the parts store's switch: it is one question — "tell me when a
  // count needs a decision" — and two toggles for it would be two ways to be
  // half switched off.
  if (settings.notify_count_pending !== '0') {
    const task = announce(ctx.db, ctx.env, {
      kind: 'shop_count_pending',
      audience: 'users',
      title: `${counts.length} counted shop item${counts.length === 1 ? '' : 's'} waiting for approval`,
      body: `${ctx.session.user.name} counted ${counts.length} product`
        + `${counts.length === 1 ? '' : 's'} in the craft shop on ${day}. `
        + 'Stock stays as it is until the count is accepted.',
      link: '#/shop-stock',
      linkLabel: 'Review the count',
    });
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  return json({ ok: true, recorded: counts.length, awaitingApproval: true });
}

export async function pendingCounts(ctx) {
  const ds = await loadDataset(ctx.db);
  const rows = await ctx.db.prepare(
    `SELECT c.*, i.name AS item_name, i.unit, i.attributes
       FROM shop_counts c JOIN shop_items i ON i.id = c.item_id
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
      differenceValue: money(difference * unitCost),
      countedBy: row.counted_by,
      note: row.note,
    };
  });

  const byDay = new Map();
  for (const count of counts) {
    if (!byDay.has(count.day)) byDay.set(count.day, { day: count.day, items: 0, value: 0 });
    const group = byDay.get(count.day);
    group.items += 1;
    group.value = money(group.value + count.differenceValue);
  }

  return json({ counts, days: [...byDay.values()] });
}

export async function reviewCounts(ctx) {
  const body = await readJson(ctx.request);
  const approve = body.approve === true;
  const note = str(body.note, 'Note', { max: 300, fallback: '' }) || null;

  let ids;
  if (Array.isArray(body.ids)) {
    ids = body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw badRequest('Nothing was selected.');
    if (ids.length > 1000) throw badRequest('That is too many at once.');
  } else if (body.day && isDay(body.day)) {
    const rows = await ctx.db.prepare(
      "SELECT id FROM shop_counts WHERE day = ? AND status = 'pending'",
    ).bind(body.day).all();
    ids = (rows.results ?? []).map((r) => r.id);
    if (!ids.length) throw badRequest('There is nothing waiting on that date.');
  } else {
    throw badRequest('Nothing was selected.');
  }

  const holes = ids.map(() => '?').join(',');
  const result = await ctx.db.prepare(
    `UPDATE shop_counts
        SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
      WHERE id IN (${holes}) AND status = 'pending'`,
  ).bind(approve ? 'approved' : 'rejected', ctx.session.user.name, note, ...ids).run();

  const changed = result.meta?.changes ?? 0;
  await audit(ctx, approve ? 'shop.count.approve' : 'shop.count.reject', null, { counts: changed, note });
  return json({ ok: true, [approve ? 'approved' : 'rejected']: changed });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export async function overview(ctx) {
  const ds = await loadDataset(ctx.db);
  return json(overviewReport(ds, todayIn(ds.timezone)));
}

export async function report(ctx) {
  const ds = await loadDataset(ctx.db);
  const today = todayIn(ds.timezone);
  const to = ctx.url.searchParams.get('to') || today;
  const from = ctx.url.searchParams.get('from') || addDays(to, -29);
  if (!isDay(from) || !isDay(to)) throw badRequest('Those dates are not valid.');
  if (from > to) throw badRequest('The start date is after the end date.');
  return json(periodReport(ds, from, to));
}

export async function compare(ctx) {
  const p = ctx.url.searchParams;
  const ranges = [
    { from: p.get('aFrom'), to: p.get('aTo') },
    { from: p.get('bFrom'), to: p.get('bTo') },
  ];
  for (const r of ranges) {
    if (!isDay(r.from) || !isDay(r.to)) throw badRequest('Both periods need a start and an end date.');
    if (r.from > r.to) throw badRequest('A period starts after it ends.');
  }
  const ds = await loadDataset(ctx.db);
  return json(compareRanges(ds, ranges[0], ranges[1]));
}

/** Sales, one line per product per sale, for a spreadsheet. */
export async function exportCsv(ctx) {
  const p = ctx.url.searchParams;
  const to = p.get('to') || todayIn('Africa/Accra');
  const from = p.get('from') || addDays(to, -29);
  if (!isDay(from) || !isDay(to)) throw badRequest('Those dates are not valid.');

  const rows = await ctx.db.prepare(
    `SELECT s.day, s.at, s.id AS sale_id, s.payment_method, s.sold_by, s.voided,
            i.name AS product, i.sku, l.qty, l.unit_price, l.line_total
       FROM shop_sale_lines l
       JOIN shop_sales s ON s.id = l.sale_id
       JOIN shop_items i ON i.id = l.item_id
      WHERE s.day >= ? AND s.day <= ?
      ORDER BY s.day, s.id, l.id`,
  ).bind(from, to).all();

  const out = [['Date', 'Time', 'Sale', 'Product', 'SKU', 'Quantity', 'Unit price', 'Line total', 'Payment', 'Sold by', 'Voided']];
  for (const r of rows.results ?? []) {
    out.push([
      r.day, String(r.at ?? '').slice(11, 16), r.sale_id, r.product, r.sku ?? '',
      r.qty, r.unit_price, r.line_total, r.payment_method, r.sold_by ?? '',
      Number(r.voided) === 1 ? 'yes' : '',
    ]);
  }
  return csvResponse(`craft-shop-sales-${from}-to-${to}.csv`, out);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function createCategory(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Name', { required: true, max: 60 });
  try {
    const row = await ctx.db.prepare(
      'INSERT INTO shop_categories (name, sort_order) VALUES (?1, ?2) RETURNING id',
    ).bind(name, Number(body.sortOrder) || 100).first();
    await audit(ctx, 'shop.category.create', row.id, { name });
    return json({ ok: true, id: row.id }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: 'There is already a category with that name.' });
    throw err;
  }
}

function readItemBody(body, existing = null) {
  const sellPrice = num(body.sellPrice, 'Selling price', {
    min: 0, max: 10000000, fallback: existing ? Number(existing.sell_price) : 0,
  });
  const unitCost = num(body.unitCost, 'Cost price', {
    min: 0, max: 10000000, fallback: existing ? Number(existing.default_unit_cost) : 0,
  });

  return {
    name: str(body.name, 'Name', {
      required: !existing, max: 100, fallback: existing?.name ?? null,
    }),
    sku: str(body.sku, 'Code', { max: 40, fallback: existing?.sku ?? '' }) || null,
    unit: str(body.unit, 'Unit', { max: 20, fallback: existing?.unit ?? 'pcs' }) || 'pcs',
    categoryId: body.categoryId == null || body.categoryId === ''
      ? (existing?.category_id ?? null) : Number(body.categoryId),
    sellPrice,
    unitCost,
    openingStock: num(body.openingStock, 'On the shelf now', {
      min: 0, max: 1000000, fallback: existing ? Number(existing.opening_stock) : 0,
    }),
    parLevel: num(body.parLevel, 'Restock level', {
      min: 0, max: 1000000, fallback: existing ? Number(existing.par_level) : 0,
    }),
    attributes: body.attributes === undefined
      ? (existing?.attributes ?? null) : readAttributes(body.attributes),
    isCommon: body.isCommon === undefined
      ? (existing ? Number(existing.is_common) : 1) : (body.isCommon ? 1 : 0),
    active: body.active === undefined
      ? (existing ? Number(existing.active) : 1) : (body.active ? 1 : 0),
  };
}

export async function createItem(ctx) {
  const body = await readJson(ctx.request);
  const v = readItemBody(body);

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO shop_items
         (name, sku, category_id, unit, sell_price, default_unit_cost, opening_stock,
          par_level, attributes, is_common, active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id`,
    ).bind(
      v.name, v.sku, v.categoryId, v.unit, v.sellPrice, v.unitCost,
      v.openingStock, v.parLevel, v.attributes, v.isCommon, v.active,
    ).first();

    await audit(ctx, 'shop.item.create', row.id, { name: v.name, sellPrice: v.sellPrice });
    return json({ ok: true, id: row.id }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, {
      unique: 'There is already a product with that name.',
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }
}

export async function updateItem(ctx, id) {
  const body = await readJson(ctx.request);
  const existing = await ctx.db.prepare('SELECT * FROM shop_items WHERE id = ?')
    .bind(Number(id)).first();
  if (!existing) throw notFound('That product no longer exists.');

  const v = readItemBody(body, existing);

  try {
    await ctx.db.prepare(
      `UPDATE shop_items SET
         name = ?1, sku = ?2, category_id = ?3, unit = ?4, sell_price = ?5,
         default_unit_cost = ?6, opening_stock = ?7, par_level = ?8,
         attributes = ?9, is_common = ?10, active = ?11
       WHERE id = ?12`,
    ).bind(
      v.name, v.sku, v.categoryId, v.unit, v.sellPrice, v.unitCost,
      v.openingStock, v.parLevel, v.attributes, v.isCommon, v.active, existing.id,
    ).run();
  } catch (err) {
    rethrowConstraint(err, {
      unique: 'There is already a product with that name.',
      foreignKey: 'That category no longer exists.',
    });
    throw err;
  }

  await audit(ctx, 'shop.item.update', existing.id, { name: v.name, sellPrice: v.sellPrice });
  return json({ ok: true });
}

/**
 * Remove products, keeping the ones that have a history.
 *
 * A product that has ever been sold is retired rather than deleted, so past
 * months still add up to what they actually took.
 */
export async function removeItems(ctx) {
  const body = await readJson(ctx.request);
  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) throw badRequest('Nothing was selected.');
  if (ids.length > 500) throw badRequest('That is too many at once — 500 is the limit.');

  const holes = ids.map(() => '?').join(',');
  const used = await ctx.db.prepare(
    `SELECT DISTINCT item_id FROM shop_sale_lines WHERE item_id IN (${holes})
     UNION SELECT DISTINCT item_id FROM shop_purchases WHERE item_id IN (${holes})
     UNION SELECT DISTINCT item_id FROM shop_counts WHERE item_id IN (${holes})`,
  ).bind(...ids, ...ids, ...ids).all();

  const keep = new Set((used.results ?? []).map((r) => r.item_id));
  const deletable = ids.filter((id) => !keep.has(id));
  const retirable = ids.filter((id) => keep.has(id));

  let removed = 0;
  let retired = 0;

  if (deletable.length) {
    const h1 = deletable.map(() => '?').join(',');
    const result = await ctx.db.prepare(`DELETE FROM shop_items WHERE id IN (${h1})`)
      .bind(...deletable).run();
    removed = result.meta?.changes ?? 0;
  }
  if (retirable.length) {
    const h2 = retirable.map(() => '?').join(',');
    const result = await ctx.db.prepare(
      `UPDATE shop_items SET active = 0 WHERE id IN (${h2}) AND active = 1`,
    ).bind(...retirable).run();
    retired = result.meta?.changes ?? 0;
  }

  await audit(ctx, 'shop.item.remove', null, { requested: ids.length, removed, retired });
  return json({ ok: true, removed, retired, requested: ids.length });
}

/** Change what the shop is called, and when it starts warning about cover. */
export async function updateSettings(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.shopName, 'Shop name', { max: 60, fallback: '' }) || 'Craft Shop';
  const cover = num(body.lowCoverDays, 'Days of cover', { min: 1, max: 365, fallback: 21 });

  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('shop_name', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(name),
    ctx.db.prepare("INSERT INTO settings (key, value) VALUES ('shop_low_cover_days', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1").bind(String(Math.round(cover))),
  ]);

  await audit(ctx, 'shop.settings.update', null, { name, cover });
  return json({ ok: true });
}
