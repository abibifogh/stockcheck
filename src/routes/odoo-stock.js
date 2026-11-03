import {
  HttpError, badRequest, bool, int, isMissingTable, json, num, readJson, str,
} from '../lib/http.js';
import { verifyLink } from '../lib/link.js';
import { assertDayWritable } from '../lib/locks.js';
import { notify } from '../lib/notify.js';
import { pushToPeople } from '../lib/push.js';
import { deliveryLocation } from '../lib/store.js';
import { isDay, todayIn } from '../util/dates.js';
import {
  activeIngredients, classifyLine, loadMappings, recordOdooLine, round4, writeMappings,
} from './odoo.js';

/**
 * Stock from Odoo, sent by Insight.
 *
 * Insight reads every confirmed Odoo purchase order and offers each line here
 * first (then to Maintenance). This app decides, from its own Odoo product map
 * — the same one the hand import by PO number reads — whether a line is
 * breakfast stock, and in which unit and at what cost. Insight never counts or
 * prices anything itself.
 *
 *   offer   — { mode, lines }: record now (confirmed, odoo) or put on its way
 *             (store), where it waits under Purchases for somebody to tap
 *             Received.
 *   status  — { lineIds }: what became of each line.
 *   cancel  — { lineIds }: the PO was cancelled in Odoo.
 *   items   — the active ingredients, for Insight's "which item?" picker.
 *   map     — answer "which item is this Odoo product?" once, for good.
 *
 * Signed like the report (lib/link.js), with the same secret, at its own path.
 * docs/stock-from-odoo.md says the breakfast side of the agreement with Insight.
 */

const PATH = '/api/link/stock';
const MAX_LINES = 200;
const INSIGHT = 'Insight';

const MIGRATION_NEEDED = 'Stock from Odoo needs a database update that has not been run yet: '
  + 'migration 0025_odoo_expected.sql (Actions → Breakfast database).';

const money = (n) => Math.round(Number(n) * 100) / 100;

async function timezoneOf(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'timezone'").first();
  return row?.value || 'UTC';
}

/** The calendar day, where the hotel is, of a stored UTC datetime. */
function localDay(stamp, timezone) {
  if (!stamp) return null;
  const at = new Date(`${String(stamp).replace(' ', 'T')}Z`);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** SQLite's datetime('now') is UTC without saying so. Say so. */
const iso = (t) => (t ? `${String(t).replace(' ', 'T')}Z` : null);

/** Tell people after answering; a failure to tell never fails the work. */
async function later(ctx, task) {
  const safe = task.catch(() => {});
  if (ctx.executionContext?.waitUntil) ctx.executionContext.waitUntil(safe);
  else await safe;
}

const audit = (db, action, entity, detail) => db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)',
).bind(INSIGHT, action, entity, JSON.stringify(detail));

// --------------------------------------------------------------- reading --

/** One line as Insight sends it, checked, in the shape classifyLine reads. */
function lineFrom(raw, index) {
  const label = `Line ${index + 1}`;
  if (!raw || typeof raw !== 'object') throw badRequest(`${label} is not a line.`);
  const confirmedOn = raw.confirmedOn == null ? null : String(raw.confirmedOn).slice(0, 10);
  return {
    lineId: int(raw.lineId, `${label} lineId`, { min: 1, required: true }),
    po: str(raw.po, `${label} po`, { max: 60, required: true }),
    poId: raw.poId == null ? null : int(raw.poId, `${label} poId`, { min: 0 }),
    supplier: str(raw.supplier, `${label} supplier`, { max: 120 }),
    confirmedOn: isDay(confirmedOn) ? confirmedOn : null,
    productId: int(raw.productId, `${label} productId`, { min: 1, required: true }),
    uomId: int(raw.uomId, `${label} uomId`, { min: 0, fallback: 0 }),
    product: str(raw.product, `${label} product`, { max: 200 }) || '',
    uom: str(raw.uom, `${label} uom`, { max: 60 }) || '',
    qty: num(raw.qty, `${label} qty`, { min: 0.000001, max: 1e7, required: true }),
    // classifyLine's name for it, as the hand import reads it out of Odoo.
    unitPrice: num(raw.priceUnit, `${label} priceUnit`, { min: 0, max: 1e9, fallback: 0 }),
  };
}

function lineIdsFrom(body) {
  const raw = Array.isArray(body.lineIds) ? body.lineIds : null;
  if (!raw) throw badRequest('lineIds: a list of Odoo line ids.');
  if (raw.length > MAX_LINES) throw badRequest(`At most ${MAX_LINES} lines at a time.`);
  return [...new Set(raw.map((id, i) => int(id, `lineIds[${i}]`, { min: 1, required: true })))];
}

const itemOf = (id, name, unit) => (id ? { id, name, unit } : null);

/**
 * What became of each line here: on its way, received, cancelled (all in
 * odoo_expected), put straight in as stock (a purchase row only), or never
 * heard of.
 */
async function statesOf(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    // eslint-disable-next-line no-await-in-loop
    const [bought, coming] = await Promise.all([
      db.prepare(
        `SELECT p.id, p.day, p.qty, p.unit_cost, p.supplier, p.po_ref, p.odoo_line_id,
                p.ingredient_id, i.name AS item_name, i.unit AS item_unit
         FROM purchases p JOIN ingredients i ON i.id = p.ingredient_id
         WHERE p.odoo_line_id IN (${marks})`,
      ).bind(...chunk).all(),
      db.prepare(
        `SELECT e.*, i.name AS item_name, i.unit AS item_unit
         FROM odoo_expected e JOIN ingredients i ON i.id = e.ingredient_id
         WHERE e.odoo_line_id IN (${marks})`,
      ).bind(...chunk).all(),
    ]);
    const purchases = new Map((bought.results ?? []).map((p) => [p.odoo_line_id, p]));
    for (const e of coming.results ?? []) {
      const purchase = purchases.get(e.odoo_line_id) ?? null;
      out.set(e.odoo_line_id, {
        state: e.state,
        item: itemOf(e.ingredient_id, e.item_name, e.item_unit),
        qty: e.qty,
        unitCost: e.unit_cost,
        received: e.state === 'received' ? e.received_qty : null,
        receivedBy: e.received_by ?? null,
        receivedAt: iso(e.received_at),
        purchase,
        expected: e,
      });
    }
    for (const p of purchases.values()) {
      if (out.has(p.odoo_line_id)) continue;
      out.set(p.odoo_line_id, {
        state: 'recorded',
        item: itemOf(p.ingredient_id, p.item_name, p.item_unit),
        qty: p.qty,
        unitCost: p.unit_cost,
        received: null,
        receivedBy: null,
        receivedAt: null,
        purchase: p,
        expected: null,
      });
    }
  }
  return out;
}

/** Whether a day may be written, and if not, the sentence that says why. */
async function lockedBecause(db, day) {
  try {
    await assertDayWritable(db, day);
    return null;
  } catch (err) {
    if (err instanceof HttpError) return err.message;
    throw err;
  }
}

// ---------------------------------------------------------------- offer --

async function offer(ctx, body) {
  const { db } = ctx;
  const mode = body.mode === 'odoo' ? 'confirmed' : body.mode;
  if (mode !== 'confirmed' && mode !== 'store') throw badRequest('mode is one of confirmed, store or odoo.');
  if (!Array.isArray(body.lines)) throw badRequest('lines: a list of Odoo lines.');
  if (body.lines.length > MAX_LINES) throw badRequest(`At most ${MAX_LINES} lines at a time.`);
  const lines = body.lines.map(lineFrom);

  const ids = [...new Set(lines.map((l) => l.lineId))];
  const [mappings, ingredients, states, location, timezone] = await Promise.all([
    loadMappings(db), activeIngredients(db), statesOf(db, ids), deliveryLocation(db), timezoneOf(db),
  ]);
  const today = todayIn(timezone);
  const dayFor = new Map();
  const whyNot = new Map();
  async function recordingDay(confirmedOn) {
    // The day it was confirmed in Odoo; today when that is closed (or unknown).
    const wanted = confirmedOn || today;
    if (!dayFor.has(wanted)) {
      const closed = await lockedBecause(db, wanted);
      if (!closed) dayFor.set(wanted, wanted);
      else if (wanted !== today && !(await lockedBecause(db, today))) dayFor.set(wanted, today);
      else { dayFor.set(wanted, null); whyNot.set(wanted, wanted === today ? closed : `${closed} Today is closed too.`); }
    }
    return { day: dayFor.get(wanted), why: whyNot.get(wanted) };
  }

  const answers = {};
  const statements = [];
  const written = []; // [lineId, answer] per insert, in statement order
  const seen = new Set();

  for (const line of lines) {
    const key = String(line.lineId);
    // The same line twice in one request: the first answer stands.
    if (seen.has(line.lineId)) continue;
    seen.add(line.lineId);
    const now = states.get(line.lineId);
    if (now) {
      answers[key] = {
        state: 'already', current: now.state, item: now.item, qty: now.qty, unitCost: now.unitCost, reason: null,
      };
      continue;
    }

    // The hand import's own rules: the map, its factor, four places on the cost.
    const c = classifyLine(line, { mappings, ingredients, imported: new Map() });
    if (c.status === 'ignored') {
      answers[key] = { state: 'ignored', item: null, qty: null, unitCost: null, reason: 'Marked as not breakfast in the Odoo product map.' };
      continue;
    }
    if (c.status !== 'ready') {
      answers[key] = { state: 'unknown', item: null, qty: null, unitCost: null, reason: c.reason ?? 'Nobody has said which breakfast item this Odoo product is.' };
      continue;
    }
    const answer = { item: c.ingredient, qty: c.convertedQty, unitCost: c.unitCost, reason: null };

    if (mode === 'store') {
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO odoo_expected
           (odoo_line_id, po, po_id, supplier, ingredient_id, qty, unit_cost,
            odoo_product, odoo_qty, odoo_uom, confirmed_on, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'expected')`,
      ).bind(
        line.lineId, line.po, line.poId, line.supplier, c.ingredient.id, c.convertedQty, c.unitCost,
        line.product, line.qty, line.uom, line.confirmedOn,
      ));
      answers[key] = { state: 'expected', ...answer };
      written.push([line, answers[key]]);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const { day, why } = await recordingDay(line.confirmedOn);
    if (!day) {
      answers[key] = { state: 'refused', item: c.ingredient, qty: c.convertedQty, unitCost: c.unitCost, reason: why };
      continue;
    }
    statements.push(recordOdooLine(db, {
      day,
      ingredient: c.ingredient,
      qty: c.convertedQty,
      unitCost: c.unitCost,
      supplier: line.supplier,
      product: line.product,
      uom: line.uom,
      po: line.po,
      lineId: line.lineId,
      location,
    }));
    answers[key] = { state: 'recorded', day, ...answer };
    written.push([line, answers[key]]);
  }

  if (statements.length) {
    statements.push(audit(db, mode === 'store' ? 'odoo.expected' : 'odoo.stock', [...new Set(written.map(([l]) => l.po))].join(', '), {
      mode,
      lines: written.map(([l, a]) => ({ po: l.po, line: l.lineId, item: a.item.name, qty: a.qty, unitCost: a.unitCost, day: a.day ?? null })),
    }));
    const outcome = await db.batch(statements);
    // A line written by somebody else in the moment between reading and
    // writing is turned away by the key; say "already", not "recorded".
    written.forEach(([, a], i) => {
      if (outcome?.[i]?.meta?.changes === 0) Object.assign(a, { state: 'already', current: a.state === 'expected' ? 'expected' : 'recorded' });
    });
  }

  const arriving = written.filter(([, a]) => a.state === 'expected');
  if (arriving.length) await later(ctx, tellStorekeepers(db, arriving));

  return json({ ok: true, lines: answers });
}

/** The people who can receive (Purchases) hear that something is on its way. */
function tellStorekeepers(db, arriving) {
  const byPo = new Map();
  for (const [line, a] of arriving) {
    if (!byPo.has(line.po)) byPo.set(line.po, { supplier: line.supplier, items: [] });
    byPo.get(line.po).items.push(`${a.item.name} ${Number(a.qty)} ${a.item.unit}`);
  }
  const [[po, first]] = byPo;
  const title = byPo.size === 1
    ? `On its way from Odoo: ${po}${first.supplier ? ` · ${first.supplier}` : ''}`
    : `${arriving.length} lines on their way from Odoo (${[...byPo.keys()].join(', ')})`;
  const all = [...byPo.values()].flatMap((p) => p.items);
  const body = `${all.slice(0, 4).join(', ')}${all.length > 4 ? ` and ${all.length - 4} more` : ''}. Tap Received in Purchases when it arrives.`;
  return Promise.all([
    notify(db, { kind: 'odoo_expected', audience: 'purchases', title, body, link: '#/purchases', actor: INSIGHT }),
    pushToPeople(db, { permission: 'purchases', title, body, url: '#/purchases', tag: 'odoo-expected' }),
  ]);
}

// --------------------------------------------------------------- status --

async function status(ctx, body) {
  const ids = lineIdsFrom(body);
  const states = await statesOf(ctx.db, ids);
  const lines = {};
  for (const id of ids) {
    const s = states.get(id);
    lines[String(id)] = s
      ? { state: s.state, item: s.item, qty: s.qty, received: s.received, receivedBy: s.receivedBy, receivedAt: s.receivedAt }
      : { state: 'missing', item: null, qty: null, received: null, receivedBy: null, receivedAt: null };
  }
  return json({ ok: true, lines });
}

// --------------------------------------------------------------- cancel --

async function cancel(ctx, body) {
  const { db } = ctx;
  const ids = lineIdsFrom(body);
  const states = await statesOf(db, ids);
  const lines = {};
  const statements = [];
  const done = [];

  for (const id of ids) {
    const key = String(id);
    const s = states.get(id);
    if (!s) { lines[key] = { state: 'missing', reason: 'This line was never offered here.' }; continue; }
    if (s.state === 'cancelled' || s.state === 'expected') {
      if (s.state === 'expected') {
        statements.push(db.prepare(
          "UPDATE odoo_expected SET state = 'cancelled', cancelled_at = datetime('now') WHERE odoo_line_id = ? AND state = 'expected'",
        ).bind(id));
        done.push({ line: id, was: 'expected' });
      }
      lines[key] = { state: 'removed', reason: null };
      continue;
    }

    // Received, or recorded straight away: stock is on the books. It comes off
    // unless its day is closed — a closed month's numbers do not move.
    if (s.purchase) {
      // eslint-disable-next-line no-await-in-loop
      const closed = await lockedBecause(db, s.purchase.day);
      if (closed) {
        lines[key] = { state: 'kept', reason: `Already in stock on ${s.purchase.day}, which is closed: ${closed}` };
        continue;
      }
      statements.push(db.prepare('DELETE FROM purchases WHERE id = ?').bind(s.purchase.id));
    }
    if (s.expected) {
      statements.push(db.prepare(
        "UPDATE odoo_expected SET state = 'cancelled', cancelled_at = datetime('now'), purchase_id = NULL WHERE odoo_line_id = ?",
      ).bind(id));
    } else {
      // Recorded straight away: keep a cancelled row, so status says so later.
      const p = s.purchase;
      statements.push(db.prepare(
        `INSERT OR REPLACE INTO odoo_expected
           (odoo_line_id, po, supplier, ingredient_id, qty, unit_cost, state, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, 'cancelled', datetime('now'))`,
      ).bind(id, p.po_ref || '', p.supplier, p.ingredient_id, p.qty, p.unit_cost));
    }
    done.push({ line: id, was: s.state, day: s.purchase?.day ?? null, qty: s.purchase?.qty ?? null });
    lines[key] = { state: 'removed', reason: null };
  }

  if (statements.length) {
    statements.push(audit(db, 'odoo.cancel', ids.join(', ').slice(0, 300), { lines: done }));
    await db.batch(statements);
  }
  return json({ ok: true, lines });
}

// ---------------------------------------------------------- items & map --

async function items(ctx) {
  const rows = await ctx.db.prepare(
    `SELECT i.id, i.name, i.unit, i.kind, c.name AS category
     FROM ingredients i JOIN categories c ON c.id = i.category_id
     WHERE i.active = 1 AND COALESCE(i.is_produced, 0) = 0
     ORDER BY c.sort_order, c.name, i.sort_order, i.name`,
  ).all();
  return json({
    ok: true,
    items: (rows.results ?? []).map((r) => ({ id: r.id, name: r.name, unit: r.unit, group: r.category, kind: r.kind })),
  });
}

const NEW_ITEMS_CATEGORY = 'From Odoo';

/**
 * A new ingredient from a name and a unit. Into the category Insight names if
 * there is one by that name, else "From Odoo", for somebody to move under
 * Setup. Not an everyday item, so it does not land on the kitchen's quick
 * sheet. An active ingredient of the same name is used rather than doubled.
 */
async function makeItem(db, raw) {
  if (!raw || typeof raw !== 'object') throw badRequest('newItem needs a name and a unit.');
  const name = str(raw.name, 'newItem.name', { max: 100, required: true });
  const unit = str(raw.unit, 'newItem.unit', { max: 20, required: true });
  const kind = raw.kind === 'supply' ? 'supply' : 'food';

  const same = await db.prepare('SELECT id, name, unit FROM ingredients WHERE active = 1 AND name = ? COLLATE NOCASE ORDER BY id LIMIT 1')
    .bind(name).first();
  if (same) return same;

  const group = str(raw.group, 'newItem.group', { max: 100 });
  let category = group
    ? await db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').bind(group).first()
    : null;
  if (!category) {
    await db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, 999)').bind(NEW_ITEMS_CATEGORY).run();
    category = await db.prepare('SELECT id FROM categories WHERE name = ?').bind(NEW_ITEMS_CATEGORY).first();
  }
  // Retired with that name in that category: bring it back rather than collide.
  const retired = await db.prepare('SELECT id FROM ingredients WHERE category_id = ? AND name = ? COLLATE NOCASE')
    .bind(category.id, name).first();
  if (retired) {
    return db.prepare('UPDATE ingredients SET active = 1 WHERE id = ? RETURNING id, name, unit').bind(retired.id).first();
  }
  return db.prepare(
    'INSERT INTO ingredients (category_id, name, unit, is_core, kind) VALUES (?, ?, ?, 0, ?) RETURNING id, name, unit',
  ).bind(category.id, name, unit, kind).first();
}

async function map(ctx, body) {
  const { db } = ctx;
  const ignore = bool(body.ignore, false);
  const productId = int(body.productId, 'productId', { min: 1, required: true });
  let item = null;
  if (!ignore) {
    if (body.itemId != null && body.itemId !== '') {
      const id = int(body.itemId, 'itemId', { min: 1 });
      item = (await activeIngredients(db)).get(id) ?? null;
      if (!item) throw badRequest(`There is no active breakfast item ${id}.`);
    } else if (body.newItem) {
      item = await makeItem(db, body.newItem);
    } else {
      throw badRequest('Say which item: itemId, or newItem { name, unit }, or ignore: true.');
    }
  }
  // The very table and writer the hand import uses, so the two always agree.
  await writeMappings(db, [{
    productId,
    uomId: body.uomId,
    product: body.product,
    uom: body.uom,
    ingredientId: item?.id ?? null,
    factor: body.factor,
    ignored: ignore,
  }], INSIGHT);
  return json({ ok: true, item: item ? { id: item.id, name: item.name, unit: item.unit } : null });
}

// ---------------------------------------------------------------- route --

const ACTIONS = { offer, status, cancel, items, map };

/** POST /api/link/stock — signed by Insight. Errors come back as { ok:false, error }. */
export async function linkStock(ctx) {
  try {
    const bodyText = await ctx.request.text();
    const signed = await verifyLink(ctx.env.INSIGHT_SSO_SECRET || '', {
      at: ctx.request.headers.get('X-Till-At'), sig: ctx.request.headers.get('X-Till-Sig'), path: PATH, bodyText,
    });
    if (!signed) throw new HttpError(401, 'Only Insight may send this, and it signs what it sends.');
    let body;
    try { body = JSON.parse(bodyText || '{}'); } catch { throw badRequest('Not JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Expected a JSON object.');
    const action = ACTIONS[body.action];
    if (!action || !Object.hasOwn(ACTIONS, body.action)) throw badRequest('action is one of offer, status, cancel, items, map.');
    return await action(ctx, body);
  } catch (err) {
    if (err instanceof HttpError) return json({ ok: false, error: err.message }, { status: err.status });
    if (isMissingTable(err)) return json({ ok: false, error: MIGRATION_NEEDED }, { status: 409 });
    throw err;
  }
}

// ------------------------------------------------------------ in the app --

/**
 * What is on its way, by PO, and what came in from Odoo today.
 * For whoever records deliveries (Purchases).
 */
export async function incoming(ctx) {
  const { db } = ctx;
  try {
    const timezone = await timezoneOf(db);
    const today = todayIn(timezone);
    const [waiting, received, recorded] = await Promise.all([
      db.prepare(
        `SELECT e.*, i.name AS item_name, i.unit AS item_unit
         FROM odoo_expected e JOIN ingredients i ON i.id = e.ingredient_id
         WHERE e.state = 'expected'
         ORDER BY e.confirmed_on, e.po, e.odoo_line_id`,
      ).all(),
      db.prepare(
        `SELECT e.*, i.name AS item_name, i.unit AS item_unit
         FROM odoo_expected e JOIN ingredients i ON i.id = e.ingredient_id
         WHERE e.state = 'received' AND e.received_at >= datetime('now', '-2 days')`,
      ).all(),
      db.prepare(
        `SELECT p.id, p.qty, p.unit_cost, p.po_ref, p.supplier, p.odoo_line_id, p.created_at,
                p.ingredient_id, i.name AS item_name, i.unit AS item_unit
         FROM purchases p JOIN ingredients i ON i.id = p.ingredient_id
         WHERE p.odoo_line_id IS NOT NULL AND p.created_at >= datetime('now', '-2 days')
           AND p.odoo_line_id NOT IN (SELECT odoo_line_id FROM odoo_expected)`,
      ).all(),
    ]);

    const orders = new Map();
    for (const e of waiting.results ?? []) {
      if (!orders.has(e.po)) orders.set(e.po, { po: e.po, supplier: e.supplier, confirmedOn: e.confirmed_on, lines: [] });
      orders.get(e.po).lines.push({
        lineId: e.odoo_line_id,
        item: itemOf(e.ingredient_id, e.item_name, e.item_unit),
        qty: e.qty,
        unitCost: e.unit_cost,
        product: e.odoo_product,
        odooQty: e.odoo_qty,
        odooUom: e.odoo_uom,
      });
    }

    const todays = [
      ...(received.results ?? []).filter((e) => localDay(e.received_at, timezone) === today).map((e) => ({
        lineId: e.odoo_line_id,
        po: e.po,
        supplier: e.supplier,
        item: itemOf(e.ingredient_id, e.item_name, e.item_unit),
        qty: e.received_qty,
        expected: e.qty,
        short: round4(Math.max(0, e.qty - (e.received_qty ?? 0))),
        by: e.received_by,
        at: iso(e.received_at),
      })),
      ...(recorded.results ?? []).filter((p) => localDay(p.created_at, timezone) === today).map((p) => ({
        lineId: p.odoo_line_id,
        po: p.po_ref,
        supplier: p.supplier,
        item: itemOf(p.ingredient_id, p.item_name, p.item_unit),
        qty: p.qty,
        expected: p.qty,
        short: 0,
        by: null,
        at: iso(p.created_at),
      })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

    return json({ orders: [...orders.values()], today: todays });
  } catch (err) {
    // Before migration 0025 nothing can be on its way; the screen just hides the list.
    if (isMissingTable(err)) return json({ orders: [], today: [], unavailable: true });
    throw err;
  }
}

/**
 * Received: one PO, every line on its way, each at the quantity somebody
 * says came (short, or 0 for nothing). Recorded today, into wherever
 * deliveries go, at the PO's unit cost.
 *
 * Body: { po, lines: [{ lineId, qty }] }. A line of the PO left out of
 * `lines` is taken as having come in full.
 */
export async function receive(ctx) {
  const { db } = ctx;
  const body = await readJson(ctx.request);
  const po = str(body.po, 'PO', { max: 60, required: true });
  const given = new Map();
  for (const [i, l] of (Array.isArray(body.lines) ? body.lines : []).entries()) {
    given.set(int(l?.lineId, `Line ${i + 1}`, { min: 1, required: true }),
      num(l?.qty, `Line ${i + 1} quantity`, { min: 0, max: 1e7, required: true }));
  }

  try {
    const rows = (await db.prepare(
      `SELECT e.*, i.id AS item_id, i.name AS item_name, i.unit AS item_unit
       FROM odoo_expected e JOIN ingredients i ON i.id = e.ingredient_id
       WHERE e.po = ? AND e.state = 'expected'`,
    ).bind(po).all()).results ?? [];
    if (!rows.length) throw new HttpError(409, `Nothing from ${po} is waiting to be received. Somebody may have just done it.`);
    for (const id of given.keys()) {
      if (!rows.some((r) => r.odoo_line_id === id)) throw badRequest(`Line ${id} is not on its way on ${po}.`);
    }

    const today = todayIn(await timezoneOf(db));
    await assertDayWritable(db, today);
    const location = await deliveryLocation(db);
    const who = ctx.session.user.name;

    const statements = [];
    let total = 0;
    const short = [];
    for (const r of rows) {
      const qty = round4(given.has(r.odoo_line_id) ? given.get(r.odoo_line_id) : r.qty);
      if (qty > 0) {
        statements.push(recordOdooLine(db, {
          day: today,
          ingredient: { id: r.item_id, name: r.item_name },
          qty,
          unitCost: r.unit_cost,
          supplier: r.supplier,
          product: r.odoo_product,
          uom: r.odoo_uom,
          po: r.po,
          lineId: r.odoo_line_id,
          location,
        }));
        total += qty * r.unit_cost;
      }
      if (qty < r.qty) short.push({ item: r.item_name, unit: r.item_unit, short: round4(r.qty - qty) });
      statements.push(db.prepare(
        `UPDATE odoo_expected SET state = 'received', received_qty = ?, received_by = ?, received_at = datetime('now'),
           purchase_id = (SELECT id FROM purchases WHERE odoo_line_id = ?)
         WHERE odoo_line_id = ? AND state = 'expected'`,
      ).bind(qty, who, r.odoo_line_id, r.odoo_line_id));
    }
    statements.push(db.prepare('INSERT INTO audit_log (actor, action, entity, detail) VALUES (?, ?, ?, ?)')
      .bind(`${who} (${ctx.session.user.role})`, 'odoo.receive', po, JSON.stringify({ day: today, lines: rows.length, short, total: money(total) })));
    await db.batch(statements);

    return json({ ok: true, po, day: today, lines: rows.length, short, total: money(total) });
  } catch (err) {
    if (isMissingTable(err)) throw new HttpError(409, MIGRATION_NEEDED);
    throw err;
  }
}
