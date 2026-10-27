import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  OdooError, cleanKey, configProblem, odooConfig, parsePoNumbers, poName, readOrders, testConnection,
} from '../src/lib/odoo.js';
import { importOrders, preview, saveMappings } from '../src/routes/odoo.js';

/**
 * Purchase orders pulled in from Odoo.
 *
 * What matters here is money landing in the cost reports, so the things pinned
 * are the ones that would be wrong quietly: a PO imported twice, a crate
 * recorded as one egg, a draft order put on the shelf, a discount left out of
 * the price, a typo in a PO number read as "nothing to import".
 */

// ------------------------------------------------------------ a fake Odoo --

const ORDERS = [
  {
    id: 10, name: 'P02433', partner_id: [5, 'Kumasi Farms'], state: 'purchase',
    date_order: '2026-10-14 09:12:00', date_approve: '2026-10-14 10:00:00',
    amount_untaxed: 313, amount_total: 350,
  },
  {
    id: 11, name: 'P02434', partner_id: [6, 'Accra Bakery'], state: 'draft',
    date_order: '2026-10-15 08:00:00', date_approve: false, amount_untaxed: 50, amount_total: 55,
  },
];

const LINES = [
  // Two crates of thirty eggs at 90 a crate.
  {
    id: 101, order_id: [10, 'P02433'], product_id: [412, 'Eggs (crate)'], name: 'Eggs',
    product_qty: 2, qty_received: 2, price_unit: 90, price_subtotal: 180, display_type: false,
    product_uom_id: [7, 'Crate'],
  },
  // Not breakfast at all.
  {
    id: 102, order_id: [10, 'P02433'], product_id: [500, 'Dish soap'], name: 'Dish soap',
    product_qty: 1, qty_received: 1, price_unit: 25, price_subtotal: 25, display_type: false,
    product_uom_id: [1, 'Units'],
  },
  // A section heading. Lines on an order, with no product.
  {
    id: 103, order_id: [10, 'P02433'], product_id: false, name: 'Bakery', product_qty: 0,
    qty_received: 0, price_unit: 0, price_subtotal: 0, display_type: 'line_section',
    product_uom_id: false,
  },
  // Ten loaves at 12 with ten per cent off: 10.80 each is what was paid.
  {
    id: 104, order_id: [10, 'P02433'], product_id: [413, 'Bread loaf'], name: 'Bread',
    product_qty: 10, qty_received: 0, price_unit: 12, price_subtotal: 108, display_type: false,
    product_uom_id: [1, 'Units'],
  },
  {
    id: 201, order_id: [11, 'P02434'], product_id: [413, 'Bread loaf'], name: 'Bread',
    product_qty: 5, qty_received: 0, price_unit: 10, price_subtotal: 50, display_type: false,
    product_uom_id: [1, 'Units'],
  },
];

/** Answers search_read the way Odoo's JSON-2 API does. */
function fakeOdoo({ oldUomName = false, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const respond = (data, code = 200) => new Response(JSON.stringify(data), { status: code });
    if (status !== 200) return respond({ message: 'nope' }, status);

    if (url.endsWith('/json/2/purchase.order/search_read')) {
      const [[, , names]] = body.domain;
      return respond(ORDERS.filter((o) => names.includes(o.name)));
    }
    if (url.endsWith('/json/2/purchase.order.line/search_read')) {
      // An Odoo before 19 has no product_uom_id, and says so.
      if (oldUomName && body.fields.includes('product_uom_id')) {
        return respond({ name: 'builtins.ValueError', message: 'Invalid field product_uom_id on purchase.order.line' }, 422);
      }
      const [[, , ids]] = body.domain;
      return respond(LINES.filter((l) => ids.includes(l.order_id[0])).map((l) => {
        const out = { ...l };
        if (oldUomName) { out.product_uom = l.product_uom_id; delete out.product_uom_id; }
        return out;
      }));
    }
    return respond({ message: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

const CONFIG = { base: 'https://example.odoo.com', db: 'example', key: 'secret-key' };

// ------------------------------------------------------------ PO numbers --

test('a PO number is the name Odoo gives it, however it was typed', () => {
  // The same rule as the insight application, so a number means one order.
  assert.equal(poName('2433'), 'P02433');
  assert.equal(poName('p2433'), 'P02433');
  assert.equal(poName(' P02433 '), 'P02433');
  assert.equal(poName('P123456'), 'P123456');
});

test('many PO numbers can be pasted at once, in any layout', () => {
  assert.deepEqual(
    parsePoNumbers('2433, p2434\nP02435;  2433\t2436'),
    ['P02433', 'P02434', 'P02435', 'P02436'],
  );
  assert.deepEqual(parsePoNumbers('  '), []);
});

test('the API key is only ever sent over https', () => {
  assert.match(configProblem({ ...CONFIG, base: 'http://example.odoo.com' }), /https/);
  assert.match(configProblem({ ...CONFIG, key: '' }), /ODOO_API_KEY/);
  assert.equal(configProblem(CONFIG), null);
});

// ---------------------------------------------------------- reading Odoo --

test('orders come back with their product lines, and nothing else', async () => {
  const { fetchImpl, calls } = fakeOdoo();
  const { orders, unknown } = await readOrders(CONFIG, ['2433', 'P09999'], { fetchImpl });

  assert.deepEqual(unknown, ['P09999'], 'a mistyped number is said out loud');
  assert.equal(orders.length, 1);
  const [order] = orders;
  assert.equal(order.vendor, 'Kumasi Farms');
  assert.equal(order.orderedOn, '2026-10-14');
  assert.equal(order.importable, true);
  assert.deepEqual(order.lines.map((l) => l.lineId), [101, 102, 104], 'the section heading is not a line');

  // Read-only, and authenticated the way JSON-2 expects.
  assert.ok(calls.every((c) => c.url.endsWith('/search_read')));
  assert.equal(calls[0].headers.Authorization, 'bearer secret-key');
  assert.equal(calls[0].headers['X-Odoo-Database'], 'example');
});

test('the price is what was paid, discount included', async () => {
  const { fetchImpl } = fakeOdoo();
  const { orders } = await readOrders(CONFIG, ['P02433'], { fetchImpl });
  const bread = orders[0].lines.find((l) => l.lineId === 104);
  assert.equal(bread.unitPrice, 10.8);
});

test('an Odoo older than 19 is read by its own name for the unit', async () => {
  const { fetchImpl } = fakeOdoo({ oldUomName: true });
  const { orders } = await readOrders(CONFIG, ['P02433'], { fetchImpl });
  const eggs = orders[0].lines.find((l) => l.lineId === 101);
  assert.equal(eggs.uomId, 7);
  assert.equal(eggs.uom, 'Crate');
});

test('a draft order is read but marked as not importable', async () => {
  const { fetchImpl } = fakeOdoo();
  const { orders } = await readOrders(CONFIG, ['P02434'], { fetchImpl });
  assert.equal(orders[0].importable, false);
  assert.match(orders[0].stateText, /quotation/);
});

test('a refused key becomes a sentence, not a status code', async () => {
  const { fetchImpl } = fakeOdoo({ status: 401 });
  await assert.rejects(readOrders(CONFIG, ['P02433'], { fetchImpl }),
    (err) => err instanceof OdooError && err.kind === 'key' && /did not accept the API key/.test(err.message));
});

test('a key accepted without the rights is not reported as a bad key', async () => {
  // The two have different fixes. Sending somebody to make a new key when the
  // key was fine and the user lacked Purchase rights wastes an afternoon.
  const fetchImpl = async () => new Response(JSON.stringify({
    name: 'odoo.exceptions.AccessError',
    message: 'You are not allowed to access Purchase Order (purchase.order) records.',
  }), { status: 403 });
  await assert.rejects(readOrders(CONFIG, ['P02433'], { fetchImpl }), (err) => {
    assert.equal(err.kind, 'access');
    assert.match(err.message, /accepted the API key/);
    assert.match(err.message, /Odoo said: You are not allowed to access Purchase Order/);
    return true;
  });
});

test('a key pasted with a newline, quotes or "bearer" is the same key', () => {
  for (const pasted of ['abc123\n', '  abc123  ', '"abc123"', "'abc123'", 'bearer abc123', 'Bearer abc123\r\n']) {
    assert.equal(cleanKey(pasted), 'abc123', JSON.stringify(pasted));
  }
  assert.equal(odooConfig({ odoo_base: 'https://x.odoo.com/' }, { ODOO_API_KEY: 'abc123\n' }).key, 'abc123');
  assert.equal(cleanKey(undefined), '');
});

test('the connection test says which step fails: the key', async () => {
  const { fetchImpl, calls } = fakeOdoo({ status: 401 });
  const result = await testConnection(CONFIG, { fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((s) => [s.step, s.ok]), [['key', false]]);
  assert.equal(calls.length, 1, 'stops at the first failure');
});

test('the connection test says which step fails: the rights', async () => {
  const fetchImpl = async (url) => (url.includes('/res.partner/')
    ? new Response(JSON.stringify([{ id: 1 }]))
    : new Response(JSON.stringify({ message: 'You are not allowed to access Purchase Order' }), { status: 403 }));
  const result = await testConnection(CONFIG, { fetchImpl });
  assert.deepEqual(result.steps.map((s) => [s.step, s.ok]), [['key', true], ['purchases', false]]);
  assert.match(result.steps[1].text, /Purchase: User/);
});

test('the connection test passes when both answer', async () => {
  const fetchImpl = async () => new Response(JSON.stringify([{ id: 1 }]));
  const result = await testConnection(CONFIG, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 2);
});

test('the connection test never asks Odoo without a key', async () => {
  let asked = 0;
  const result = await testConnection({ ...CONFIG, key: '' }, { fetchImpl: async () => { asked += 1; } });
  assert.equal(result.ok, false);
  assert.equal(asked, 0);
});

// --------------------------------------------------------------- importing --

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  sqlite.exec(`
    UPDATE settings SET value = 'https://example.odoo.com' WHERE key = 'odoo_base';
    INSERT INTO categories (id, name) VALUES (90, 'Test larder');
    INSERT INTO ingredients (id, category_id, name, unit) VALUES
      (900, 90, 'Eggs', 'pcs'), (901, 90, 'Bread', 'loaf');
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

function context(db, body, fetchImpl) {
  return {
    db,
    env: { ODOO_API_KEY: 'secret-key' },
    fetchImpl,
    url: new URL('https://example.com/api/odoo/import'),
    session: { user: { name: 'Ama', role: 'admin' } },
    request: new Request('https://example.com/api/odoo/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const call = async (handler, db, body, fetchImpl = fakeOdoo().fetchImpl) => {
  const res = await handler(context(db, body, fetchImpl));
  return res.json();
};

const EGGS_BY_CRATE = { productId: 412, uomId: 7, product: 'Eggs (crate)', uom: 'Crate', ingredientId: 900, factor: 30 };
const BREAD = { productId: 413, uomId: 1, product: 'Bread loaf', uom: 'Units', ingredientId: 901, factor: 1 };
const SOAP = { productId: 500, uomId: 1, product: 'Dish soap', uom: 'Units', ignored: true };

test('a product nobody has matched yet is asked about, not guessed', async () => {
  const { db } = database();
  const result = await call(preview, db, { pos: 'P02433' });
  const statuses = result.orders[0].lines.map((l) => l.status);
  assert.deepEqual(statuses, ['unmatched', 'unmatched', 'unmatched']);
});

test('crates become eggs, and the line total holds', async () => {
  const { db, sqlite } = database();
  const result = await call(importOrders, db, { pos: '2433', mappings: [EGGS_BY_CRATE, BREAD, SOAP] });

  assert.equal(result.recorded, 2);
  const rows = sqlite.prepare('SELECT * FROM purchases ORDER BY odoo_line_id').all();
  const eggs = rows.find((r) => r.odoo_line_id === 101);
  assert.equal(eggs.qty, 60, 'two crates of thirty');
  assert.equal(eggs.unit_cost, 3, '90 a crate is 3 an egg');
  assert.equal(eggs.qty * eggs.unit_cost, 180);
  assert.equal(eggs.po_ref, 'P02433');
  assert.equal(eggs.supplier, 'Kumasi Farms');
  assert.equal(eggs.day, '2026-10-14', 'recorded on the order date unless told otherwise');

  const bread = rows.find((r) => r.odoo_line_id === 104);
  assert.equal(bread.unit_cost, 10.8);
  assert.equal(rows.some((r) => r.odoo_line_id === 102), false, 'the dish soap is not breakfast');

  const audit = sqlite.prepare("SELECT * FROM audit_log WHERE action = 'odoo.import'").all();
  assert.equal(audit.length, 1);
});

test('importing the same PO twice records it once', async () => {
  const { db, sqlite } = database();
  await call(importOrders, db, { pos: 'P02433', mappings: [EGGS_BY_CRATE, BREAD, SOAP] });
  const again = await call(importOrders, db, { pos: 'P02433' });

  assert.equal(again.recorded, 0);
  assert.equal(again.orders[0].skipped, 2);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 2);
});

test('lines left unmatched come in on the next import, and only they do', async () => {
  const { db, sqlite } = database();
  const first = await call(importOrders, db, { pos: 'P02433', mappings: [EGGS_BY_CRATE] });
  assert.equal(first.recorded, 1);
  assert.deepEqual(first.orders[0].unmatched, ['Dish soap', 'Bread loaf']);

  // The matches are remembered: this request carries only the new one.
  const second = await call(importOrders, db, { pos: 'P02433', mappings: [BREAD] });
  assert.equal(second.recorded, 1);
  assert.equal(second.orders[0].skipped, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 2);
});

test('a remembered match is used without being asked again', async () => {
  const { db } = database();
  await call(saveMappings, db, { mappings: [EGGS_BY_CRATE, BREAD, SOAP] });
  const result = await call(preview, db, { pos: 'P02433' });
  assert.deepEqual(result.orders[0].lines.map((l) => l.status), ['ready', 'ignored', 'ready']);
  assert.equal(result.orders[0].summary.value, 288);
});

test('a draft order is never recorded', async () => {
  const { db, sqlite } = database();
  const result = await call(importOrders, db, { pos: 'P02434', mappings: [BREAD] });
  assert.equal(result.recorded, 0);
  assert.match(result.orders[0].refused, /quotation/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 0);
});

test('a closed period is respected, and the order says why it was left out', async () => {
  const { db, sqlite } = database();
  sqlite.exec("INSERT INTO period_locks (from_day, to_day, reason) VALUES ('2026-10-01', '2026-10-31', 'October closed')");
  const result = await call(importOrders, db, { pos: 'P02433', mappings: [EGGS_BY_CRATE, BREAD] });
  assert.equal(result.recorded, 0);
  assert.match(result.orders[0].refused, /closed period/);

  // Recorded on an open day instead, when somebody chooses one.
  const moved = await call(importOrders, db, { pos: 'P02433', days: { P02433: '2026-11-02' } });
  assert.equal(moved.recorded, 2);
  assert.equal(sqlite.prepare('SELECT DISTINCT day FROM purchases').get().day, '2026-11-02');
});

test('the prices recorded are Odoo’s, whatever the request says', async () => {
  // The browser sends PO numbers and matches. A price in the request has
  // nowhere to go: the import reads the order out of Odoo itself.
  const { db, sqlite } = database();
  await call(importOrders, db, {
    pos: 'P02433',
    mappings: [EGGS_BY_CRATE],
    lines: [{ lineId: 101, unitPrice: 1 }],
    unit_cost: 1,
  });
  assert.equal(sqlite.prepare('SELECT unit_cost FROM purchases').get().unit_cost, 3);
});

test('no API key on the Worker stops the import before Odoo is asked', async () => {
  const { db } = database();
  const { fetchImpl, calls } = fakeOdoo();
  const ctx = context(db, { pos: 'P02433' }, fetchImpl);
  ctx.env = {};
  await assert.rejects(preview(ctx), (err) => err.status === 409 && /ODOO_API_KEY/.test(err.message));
  assert.equal(calls.length, 0);
});

test('two people importing at once still record each line once', async () => {
  // Somebody else's import lands between this one reading what is already
  // here and writing. The unique index turns the line away; the count must
  // say so rather than claim it.
  const { db, sqlite } = database();
  await call(saveMappings, db, { mappings: [EGGS_BY_CRATE, BREAD] });
  const racing = {
    ...db,
    prepare(sql) {
      const st = db.prepare(sql);
      if (!/WHERE odoo_line_id IN/.test(sql)) return st;
      const all = st.all;
      st.all = async () => {
        const out = await all();
        sqlite.exec(`INSERT INTO purchases (day, ingredient_id, qty, unit_cost, po_ref, odoo_line_id)
                     VALUES ('2026-10-14', 900, 60, 3, 'P02433', 101)`);
        return out;
      };
      return st;
    },
  };
  const result = await call(importOrders, racing, { pos: 'P02433' });
  assert.equal(result.recorded, 1);
  assert.equal(result.orders[0].skipped, 1);
  assert.equal(result.total, 108);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM purchases').get().n, 2);
});
