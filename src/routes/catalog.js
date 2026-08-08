import { badRequest, bool, int, json, notFound, num, readJson, str } from '../lib/http.js';
import { isDay } from '../util/dates.js';

const UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack', 'loaf', 'tray', 'crate', 'box', 'bottle'];

/** Catalogue + settings in one call — the app's cold-start payload. */
export async function bootstrap(ctx) {
  const { db } = ctx;
  const [categories, ingredients, settings] = await Promise.all([
    db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all(),
    db.prepare(
      `SELECT i.*, c.name AS category_name
       FROM ingredients i JOIN categories c ON c.id = i.category_id
       ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
    ).all(),
    db.prepare('SELECT key, value FROM settings').all(),
  ]);

  return json({
    categories: categories.results ?? [],
    ingredients: ingredients.results ?? [],
    settings: Object.fromEntries((settings.results ?? []).map((r) => [r.key, r.value])),
    units: UNITS,
    role: ctx.session.role,
  });
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
    if (String(err).includes('UNIQUE')) throw badRequest(`Category "${name}" already exists`);
    throw err;
  }
}

export async function updateCategory(ctx, id) {
  const body = await readJson(ctx.request);
  const name = str(body.name, 'Category name', { required: true, max: 80 });
  const sortOrder = int(body.sort_order, 'Sort order', { min: 0, max: 10000, fallback: 100 });
  const row = await ctx.db.prepare(
    'UPDATE categories SET name = ?, sort_order = ? WHERE id = ? RETURNING *',
  ).bind(name, sortOrder, id).first();
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
        (category_id, name, unit, step, par_level, default_unit_cost, opening_stock, is_core, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).bind(
      f.category_id, f.name, f.unit, f.step, f.par_level,
      f.default_unit_cost, f.opening_stock, f.is_core, f.active, f.sort_order,
    ).first();
    return json({ ingredient: row }, { status: 201 });
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw badRequest(`"${f.name}" already exists in that category`);
    if (String(err).includes('FOREIGN KEY')) throw badRequest('Unknown category');
    throw err;
  }
}

export async function updateIngredient(ctx, id) {
  const body = await readJson(ctx.request);
  const f = ingredientFields(body);
  const row = await ctx.db.prepare(
    `UPDATE ingredients SET
       category_id = ?, name = ?, unit = ?, step = ?, par_level = ?,
       default_unit_cost = ?, opening_stock = ?, is_core = ?, active = ?, sort_order = ?
     WHERE id = ? RETURNING *`,
  ).bind(
    f.category_id, f.name, f.unit, f.step, f.par_level,
    f.default_unit_cost, f.opening_stock, f.is_core, f.active, f.sort_order, id,
  ).first();
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

  return json({ purchases: rows.results ?? [] });
}

export async function createPurchase(ctx) {
  const body = await readJson(ctx.request);
  const day = str(body.day, 'Date', { required: true, max: 10 });
  if (!isDay(day)) throw badRequest('Invalid date');
  const ingredientId = int(body.ingredient_id, 'Ingredient', { min: 1, required: true });
  const qty = num(body.qty, 'Quantity', { min: 0.0001, max: 1e6, required: true });
  const unitCost = num(body.unit_cost, 'Unit cost', { min: 0, max: 1e6, required: true });
  const supplier = str(body.supplier, 'Supplier', { max: 120 });
  const note = str(body.note, 'Note', { max: 500 });

  try {
    const row = await ctx.db.prepare(
      `INSERT INTO purchases (day, ingredient_id, qty, unit_cost, supplier, note)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    ).bind(day, ingredientId, qty, unitCost, supplier, note).first();
    return json({ purchase: row }, { status: 201 });
  } catch (err) {
    if (String(err).includes('FOREIGN KEY')) throw badRequest('Unknown ingredient');
    throw err;
  }
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
  const counts = Array.isArray(body.counts) ? body.counts : [];
  if (!counts.length) throw badRequest('No counts supplied');
  if (counts.length > 500) throw badRequest('Too many counts in one submission');

  const statements = counts.map((c) => {
    const ingredientId = int(c.ingredient_id, 'Ingredient', { min: 1, required: true });
    const qty = num(c.counted_qty, 'Counted quantity', { min: 0, max: 1e6, required: true });
    return ctx.db.prepare(
      `INSERT INTO stock_counts (day, ingredient_id, counted_qty, note)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(day, ingredient_id) DO UPDATE SET counted_qty = ?3, note = ?4`,
    ).bind(day, ingredientId, qty, str(c.note, 'Note', { max: 300 }));
  });

  await ctx.db.batch(statements);
  return json({ ok: true, saved: statements.length });
}

const ALLOWED_SETTINGS = new Set(['currency', 'timezone', 'property_name', 'default_outsider_fee']);

export async function updateSettings(ctx) {
  const body = await readJson(ctx.request);
  const statements = [];
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS.has(key)) continue;
    statements.push(
      ctx.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2',
      ).bind(key, str(value, key, { max: 100, fallback: '' })),
    );
  }
  if (!statements.length) throw badRequest('No recognised settings supplied');
  await ctx.db.batch(statements);
  const rows = await ctx.db.prepare('SELECT key, value FROM settings').all();
  return json({ settings: Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value])) });
}
