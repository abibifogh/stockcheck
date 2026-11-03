import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { signLink } from '../src/lib/link.js';
import { incoming, linkStock, receive } from '../src/routes/odoo-stock.js';
import { alreadyImported, classifyLine } from '../src/routes/odoo.js';
import { addDays, todayIn } from '../src/util/dates.js';

/**
 * Stock from Odoo, as Insight sends it: offered line by line, recorded now or
 * put on its way, received here (perhaps short), asked about, cancelled.
 *
 * The rules that matter are the ones that would be wrong quietly: a line
 * recorded twice, a crate recorded as one egg, a closed month moved, a
 * cancelled order left on the shelf, somebody other than Insight sending.
 * Made-up suppliers and people throughout.
 */

const SECRET = 'shared-with-insight';
const PATH = '/api/link/stock';
const TZ = 'Africa/Accra';
const TODAY = todayIn(TZ);
const YESTERDAY = addDays(TODAY, -1);

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  sqlite.exec(`
    UPDATE settings SET value = '${TZ}' WHERE key = 'timezone';
    INSERT INTO categories (id, name) VALUES (90, 'Test larder');
    INSERT INTO ingredients (id, category_id, name, unit) VALUES
      (900, 90, 'Eggs', 'each'), (901, 90, 'Bread', 'loaves'), (902, 90, 'Old jam', 'jar');
    UPDATE ingredients SET active = 0 WHERE id = 902;
    INSERT INTO odoo_product_map (odoo_product_id, odoo_uom_id, odoo_name, ingredient_id, factor, ignored) VALUES
      (77, 12, 'Eggs, crate of 30', 900, 30, 0),
      (78, 1, 'Bread, sliced loaf', 901, 1, 0),
      (79, 1, 'Delivery charge', NULL, 1, 1),
      (81, 1, 'Jam, jar', 902, 1, 0);
  `);

  const statement = (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
    st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
    st.run = async () => {
      const r = sqlite.prepare(sql).run(...st.binds);
      return { success: true, meta: { changes: Number(r.changes) } };
    };
    return st;
  };
  const db = {
    prepare: statement,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run()); // eslint-disable-line no-await-in-loop
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { sqlite, db };
}

async function send(db, body, { secret = SECRET, tamper = false } = {}) {
  const text = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', ...(await signLink(secret, PATH, text)) };
  const request = new Request(`https://breakfast.example.test${PATH}`, {
    method: 'POST', headers, body: tamper ? text.replace('6', '60') : text,
  });
  const res = await linkStock({ request, env: { INSIGHT_SSO_SECRET: SECRET }, db });
  return { status: res.status, body: await res.json() };
}

const session = { user: { id: 1, name: 'Ama Test', role: 'manager' } };

async function receiveCall(db, body) {
  const request = new Request('https://breakfast.example.test/api/odoo/incoming/receive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await receive({ request, env: {}, db, session });
  return res.json();
}

const line = (over = {}) => ({
  lineId: 9123, po: 'P04131', poId: 412, supplier: 'A Farm Supplies', confirmedOn: YESTERDAY,
  productId: 77, uomId: 12, product: 'Eggs, crate of 30', uom: 'Units', qty: 6, priceUnit: 95, ...over,
});
const BREAD = line({ lineId: 9124, productId: 78, uomId: 1, product: 'Bread, sliced loaf', qty: 30, priceUnit: 8 });
const CHARGE = line({ lineId: 9125, productId: 79, uomId: 1, product: 'Delivery charge', qty: 1, priceUnit: 20 });
const SEALANT = line({ lineId: 9126, productId: 80, uomId: 1, product: 'Silicone sealant', qty: 6, priceUnit: 38 });
const JAM = line({ lineId: 9127, productId: 81, uomId: 1, product: 'Jam, jar', qty: 2, priceUnit: 15 });

const purchases = (sqlite) => sqlite.prepare('SELECT * FROM purchases ORDER BY odoo_line_id').all();

// ------------------------------------------------------------- signature --

test('only Insight may send stock, and only what it signed', async () => {
  const { db, sqlite } = database();
  const wrong = await send(db, { action: 'offer', mode: 'confirmed', lines: [line()] }, { secret: 'not-the-secret' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.ok, false);
  assert.match(wrong.body.error, /Only Insight/);

  const changed = await send(db, { action: 'offer', mode: 'confirmed', lines: [line()] }, { tamper: true });
  assert.equal(changed.status, 401);
  assert.equal(purchases(sqlite).length, 0, 'nothing written');
});

test('bad input is a 400 with a plain message', async () => {
  const { db } = database();
  for (const body of [
    { action: 'sell' },
    { action: 'offer', mode: 'later', lines: [] },
    { action: 'offer', mode: 'store', lines: [line({ productId: null })] },
    { action: 'offer', mode: 'store', lines: Array.from({ length: 201 }, (_, i) => line({ lineId: i + 1 })) },
    { action: 'status' },
  ]) {
    const out = await send(db, body); // eslint-disable-line no-await-in-loop
    assert.equal(out.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(out.body.ok, false);
    assert.ok(out.body.error);
  }
});

// ----------------------------------------------------------------- offer --

test('confirmed: recorded now, crates turned into eggs, on the day Odoo confirmed it', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'offer', mode: 'confirmed', lines: [line(), BREAD] });
  assert.equal(out.status, 200);
  const eggs = out.body.lines['9123'];
  assert.equal(eggs.state, 'recorded');
  assert.deepEqual(eggs.item, { id: 900, name: 'Eggs', unit: 'each' });
  assert.equal(eggs.qty, 180, 'six crates of thirty');
  assert.equal(eggs.unitCost, 3.1667, '95 a crate over 30, four places — the hand import’s rule');

  const rows = purchases(sqlite);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].day, YESTERDAY);
  assert.equal(rows[0].po_ref, 'P04131');
  assert.equal(rows[0].supplier, 'A Farm Supplies');
  assert.equal(rows[0].location, 'store', 'where deliveries go');
  assert.equal(rows[0].note, 'Odoo: Eggs, crate of 30 (Units)');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'odoo.stock'").get().n, 1);
});

test('odoo mode is the same as confirmed', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'offer', mode: 'odoo', lines: [BREAD] });
  assert.equal(out.body.lines['9124'].state, 'recorded');
  assert.equal(purchases(sqlite)[0].qty, 30);
});

test('store: on its way, not stock, and the people who receive are told', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'offer', mode: 'store', lines: [line(), BREAD] });
  assert.equal(out.body.lines['9123'].state, 'expected');
  assert.equal(out.body.lines['9123'].qty, 180);
  assert.equal(purchases(sqlite).length, 0, 'not stock until somebody says it came');

  const waiting = sqlite.prepare("SELECT * FROM odoo_expected WHERE state = 'expected' ORDER BY odoo_line_id").all();
  assert.deepEqual(waiting.map((r) => [r.odoo_line_id, r.qty, r.unit_cost, r.odoo_qty, r.odoo_uom, r.po]),
    [[9123, 180, 3.1667, 6, 'Units', 'P04131'], [9124, 30, 8, 30, 'Units', 'P04131']]);

  const notice = sqlite.prepare("SELECT * FROM app_notices WHERE kind = 'odoo_expected'").all();
  assert.equal(notice.length, 1, 'one notice for the offer, not one per line');
  assert.equal(notice[0].audience, 'purchases', 'whoever records deliveries');
  assert.match(notice[0].title, /P04131 · A Farm Supplies/);
  assert.match(notice[0].body, /Eggs 180 each/);
});

test('a line already here is never added twice, whichever way it came', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line()] });
  // Brought in by hand, by PO number, before Insight got to it.
  sqlite.exec(`INSERT INTO purchases (day, ingredient_id, qty, unit_cost, po_ref, odoo_line_id)
               VALUES ('${YESTERDAY}', 901, 30, 8, 'P04131', 9124)`);

  const again = await send(db, { action: 'offer', mode: 'confirmed', lines: [line(), BREAD, BREAD] });
  assert.equal(again.body.lines['9123'].state, 'already');
  assert.equal(again.body.lines['9123'].current, 'expected');
  assert.equal(again.body.lines['9124'].state, 'already');
  assert.equal(again.body.lines['9124'].current, 'recorded');
  assert.equal(purchases(sqlite).length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'odoo_expected'").get().n, 1, 'nothing new, nobody told');
});

test('unknown and ignored products are left for Insight to ask about, or alone', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'offer', mode: 'confirmed', lines: [CHARGE, SEALANT, JAM] });
  assert.equal(out.body.lines['9125'].state, 'ignored');
  assert.equal(out.body.lines['9126'].state, 'unknown');
  assert.equal(out.body.lines['9127'].state, 'unknown', 'matched to an item since retired');
  assert.match(out.body.lines['9127'].reason, /no longer active/);
  assert.equal(purchases(sqlite).length, 0);
});

test('a confirmation day in a closed period is recorded today instead', async () => {
  const { db, sqlite } = database();
  sqlite.exec(`INSERT INTO period_locks (from_day, to_day, reason) VALUES ('${YESTERDAY}', '${YESTERDAY}', 'Closed for the test')`);
  const out = await send(db, { action: 'offer', mode: 'confirmed', lines: [line()] });
  assert.equal(out.body.lines['9123'].state, 'recorded');
  assert.equal(out.body.lines['9123'].day, TODAY);
  assert.equal(purchases(sqlite)[0].day, TODAY);
});

// ------------------------------------------------------------- receiving --

test('Received with a short quantity: stock is what came, and the gap is said', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line(), BREAD, JAM] });

  const result = await receiveCall(db, { po: 'P04131', lines: [{ lineId: 9123, qty: 150 }] });
  assert.equal(result.ok, true);
  assert.equal(result.day, TODAY, 'received today');
  assert.deepEqual(result.short, [{ item: 'Eggs', unit: 'each', short: 30 }]);

  const rows = purchases(sqlite);
  assert.deepEqual(rows.map((r) => [r.odoo_line_id, r.qty, r.unit_cost, r.day, r.po_ref]),
    [[9123, 150, 3.1667, TODAY, 'P04131'], [9124, 30, 8, TODAY, 'P04131']], 'a line not touched came in full');

  const eggs = sqlite.prepare('SELECT * FROM odoo_expected WHERE odoo_line_id = 9123').get();
  assert.equal(eggs.state, 'received');
  assert.equal(eggs.received_qty, 150);
  assert.equal(eggs.received_by, 'Ama Test');
  assert.equal(eggs.purchase_id, rows[0].id);

  const status = await send(db, { action: 'status', lineIds: [9123, 9124] });
  assert.equal(status.body.lines['9123'].state, 'received');
  assert.equal(status.body.lines['9123'].qty, 180);
  assert.equal(status.body.lines['9123'].received, 150);
  assert.equal(status.body.lines['9123'].receivedBy, 'Ama Test');
  assert.ok(status.body.lines['9123'].receivedAt.endsWith('Z'));

  // Pressed twice, or by two people: the second finds nothing waiting.
  await assert.rejects(receiveCall(db, { po: 'P04131' }), (err) => err.status === 409);
  assert.equal(purchases(sqlite).length, 2);
});

test('nothing came: 0 receives the line with no stock', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [BREAD] });
  const result = await receiveCall(db, { po: 'P04131', lines: [{ lineId: 9124, qty: 0 }] });
  assert.equal(result.total, 0);
  assert.equal(purchases(sqlite).length, 0);
  assert.equal(sqlite.prepare('SELECT state, received_qty FROM odoo_expected').get().received_qty, 0);
});

test('Deliveries lists what is on its way by PO, and what came in today', async () => {
  const { db } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line(), BREAD, line({ lineId: 9200, po: 'P04139', supplier: 'Kofi Test', productId: 78, uomId: 1, qty: 4, priceUnit: 8 })] });
  const ctx = { db, env: {}, session };
  let list = await (await incoming(ctx)).json();
  assert.deepEqual(list.orders.map((o) => [o.po, o.lines.length]), [['P04131', 2], ['P04139', 1]]);
  assert.equal(list.orders[0].lines[0].odooQty, 6);
  assert.deepEqual(list.today, []);

  await receiveCall(db, { po: 'P04131', lines: [{ lineId: 9124, qty: 26 }] });
  list = await (await incoming(ctx)).json();
  assert.deepEqual(list.orders.map((o) => o.po), ['P04139']);
  const bread = list.today.find((r) => r.lineId === 9124);
  assert.equal(bread.short, 4);
  assert.equal(bread.by, 'Ama Test');
});

// ---------------------------------------------------------------- status --

test('status says what became of each line, missing included', async () => {
  const { db } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line()] });
  await send(db, { action: 'offer', mode: 'confirmed', lines: [BREAD] });
  const out = await send(db, { action: 'status', lineIds: [9123, 9124, 5555] });
  assert.equal(out.body.lines['9123'].state, 'expected');
  assert.equal(out.body.lines['9123'].received, null);
  assert.equal(out.body.lines['9124'].state, 'recorded');
  assert.equal(out.body.lines['9124'].qty, 30);
  assert.equal(out.body.lines['5555'].state, 'missing');
});

// ---------------------------------------------------------------- cancel --

test('cancel: on its way is removed, stock on an open day comes off', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line()] });
  await send(db, { action: 'offer', mode: 'confirmed', lines: [BREAD] });

  const out = await send(db, { action: 'cancel', lineIds: [9123, 9124, 5555] });
  assert.equal(out.body.lines['9123'].state, 'removed');
  assert.equal(out.body.lines['9124'].state, 'removed');
  assert.equal(out.body.lines['5555'].state, 'missing');
  assert.equal(purchases(sqlite).length, 0);

  const status = await send(db, { action: 'status', lineIds: [9123, 9124] });
  assert.equal(status.body.lines['9123'].state, 'cancelled');
  assert.equal(status.body.lines['9124'].state, 'cancelled', 'remembered, not "never heard of it"');
  const list = await (await incoming({ db, env: {}, session })).json();
  assert.deepEqual(list.orders, [], 'gone from Deliveries');
});

test('cancel: a received line comes off too', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [BREAD] });
  await receiveCall(db, { po: 'P04131' });
  const out = await send(db, { action: 'cancel', lineIds: [9124] });
  assert.equal(out.body.lines['9124'].state, 'removed');
  assert.equal(purchases(sqlite).length, 0);
});

test('cancel: stock on a closed day is kept, and says why', async () => {
  const { db, sqlite } = database();
  await send(db, { action: 'offer', mode: 'confirmed', lines: [BREAD] });
  sqlite.exec(`INSERT INTO period_locks (from_day, to_day, reason) VALUES ('${YESTERDAY}', '${YESTERDAY}', 'Closed for the test')`);
  const out = await send(db, { action: 'cancel', lineIds: [9124] });
  assert.equal(out.body.lines['9124'].state, 'kept');
  assert.match(out.body.lines['9124'].reason, /closed/);
  assert.equal(purchases(sqlite).length, 1);
  assert.equal((await send(db, { action: 'status', lineIds: [9124] })).body.lines['9124'].state, 'recorded');
});

// ----------------------------------------------------------- items & map --

test('items: the active ingredients, grouped by category', async () => {
  const { db } = database();
  const out = await send(db, { action: 'items' });
  const ours = out.body.items.filter((i) => i.group === 'Test larder');
  assert.deepEqual(ours.map((i) => i.name).sort(), ['Bread', 'Eggs'], 'the retired jam is not offered');
  assert.deepEqual(Object.keys(ours[0]).slice(0, 4), ['id', 'name', 'unit', 'group']);
});

test('map to an existing item: the same map the hand import reads, factor and all', async () => {
  const { db, sqlite } = database();
  const out = await send(db, {
    action: 'map', productId: 80, uomId: 1, product: 'Tomatoes, basket', uom: 'Units', itemId: 901, factor: 8,
  });
  assert.deepEqual(out.body, { ok: true, item: { id: 901, name: 'Bread', unit: 'loaves' } });
  const row = sqlite.prepare('SELECT * FROM odoo_product_map WHERE odoo_product_id = 80').get();
  assert.equal(row.factor, 8);
  assert.equal(row.updated_by, 'Insight');

  // And the hand import's own rule now uses it.
  const offered = await send(db, { action: 'offer', mode: 'store', lines: [SEALANT] });
  assert.equal(offered.body.lines['9126'].qty, 48);
  assert.equal(offered.body.lines['9126'].unitCost, 4.75);
});

test('map to a new item: made from a name and a unit, kept off the quick sheet', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'map', productId: 80, uomId: 1, newItem: { name: 'Tomatoes', unit: 'kg' }, factor: 8 });
  assert.equal(out.body.item.name, 'Tomatoes');
  const made = sqlite.prepare('SELECT i.*, c.name AS category FROM ingredients i JOIN categories c ON c.id = i.category_id WHERE i.id = ?').get(out.body.item.id);
  assert.equal(made.category, 'From Odoo');
  assert.equal(made.is_core, 0);
  assert.equal(made.unit, 'kg');

  // The same name again is the same item, not a second one.
  const again = await send(db, { action: 'map', productId: 82, uomId: 1, newItem: { name: 'tomatoes', unit: 'kg' } });
  assert.equal(again.body.item.id, out.body.item.id);

  const noUnit = await send(db, { action: 'map', productId: 83, newItem: { name: 'Peppers' } });
  assert.equal(noUnit.status, 400);
  assert.match(noUnit.body.error, /unit/);
});

test('map ignore: not this store, from then on', async () => {
  const { db, sqlite } = database();
  const out = await send(db, { action: 'map', productId: 80, uomId: 1, ignore: true });
  assert.deepEqual(out.body, { ok: true, item: null });
  assert.equal(sqlite.prepare('SELECT ignored FROM odoo_product_map WHERE odoo_product_id = 80').get().ignored, 1);
  assert.equal((await send(db, { action: 'offer', mode: 'store', lines: [SEALANT] })).body.lines['9126'].state, 'ignored');

  const nothing = await send(db, { action: 'map', productId: 84 });
  assert.equal(nothing.status, 400);
  const retired = await send(db, { action: 'map', productId: 84, itemId: 902 });
  assert.equal(retired.status, 400);
});

// ------------------------------------------------------ the hand import --

test('the hand import leaves a line on its way to be received, not imported', async () => {
  const { db } = database();
  await send(db, { action: 'offer', mode: 'store', lines: [line()] });
  const imported = await alreadyImported(db, [9123, 9124]);
  assert.deepEqual(imported.get(9123), { expected: true });
  assert.equal(imported.has(9124), false);
  const c = classifyLine({ lineId: 9123, productId: 77, uomId: 12, qty: 6, unitPrice: 95 }, {
    mappings: new Map(), ingredients: new Map(), imported,
  });
  assert.equal(c.status, 'expected');
});
