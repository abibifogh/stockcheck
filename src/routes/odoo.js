import {
  HttpError, badRequest, bool, int, isMissingTable, json, num, readJson, str,
} from '../lib/http.js';
import { assertDayWritable } from '../lib/locks.js';
import { isDay } from '../util/dates.js';
import {
  MAX_ORDERS, OdooError, configProblem, odooConfig, parsePoNumbers, readOrders,
} from '../lib/odoo.js';

/**
 * Purchases pulled from Odoo by PO number.
 *
 * Three steps, and only the last one writes:
 *
 *   preview  — read the orders out of Odoo and say, line by line, what would
 *              come across, what is already here, and what nobody has matched
 *              to an ingredient yet.
 *   mappings — remember which ingredient an Odoo product is. Asked once per
 *              product; every later order uses the answer.
 *   import   — read the orders out of Odoo again and record them.
 *
 * Import reads Odoo itself rather than taking the lines the browser was shown.
 * The figures that land in the cost reports are Odoo's, not whatever a page
 * left open since yesterday happens to say — and nobody can type a price into
 * the request and have it recorded as though it came from the order.
 */

/** Unit costs keep four places: a crate at 100 over 30 eggs is 3.3333, not 3.33. */
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
const money = (n) => Math.round(Number(n) * 100) / 100;

const MIGRATION_NEEDED = 'The Odoo import needs a database update that has not been run yet: '
  + 'migration 0022_odoo_purchases.sql. Run it in the D1 console, then try again.';

/** A missing table or column here means exactly one thing: 0022 has not run. */
async function guarded(work) {
  try {
    return await work();
  } catch (err) {
    if (isMissingTable(err)) throw new HttpError(409, MIGRATION_NEEDED);
    if (err instanceof OdooError) throw new HttpError(502, err.message);
    throw err;
  }
}

async function settingsOf(db) {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'odoo_%'").all();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

async function configFor(ctx) {
  return odooConfig(await settingsOf(ctx.db), ctx.env);
}

const mapKey = (productId, uomId) => `${productId}:${uomId ?? 0}`;

async function loadMappings(db) {
  const rows = await db.prepare('SELECT * FROM odoo_product_map').all();
  return new Map((rows.results ?? []).map((r) => [mapKey(r.odoo_product_id, r.odoo_uom_id), r]));
}

async function activeIngredients(db) {
  const rows = await db.prepare('SELECT id, name, unit FROM ingredients WHERE active = 1').all();
  return new Map((rows.results ?? []).map((r) => [r.id, r]));
}

/** The Odoo lines already recorded here, and where. */
async function alreadyImported(db, lineIds) {
  const out = new Map();
  // SQLite caps bound parameters; D1 at 100. Chunk well under it.
  for (let i = 0; i < lineIds.length; i += 90) {
    const chunk = lineIds.slice(i, i + 90);
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.prepare(
      `SELECT id, day, odoo_line_id FROM purchases
       WHERE odoo_line_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all();
    for (const r of rows.results ?? []) out.set(r.odoo_line_id, { id: r.id, day: r.day });
  }
  return out;
}

/**
 * What one Odoo line becomes here.
 *
 *   imported  — already recorded; importing again leaves it alone.
 *   ignored   — somebody said this product is not breakfast.
 *   unmatched — nobody has said which ingredient it is yet. Skipped by an
 *               import until they do, then picked up by the next one.
 *   ready     — will be recorded, converted into the ingredient's unit.
 */
export function classifyLine(line, { mappings, ingredients, imported }) {
  const done = imported.get(line.lineId);
  const map = mappings.get(mapKey(line.productId, line.uomId));
  const base = { ...line, mapping: null, ingredient: null, convertedQty: null, unitCost: null };

  if (map) {
    base.mapping = {
      ingredientId: map.ingredient_id ?? null,
      factor: Number(map.factor) || 1,
      ignored: Boolean(map.ignored),
    };
  }
  if (done) return { ...base, status: 'imported', purchaseId: done.id, importedDay: done.day };
  if (map?.ignored) return { ...base, status: 'ignored' };

  const ingredient = map?.ingredient_id ? ingredients.get(map.ingredient_id) : null;
  if (!ingredient) {
    return {
      ...base,
      status: 'unmatched',
      // Matched once to something since retired is not matched now, and saying
      // so is kinder than showing a blank as though it were never asked.
      reason: map?.ingredient_id ? 'The ingredient it was matched to is no longer active.' : null,
    };
  }

  const factor = Number(map.factor) || 1;
  return {
    ...base,
    status: 'ready',
    ingredient: { id: ingredient.id, name: ingredient.name, unit: ingredient.unit },
    convertedQty: round4(line.qty * factor),
    unitCost: round4(line.unitPrice / factor),
  };
}

function summarise(lines) {
  const count = (status) => lines.filter((l) => l.status === status).length;
  const ready = lines.filter((l) => l.status === 'ready');
  return {
    ready: ready.length,
    imported: count('imported'),
    ignored: count('ignored'),
    unmatched: count('unmatched'),
    value: money(ready.reduce((sum, l) => sum + l.convertedQty * l.unitCost, 0)),
  };
}

/** Read orders and classify every line. Shared by preview and import. */
async function examine(ctx, names) {
  const config = await configFor(ctx);
  const problem = configProblem(config);
  if (problem) throw new HttpError(409, problem);

  const { orders, unknown } = await readOrders(config, names, { fetchImpl: ctx.fetchImpl ?? fetch });
  const lineIds = orders.flatMap((o) => o.lines.map((l) => l.lineId));
  const [mappings, ingredients, imported] = await Promise.all([
    loadMappings(ctx.db),
    activeIngredients(ctx.db),
    alreadyImported(ctx.db, lineIds),
  ]);

  const examined = orders.map((order) => {
    const lines = order.lines.map((l) => classifyLine(l, { mappings, ingredients, imported }));
    return { ...order, lines, summary: summarise(lines) };
  });
  return { orders: examined, unknown };
}

function namesFrom(body) {
  const names = Array.isArray(body.pos)
    ? parsePoNumbers(body.pos.join(' '))
    : parsePoNumbers(body.pos);
  if (!names.length) throw badRequest('Enter at least one PO number.');
  if (names.length > MAX_ORDERS) {
    throw badRequest(`That is ${names.length} purchase orders. Import up to ${MAX_ORDERS} at a time.`);
  }
  return names;
}

// --------------------------------------------------------------- routes --

/** Whether the import can be used here, without asking Odoo anything. */
export async function status(ctx) {
  return guarded(async () => {
    const settings = await settingsOf(ctx.db);
    const config = odooConfig(settings, ctx.env);
    const mapped = await ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM odoo_product_map',
    ).first();
    return json({
      ready: !configProblem(config),
      problem: configProblem(config),
      base: config.base || null,
      db: config.db || null,
      hasKey: Boolean(config.key),
      remembered: mapped?.n ?? 0,
      maxOrders: MAX_ORDERS,
    });
  });
}

/** Read the orders and say what importing them would do. Writes nothing. */
export async function preview(ctx) {
  const body = await readJson(ctx.request);
  const names = namesFrom(body);
  return guarded(async () => json(await examine(ctx, names)));
}

function mappingFields(m, index) {
  const label = `Product ${index + 1}`;
  const ignored = bool(m.ignored, false);
  const ingredientId = ignored
    ? null
    : int(m.ingredientId, `${label} ingredient`, { min: 1, required: true });
  return {
    productId: int(m.productId, `${label} Odoo product`, { min: 1, required: true }),
    uomId: int(m.uomId, `${label} unit`, { min: 0, fallback: 0 }),
    product: str(m.product, `${label} name`, { max: 200 }),
    uom: str(m.uom, `${label} unit name`, { max: 60 }),
    ingredientId,
    factor: num(m.factor, `${label} conversion`, { min: 0.000001, max: 1e6, fallback: 1 }),
    ignored: ignored ? 1 : 0,
  };
}

async function writeMappings(ctx, raw) {
  if (!Array.isArray(raw) || !raw.length) return 0;
  if (raw.length > 500) throw badRequest('That is too many products at once.');
  const fields = raw.map(mappingFields);

  const ingredients = await activeIngredients(ctx.db);
  fields.forEach((f, i) => {
    if (f.ingredientId && !ingredients.has(f.ingredientId)) {
      throw badRequest(`Product ${i + 1} is matched to an ingredient that is not active.`);
    }
  });

  const who = ctx.session.user.name;
  await ctx.db.batch(fields.map((f) => ctx.db.prepare(
    `INSERT INTO odoo_product_map
       (odoo_product_id, odoo_uom_id, odoo_name, odoo_uom, ingredient_id, factor, ignored, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (odoo_product_id, odoo_uom_id) DO UPDATE SET
       odoo_name = excluded.odoo_name, odoo_uom = excluded.odoo_uom,
       ingredient_id = excluded.ingredient_id, factor = excluded.factor,
       ignored = excluded.ignored, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).bind(f.productId, f.uomId, f.product, f.uom, f.ingredientId, f.factor, f.ignored, who)));
  return fields.length;
}

/** The remembered matches, for reviewing and correcting under Setup. */
export async function listMappings(ctx) {
  return guarded(async () => {
    const rows = await ctx.db.prepare(
      `SELECT m.*, i.name AS ingredient_name, i.unit AS ingredient_unit, i.active AS ingredient_active
       FROM odoo_product_map m LEFT JOIN ingredients i ON i.id = m.ingredient_id
       ORDER BY m.ignored, m.odoo_name COLLATE NOCASE`,
    ).all();
    return json({ mappings: rows.results ?? [] });
  });
}

export async function saveMappings(ctx) {
  const body = await readJson(ctx.request);
  return guarded(async () => json({ ok: true, saved: await writeMappings(ctx, body.mappings) }));
}

/** Forget a match, so the product is asked about again next time it is seen. */
export async function deleteMapping(ctx, productId, uomId) {
  return guarded(async () => {
    await ctx.db.prepare(
      'DELETE FROM odoo_product_map WHERE odoo_product_id = ? AND odoo_uom_id = ?',
    ).bind(Number(productId), Number(uomId)).run();
    return json({ ok: true });
  });
}

/**
 * Record the orders.
 *
 * Body: { pos, days: { P02433: '2026-10-14' }, mappings: [...] }
 *
 * Matches made on the preview screen come in the same request and are saved
 * first, so "match these and import" is one press rather than two.
 *
 * Safe to repeat. A line already recorded is skipped — by the check here and,
 * should two people press at once, by the unique index on odoo_line_id. So a
 * PO imported with two products still unmatched can be imported again once
 * they are matched, and only those two come across.
 */
export async function importOrders(ctx) {
  const body = await readJson(ctx.request);
  const names = namesFrom(body);
  const days = body.days && typeof body.days === 'object' ? body.days : {};

  return guarded(async () => {
    await writeMappings(ctx, body.mappings);
    const { orders, unknown } = await examine(ctx, names);

    const statements = [];
    // Which order, and how much, each insert stands for — so a line the index
    // turns away is taken off the right order's count.
    const owners = [];
    const results = [];
    let total = 0;

    for (const order of orders) {
      const result = {
        name: order.name,
        vendor: order.vendor,
        day: null,
        recorded: 0,
        value: 0,
        skipped: order.summary.imported,
        ignored: order.summary.ignored,
        unmatched: order.lines.filter((l) => l.status === 'unmatched').map((l) => l.product),
        refused: null,
      };
      results.push(result);

      if (!order.importable) {
        result.refused = `${order.name} is ${order.stateText}, so there is nothing agreed to import yet.`;
        continue;
      }
      const ready = order.lines.filter((l) => l.status === 'ready');
      if (!ready.length) continue;

      const day = String(days[order.name] ?? order.orderedOn ?? '').trim();
      if (!isDay(day)) {
        result.refused = `${order.name} has no date to record it on. Choose one and try again.`;
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await assertDayWritable(ctx.db, day);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        result.refused = err.message;
        continue;
      }

      result.day = day;
      for (const line of ready) {
        statements.push(ctx.db.prepare(
          `INSERT OR IGNORE INTO purchases
             (day, ingredient_id, qty, unit_cost, supplier, note, po_ref, odoo_line_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          day, line.ingredient.id, line.convertedQty, line.unitCost,
          // The vendor exactly as Odoo has it. The supplier list governs what a
          // person may type; this was not typed, and refusing an agreed order
          // because a supplier was spelt differently here would help nobody.
          order.vendor || null,
          line.product === line.ingredient.name ? null : `Odoo: ${line.product}${line.uom ? ` (${line.uom})` : ''}`,
          order.name,
          line.lineId,
        ));
        const value = line.convertedQty * line.unitCost;
        owners.push({ result, value });
        result.recorded += 1;
        result.value = money(result.value + value);
      }
      total = money(total + result.value);
    }

    if (statements.length) {
      const recorded = results.filter((r) => r.recorded);
      statements.push(
        ctx.db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
          .bind(
            `${ctx.session.user.name} (${ctx.session.user.role})`,
            'odoo.import',
            recorded.map((r) => r.name).join(', '),
            JSON.stringify({
              orders: recorded.map((r) => ({ po: r.name, day: r.day, lines: r.recorded, value: r.value })),
              total,
            }),
          ),
      );
      const outcome = await ctx.db.batch(statements);
      // A line somebody else recorded in the moment between reading and
      // writing is turned away by the index. Count it as skipped, not as new.
      owners.forEach(({ result, value }, i) => {
        if (outcome?.[i]?.meta?.changes !== 0) return;
        result.recorded -= 1;
        result.skipped += 1;
        result.value = money(result.value - value);
      });
      total = money(results.reduce((sum, r) => sum + r.value, 0));
    }

    return json({
      ok: true,
      orders: results,
      unknown,
      recorded: results.reduce((n, r) => n + r.recorded, 0),
      total,
    });
  });
}
