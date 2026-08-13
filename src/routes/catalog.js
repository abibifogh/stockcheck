import {
  badRequest, bool, int, isMissingTable, json, notFound, num, readJson,
  rethrowConstraint, str,
} from '../lib/http.js';
import { assertDayWritable } from '../lib/locks.js';
import { isDay } from '../util/dates.js';
import { loadDataset } from '../lib/analytics.js';
import { announce, readSettings } from '../lib/notify.js';

const UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack', 'loaf', 'tray', 'crate', 'box', 'bottle'];

// Settings that must never be exposed to the browser, whatever the role.
const PRIVATE_SETTINGS = new Set(['pin_pepper']);

/** Catalogue + settings in one call — the app's cold-start payload. */
export async function bootstrap(ctx) {
  const { db } = ctx;
  const [categories, ingredients, settings, suppliers] = await Promise.all([
    db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all(),
    db.prepare(
      `SELECT i.*, c.name AS category_name
       FROM ingredients i JOIN categories c ON c.id = i.category_id
       ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
    ).all(),
    db.prepare('SELECT key, value FROM settings').all(),
    db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY sort_order, name').all()
      .catch((err) => {
        if (isMissingTable(err)) return { results: [] };
        throw err;
      }),
  ]);

  const settingsMap = Object.fromEntries(
    (settings.results ?? [])
      .filter((r) => !PRIVATE_SETTINGS.has(r.key))
      .map((r) => [r.key, r.value]),
  );

  return json({
    categories: categories.results ?? [],
    ingredients: ingredients.results ?? [],
    suppliers: suppliers.results ?? [],
    settings: settingsMap,
    units: UNITS,
    role: ctx.session.user.role,
    user: {
      id: ctx.session.user.id,
      name: ctx.session.user.name,
      role: ctx.session.user.role,
    },
    permissions: ctx.session.permissions,
  });
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function listSuppliers(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM purchases p WHERE p.supplier = s.name) AS purchase_count
     FROM suppliers s ORDER BY s.active DESC, s.sort_order, s.name`,
  ).all();
  return json({ suppliers: rows.results ?? [] });
}

function supplierFields(body) {
  return {
    name: str(body.name, 'Supplier name', { required: true, max: 120 }),
    contact: str(body.contact, 'Contact person', { max: 120 }),
    phone: str(body.phone, 'Phone', { max: 60 }),
    note: str(body.note, 'Note', { max: 300 }),
    active: bool(body.active, true) ? 1 : 0,
    sort_order: int(body.sort_order, 'Sort order', { min: 0, max: 10000, fallback: 100 }),
  };
}

export async function createSupplier(ctx) {
  const f = supplierFields(await readJson(ctx.request));
  try {
    const row = await ctx.db.prepare(
      `INSERT INTO suppliers (name, contact, phone, note, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).bind(f.name, f.contact, f.phone, f.note, f.active, f.sort_order).first();
    return json({ supplier: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: `“${f.name}” is already on the supplier list.` });
  }
}

export async function updateSupplier(ctx, id) {
  const f = supplierFields(await readJson(ctx.request));
  const existing = await ctx.db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('Supplier not found');

  try {
    const row = await ctx.db.prepare(
      `UPDATE suppliers SET name = ?, contact = ?, phone = ?, note = ?, active = ?, sort_order = ?
       WHERE id = ? RETURNING *`,
    ).bind(f.name, f.contact, f.phone, f.note, f.active, f.sort_order, id).first();

    // Past purchases record the supplier by name, so a rename has to carry
    // through or the delivery history splits into two suppliers.
    if (existing.name !== f.name) {
      await ctx.db.prepare('UPDATE purchases SET supplier = ? WHERE supplier = ?')
        .bind(f.name, existing.name).run();
    }
    return json({ supplier: row });
  } catch (err) {
    rethrowConstraint(err, { unique: `“${f.name}” is already on the supplier list.` });
  }
}

/** Suppliers with delivery history are deactivated rather than deleted. */
export async function deleteSupplier(ctx, id) {
  const existing = await ctx.db.prepare('SELECT * FROM suppliers WHERE id = ?').bind(id).first();
  if (!existing) throw notFound('Supplier not found');

  const used = await ctx.db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE supplier = ?')
    .bind(existing.name).first();

  if (used?.n > 0) {
    const row = await ctx.db.prepare('UPDATE suppliers SET active = 0 WHERE id = ? RETURNING *')
      .bind(id).first();
    return json({ ok: true, retired: true, supplier: row });
  }

  await ctx.db.prepare('DELETE FROM suppliers WHERE id = ?').bind(id).run();
  return json({ ok: true, retired: false });
}

export async function createCategory(ctx) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Category name', { required: true, max: 80 });
  const sortOrder = int(body.sort_order, 'Sort order', { min: 0, max: 10000, fallback: 100 });
  try {
    const row = await ctx.db.prepare(
      'INSERT INTO categories (name, sort_order) VALUES (?, ?) RETURNING *',
    ).bind(name, sortOrder).first();
    return json({ category: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, { unique: `There is already a category called “${name}”.` });
  }
}

export async function updateCategory(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Category name', { required: true, max: 80 });
  const sortOrder = int(body.sort_order, 'Sort order', { min: 0, max: 10000, fallback: 100 });
  let row;
  try {
    row = await ctx.db.prepare(
      'UPDATE categories SET name = ?, sort_order = ? WHERE id = ? RETURNING *',
    ).bind(name, sortOrder, id).first();
  } catch (err) {
    rethrowConstraint(err, { unique: `There is already a category called “${name}”.` });
  }
  if (!row) throw notFound('Category not found');
  return json({ category: row });
}

export async function deleteCategory(ctx, id) {
  const inUse = await ctx.db.prepare('SELECT COUNT(*) AS n FROM ingredients WHERE category_id = ?')
    .bind(id).first();
  if (inUse?.n > 0) throw badRequest('Move or remove the ingredients in this category first');
  await ctx.db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

function ingredientFields(body, { partial = false } = {}) {
  const unit = str(body.unit, 'Unit', { required: !partial, max: 16, fallback: 'kg' });
  if (unit && !UNITS.includes(unit)) {
    throw badRequest(`Unit must be one of: ${UNITS.join(', ')}`);
  }
  return {
    category_id: int(body.category_id, 'Category', { min: 1, required: !partial }),
    name: str(body.name, 'Ingredient name', { required: !partial, max: 120 }),
    unit,
    step: num(body.step, 'Step', { min: 0.01, max: 1000, fallback: 1 }),
    par_level: num(body.par_level, 'Par level', { min: 0, max: 1e6, fallback: 0 }),
    default_unit_cost: num(body.default_unit_cost, 'Unit cost', { min: 0, max: 1e6, fallback: 0 }),
    opening_stock: num(body.opening_stock, 'Opening stock', { min: -1e6, max: 1e6, fallback: 0 }),
    is_core: bool(body.is_core, true) ? 1 : 0,
    // Made on the premises rather than delivered. Puts it on the bakery form,
    // and nowhere else.
    is_produced: bool(body.is_produced, false) ? 1 : 0,
    active: bool(body.active, true) ? 1 : 0,
    sort_order: int(body.sort_order, 'Sort order', { min: 0, max: 10000, fallback: 100 }),
  };
}

export async function createIngredient(ctx) {
  const body = await readJson(ctx.request);
  const f = ingredientFields(body);
  try {
    const row = await ctx.db.prepare(
      `INSERT INTO ingredients
        (category_id, name, unit, step, par_level, default_unit_cost, opening_stock,
         is_core, is_produced, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).bind(
      f.category_id, f.name, f.unit, f.step, f.par_level,
      f.default_unit_cost, f.opening_stock, f.is_core, f.is_produced, f.active, f.sort_order,
    ).first();
    return json({ ingredient: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, {
      unique: `There is already an ingredient called "${f.name}" in that category.`,
      foreignKey: 'That category no longer exists. Reload the page and try again.',
    });
  }
}

export async function updateIngredient(ctx, id) {
  const body = await readJson(ctx.request);
  const f = ingredientFields(body);

  // Moving an ingredient into a category that already has one of that name, or
  // into a category somebody else has since deleted, are both ordinary
  // mistakes — and both used to surface as an unexplained server error.
  let row;
  try {
    row = await ctx.db.prepare(
      `UPDATE ingredients SET
         category_id = ?, name = ?, unit = ?, step = ?, par_level = ?,
         default_unit_cost = ?, opening_stock = ?, is_core = ?, is_produced = ?,
         active = ?, sort_order = ?
       WHERE id = ? RETURNING *`,
    ).bind(
      f.category_id, f.name, f.unit, f.step, f.par_level,
      f.default_unit_cost, f.opening_stock, f.is_core, f.is_produced, f.active, f.sort_order, id,
    ).first();
  } catch (err) {
    const category = await ctx.db.prepare('SELECT name FROM categories WHERE id = ?')
      .bind(f.category_id).first();
    rethrowConstraint(err, {
      unique: category
        ? `“${category.name}” already has an ingredient called “${f.name}”. `
          + 'Rename one of them, or move it to a different category.'
        : `There is already an ingredient called “${f.name}” in that category.`,
      foreignKey: 'That category no longer exists. Reload the page and choose another.',
    });
  }

  if (!row) throw notFound('Ingredient not found');
  return json({ ingredient: row });
}

/**
 * Ingredients are retired, not deleted, once they carry history — removing one
 * would silently rewrite every past day's cost. A never-used ingredient is
 * genuinely deleted, since that is just a typo being cleaned up.
 */
export async function deleteIngredient(ctx, id) {
  const used = await ctx.db.prepare(
    `SELECT (SELECT COUNT(*) FROM usage WHERE ingredient_id = ?1) +
            (SELECT COUNT(*) FROM purchases WHERE ingredient_id = ?1) AS n`,
  ).bind(id).first();

  if (used?.n > 0) {
    const row = await ctx.db.prepare('UPDATE ingredients SET active = 0 WHERE id = ? RETURNING *')
      .bind(id).first();
    if (!row) throw notFound('Ingredient not found');
    return json({ ok: true, retired: true, ingredient: row });
  }

  await ctx.db.prepare('DELETE FROM ingredients WHERE id = ?').bind(id).run();
  return json({ ok: true, retired: false });
}

/**
 * The most recent unit cost paid for each ingredient. Used to pre-fill the
 * delivery form: prices rarely move between deliveries, so the last one is
 * almost always right, and when it is wrong the person keying it in is the one
 * holding the invoice.
 */
export async function lastUnitCosts(db) {
  const rows = await db.prepare(
    `SELECT p.ingredient_id, p.unit_cost, p.day, p.supplier
     FROM purchases p
     JOIN (
       SELECT ingredient_id, MAX(day || '-' || printf('%08d', id)) AS newest
       FROM purchases GROUP BY ingredient_id
     ) latest
       ON latest.ingredient_id = p.ingredient_id
      AND latest.newest = p.day || '-' || printf('%08d', p.id)`,
  ).all();

  return Object.fromEntries(
    (rows.results ?? []).map((r) => [r.ingredient_id, {
      unitCost: Number(r.unit_cost),
      day: r.day,
      supplier: r.supplier ?? null,
    }]),
  );
}

export async function getLastCosts(ctx) {
  return json({ lastCosts: await lastUnitCosts(ctx.db) });
}

export async function listPurchases(ctx) {
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  const clauses = [];
  const binds = [];
  if (from && isDay(from)) { clauses.push('p.day >= ?'); binds.push(from); }
  if (to && isDay(to)) { clauses.push('p.day <= ?'); binds.push(to); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await ctx.db.prepare(
    `SELECT p.*, i.name AS ingredient_name, i.unit
     FROM purchases p JOIN ingredients i ON i.id = p.ingredient_id
     ${where}
     ORDER BY p.day DESC, p.id DESC
     LIMIT 500`,
  ).bind(...binds).all();

  return json({
    purchases: rows.results ?? [],
    lastCosts: await lastUnitCosts(ctx.db),
  });
}

export async function createPurchase(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('Invalid date');
  await assertDayWritable(ctx.db, day);

  const ingredientId = int(body.ingredient_id, 'Ingredient', { min: 1, required: true });
  const qty = num(body.qty, 'Quantity', { min: 0.0001, max: 1e6, required: true });
  const unitCost = num(body.unit_cost, 'Unit cost', { min: 0, max: 1e6, required: true });
  const note = str(body.note, 'Note', { max: 500 });

  // How the supplier is captured is an admin decision, and it is enforced here
  // rather than only in the form — otherwise "choose from the list" would be a
  // suggestion that any stale browser tab could ignore.
  const modeRow = await ctx.db.prepare("SELECT value FROM settings WHERE key = 'supplier_mode'").first();
  const mode = modeRow?.value || 'select';

  let supplier = str(body.supplier, 'Supplier', { max: 120 });

  if (mode === 'off') {
    supplier = null;
  } else if (mode === 'select' && supplier) {
    const known = await ctx.db.prepare(
      'SELECT name FROM suppliers WHERE name = ? AND active = 1',
    ).bind(supplier).first();
    if (!known) {
      throw badRequest(`"${supplier}" is not on the supplier list. Add it under Setup → Suppliers first.`);
    }
  }

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO purchases (day, ingredient_id, qty, unit_cost, supplier, note)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).bind(day, ingredientId, qty, unitCost, supplier, note).first();
    return json({ purchase: row }, { status: 201 });
  } catch (err) {
    rethrowConstraint(err, {
      foreignKey: 'That ingredient no longer exists. Reload the page and try again.',
    });
  }
}

/**
 * Record a whole delivery in one go: one date and supplier, many line items.
 * A delivery note lists several things at once, so making somebody save them
 * one at a time is just a slower way of typing the same invoice.
 *
 * The lines are written as a single batch, so a delivery is never half-saved.
 */
export async function createDelivery(ctx) {
  const body = await readJson(ctx.request);

  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('Invalid date');

  await assertDayWritable(ctx.db, day);

  const note = str(body.note, 'Note', { max: 500 });
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw badRequest('Add at least one item to the delivery');
  if (items.length > 200) throw badRequest('That is a very large delivery — split it into two');

  const supplier = await resolveSupplier(ctx.db, body.supplier);

  const validIds = new Set(
    ((await ctx.db.prepare('SELECT id FROM ingredients WHERE active = 1').all()).results ?? [])
      .map((r) => r.id),
  );

  const statements = [];
  let total = 0;

  items.forEach((item, index) => {
    const ingredientId = int(item.ingredient_id, `Item ${index + 1} ingredient`, { min: 1, required: true });
    if (!validIds.has(ingredientId)) throw badRequest(`Item ${index + 1} is not a known ingredient`);

    const qty = num(item.qty, `Item ${index + 1} quantity`, { min: 0.0001, max: 1e6, required: true });
    const unitCost = num(item.unit_cost, `Item ${index + 1} unit cost`, { min: 0, max: 1e6, fallback: 0 });

    total += qty * unitCost;
    statements.push(
      ctx.db.prepare(
        `INSERT INTO purchases (day, ingredient_id, qty, unit_cost, supplier, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(day, ingredientId, qty, unitCost, supplier, note),
    );
  });

  statements.push(
    ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
      .bind(
        `${ctx.session.user.name} (${ctx.session.user.role})`,
        'delivery.create',
        day,
        JSON.stringify({ supplier, lines: items.length, total: Math.round(total * 100) / 100 }),
      ),
  );

  await ctx.db.batch(statements);

  return json({
    ok: true,
    day,
    supplier,
    lines: items.length,
    total: Math.round(total * 100) / 100,
  }, { status: 201 });
}

/** Apply the admin's supplier policy to an incoming value. */
async function resolveSupplier(db, raw) {
  const modeRow = await db.prepare("SELECT value FROM settings WHERE key = 'supplier_mode'").first();
  const mode = modeRow?.value || 'select';

  if (mode === 'off') return null;

  const supplier = str(raw, 'Supplier', { max: 120 });
  if (!supplier) return null;

  if (mode === 'select') {
    const known = await db.prepare('SELECT name FROM suppliers WHERE name = ? AND active = 1')
      .bind(supplier).first();
    if (!known) {
      throw badRequest(`"${supplier}" is not on the supplier list. Add it under Setup → Suppliers first.`);
    }
  }
  return supplier;
}

export async function deletePurchase(ctx, id) {
  await ctx.db.prepare('DELETE FROM purchases WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** Physical stock counts, used to expose the gap against book stock. */
export async function createStockCount(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('Invalid date');
  await assertDayWritable(ctx.db, day);

  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) throw badRequest('No counts supplied');
  if (counts.length > 500) throw badRequest('Too many counts in one submission');

  const statements = counts.map((c) => {
    const ingredientId = int(c.ingredient_id, 'Ingredient', { min: 1, required: true });
    const qty = num(c.counted_qty, 'Counted quantity', { min: 0, max: 1e6, required: true });
    return ctx.db.prepare(
      `INSERT INTO stock_counts (day, ingredient_id, counted_qty, note, status, counted_by)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
       ON CONFLICT(day, ingredient_id) DO UPDATE SET
         counted_qty = ?3,
         note        = ?4,
         counted_by  = ?5,
         -- Re-counting the same item on the same day starts the decision
         -- again; an already-accepted figure must not be edited underneath it.
         status      = 'pending',
         reviewed_by = NULL,
         reviewed_at = NULL,
         review_note = NULL`,
    ).bind(day, ingredientId, qty, str(c.note, 'Note', { max: 300 }), ctx.session.user.name);
  });

  await ctx.db.batch(statements);

  // Nothing happens to the shelf until somebody decides, so the people who can
  // decide are told rather than the counter having to chase anybody.
  const settings = await readSettings(ctx.db);
  if (settings.notify_count_pending !== '0') {
    const task = announce(ctx.db, ctx.env, {
      kind: 'count_pending',
      audience: 'users',
      title: `${statements.length} counted ingredient${statements.length === 1 ? '' : 's'} waiting for approval`,
      body: `${ctx.session.user.name} counted ${statements.length} item`
        + `${statements.length === 1 ? '' : 's'} in the kitchen store on ${day}. `
        + 'Stock stays as it is until the count is accepted.',
      link: '#/stock',
      linkLabel: 'Review the count',
    });
    if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(task);
    else await task.catch(() => {});
  }

  return json({ ok: true, saved: statements.length, awaitingApproval: true });
}

/**
 * Counts waiting on a decision, with what accepting each one would do.
 *
 * The difference is worked out against the book as it stands now rather than
 * stored when the count was taken, so a delivery keyed in late shows up here
 * before anybody accepts anything.
 */
export async function pendingStockCounts(ctx) {
  const ds = await loadDataset(ctx.db);
  const rows = await ctx.db.prepare(
    `SELECT c.*, i.name AS item_name, i.unit
       FROM stock_counts c JOIN ingredients i ON i.id = c.ingredient_id
      WHERE c.status = 'pending'
      ORDER BY c.day DESC, i.name`,
  ).all();

  const counts = (rows.results ?? []).map((row) => {
    const book = ds.ledger.stockOn(row.ingredient_id, row.day);
    const unitCost = ds.ledger.unitCostOn(row.ingredient_id, row.day);
    const difference = Math.round((Number(row.counted_qty) - book) * 1000) / 1000;
    return {
      id: row.id,
      day: row.day,
      ingredientId: row.ingredient_id,
      name: row.item_name,
      unit: row.unit,
      countedQty: Number(row.counted_qty),
      bookQty: Math.round(book * 1000) / 1000,
      difference,
      differenceValue: Math.round(difference * unitCost * 100) / 100,
      countedBy: row.counted_by,
      note: row.note,
    };
  });

  const byDay = new Map();
  for (const count of counts) {
    if (!byDay.has(count.day)) byDay.set(count.day, { day: count.day, items: 0, value: 0 });
    const group = byDay.get(count.day);
    group.items += 1;
    group.value = Math.round((group.value + count.differenceValue) * 100) / 100;
  }

  return json({ counts, days: [...byDay.values()] });
}

/**
 * Accept or reject counted figures.
 *
 * Accepting corrects the book to what was counted, from that date onwards.
 * Rejecting leaves every figure exactly as it was. Either way the decision and
 * who made it are kept.
 */
export async function reviewStockCounts(ctx) {
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
      "SELECT id FROM stock_counts WHERE day = ? AND status = 'pending'",
    ).bind(body.day).all();
    ids = (rows.results ?? []).map((r) => r.id);
    if (!ids.length) throw badRequest('There is nothing waiting on that date.');
  } else {
    throw badRequest('Nothing was selected.');
  }

  const holes = ids.map(() => '?').join(',');
  const result = await ctx.db.prepare(
    `UPDATE stock_counts
        SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
      WHERE id IN (${holes}) AND status = 'pending'`,
  ).bind(approve ? 'approved' : 'rejected', ctx.session.user.name, note, ...ids).run();

  const changed = result.meta?.changes ?? 0;
  await ctx.db.prepare(
    'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
  ).bind(
    `${ctx.session.user.name} (${ctx.session.user.role})`,
    approve ? 'stock.count.approve' : 'stock.count.reject',
    null,
    JSON.stringify({ counts: changed, note }),
  ).run().catch(() => {});

  return json({ ok: true, [approve ? 'approved' : 'rejected']: changed });
}

const ALLOWED_SETTINGS = new Set([
  'currency', 'timezone', 'property_name',
  'outsider_fee', 'allow_fill_usual', 'supplier_mode',
  'require_complete_entry', 'require_resubmit_approval', 'allow_recovery_pin',
  'restrict_cooks_to_everyday',
]);

const SETTING_RULES = {
  outsider_fee: (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1e6) throw badRequest('The outsider fee must be a positive amount');
    return String(n);
  },
  allow_fill_usual: (value) => (bool(value, true) ? '1' : '0'),
  require_complete_entry: (value) => (bool(value, true) ? '1' : '0'),
  require_resubmit_approval: (value) => (bool(value, true) ? '1' : '0'),
  allow_recovery_pin: (value) => (bool(value, true) ? '1' : '0'),
  restrict_cooks_to_everyday: (value) => (bool(value, false) ? '1' : '0'),
  supplier_mode: (value) => {
    const mode = String(value);
    if (!['select', 'free', 'off'].includes(mode)) throw badRequest('Unknown supplier setting');
    return mode;
  },
  currency: (value) => str(value, 'Currency', { required: true, max: 8 }).toUpperCase(),
};

export async function updateSettings(ctx) {
  const body = await readJson(ctx.request);
  const statements = [];

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS.has(key)) continue;
    const clean = SETTING_RULES[key]
      ? SETTING_RULES[key](value)
      : str(value, key, { max: 100, fallback: '' });
    statements.push(
      ctx.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
      ).bind(key, clean),
    );
  }

  if (!statements.length) throw badRequest('No recognised settings supplied');
  await ctx.db.batch(statements);

  const rows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  return json({
    settings: Object.fromEntries(
      (rows.results ?? []).filter((r) => !PRIVATE_SETTINGS.has(r.key)).map((r) => [r.key, r.value]),
    ),
  });
}
