import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addVariant, attachToProduct, createProduct, deleteProduct, listProducts,
} from '../src/routes/maintenance.js';

/**
 * Parts that come in variants.
 *
 * The design in one line: a variant *is* a part. Every ledger in the store keys
 * on mx_items.id, so a variant that is an item already has its own balance, its
 * own count line and its own restock alert — and the product above it is a
 * heading that never holds a balance of its own.
 *
 * These pin the two things that would quietly undo that: a product left behind
 * with no variants under it, and a part losing its history on the way in.
 */

const PRODUCT = { id: 3, name: 'LED bulb', category_id: 2, note: null };
const ITEM = { id: 11, name: 'Tap washer', product_id: null, variant: null };

function fakeDb({
  product = PRODUCT, item = ITEM, clash = null, held = 0, batchFails = null,
} = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() { return { results: [] }; },
    async first() {
      if (/INSERT INTO mx_products/.test(sql)) {
        written.push({ sql, binds: this.binds });
        return { ...PRODUCT, name: this.binds[0] };
      }
      if (/INSERT INTO mx_items/.test(sql)) {
        written.push({ sql, binds: this.binds });
        return { id: 99 };
      }
      if (/COUNT\(\*\) AS n FROM mx_items/.test(sql)) return { n: held };
      if (/SELECT id FROM mx_items WHERE product_id/.test(sql)) return clash;
      if (/FROM mx_products/.test(sql)) return product;
      if (/FROM mx_items/.test(sql)) return item;
      return null;
    },
    async run() {
      written.push({ sql, binds: this.binds });
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    written,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      if (batchFails) throw new Error(batchFails);
      for (const s of statements) written.push({ sql: s.sql, binds: s.binds });
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function context(db, body) {
  return {
    db,
    env: {},
    session: { user: { name: 'Ama', role: 'admin' } },
    request: new Request('https://example.com/api/mx/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const wrote = (db, re) => db.written.filter((w) => re.test(w.sql));

const THREE = {
  name: 'LED bulb',
  categoryId: 2,
  variants: [
    { variant: '40W warm', parLevel: 10 },
    { variant: '40W white', parLevel: 10 },
    { variant: '60W white', parLevel: 4 },
  ],
};

// ------------------------------------------------------------- creating --

test('each variant becomes a part of its own', async () => {
  const db = fakeDb();
  const res = await createProduct(context(db, THREE));

  const items = wrote(db, /INSERT INTO mx_items/);
  assert.equal(items.length, 3, 'three variants, three parts');
  assert.equal((await res.json()).variants, 3);

  // Which is what gives each one its own balance and its own count line:
  // nothing else in the store had to learn what a product is.
  const productIds = items.map((i) => i.binds[9]);
  assert.deepEqual(productIds, [3, 3, 3]);
  assert.deepEqual(items.map((i) => i.binds[10]), ['40W warm', '40W white', '60W white']);
});

test('the part name is composed so it stays unique and reads alone', async () => {
  const db = fakeDb();
  await createProduct(context(db, THREE));

  assert.deepEqual(wrote(db, /INSERT INTO mx_items/).map((i) => i.binds[1]), [
    'LED bulb — 40W warm',
    'LED bulb — 40W white',
    'LED bulb — 60W white',
  ]);
});

test('a variant keeps its own restock level', async () => {
  const db = fakeDb();
  await createProduct(context(db, THREE));

  // 60W runs out slower, so it is not held to the same level as the others.
  assert.deepEqual(wrote(db, /INSERT INTO mx_items/).map((i) => i.binds[3]), [10, 10, 4]);
});

test('a product with no variants is refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => createProduct(context(db, { name: 'LED bulb', variants: [] })),
    /at least one variant/,
  );
});

test('two variants with the same label are refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => createProduct(context(db, {
      name: 'LED bulb',
      variants: [{ variant: '40W' }, { variant: '40W' }],
    })),
    /same label/,
  );
  assert.equal(wrote(db, /INSERT INTO mx_products/).length, 0, 'and nothing is written');
});

test('a product is never left standing with no variants under it', async () => {
  // If the parts fail to write, the heading goes with them — otherwise somebody
  // is left with a product that means nothing and no way to see why.
  const db = fakeDb({ batchFails: 'UNIQUE constraint failed: mx_items.name' });
  await assert.rejects(() => createProduct(context(db, THREE)), /same name as a part/);

  assert.equal(wrote(db, /DELETE FROM mx_products/).length, 1, 'the heading is cleaned up');
});

// -------------------------------------------------------------- adding --

test('another variant can be added later', async () => {
  const db = fakeDb();
  await addVariant(context(db, { variant: '100W white', parLevel: 2 }), 3);

  const [item] = wrote(db, /INSERT INTO mx_items/);
  assert.equal(item.binds[1], 'LED bulb — 100W white');
  assert.equal(item.binds[10], '100W white');
});

test('a variant it already comes in is refused', async () => {
  const db = fakeDb({ clash: { id: 12 } });
  await assert.rejects(
    () => addVariant(context(db, { variant: '40W warm' }), 3),
    /already comes in 40W warm/,
  );
});

test('adding to a product that has gone is a plain not-found', async () => {
  const db = fakeDb({ product: null });
  await assert.rejects(() => addVariant(context(db, { variant: '5W' }), 3), /no longer exists/);
});

// ------------------------------------------------------------ attaching --

test('an existing part joins a product without losing its history', async () => {
  // The whole reason products are their own table. The part keeps its id, so
  // every issue, delivery and count ever recorded against it stays put.
  const db = fakeDb();
  await attachToProduct(context(db, { productId: 3, variant: '15mm' }), 11);

  const [update] = wrote(db, /UPDATE mx_items SET product_id/);
  assert.deepEqual(update.binds, [3, '15mm', 11]);

  assert.equal(wrote(db, /INSERT INTO mx_items/).length, 0, 'no new row');
  assert.equal(wrote(db, /DELETE FROM mx_items/).length, 0, 'and no old one removed');
  assert.equal(wrote(db, /UPDATE mx_issues|UPDATE mx_purchases|UPDATE mx_counts/).length, 0,
    'nothing is re-pointed, because nothing needs to be');
});

test('detaching leaves the part exactly where it was', async () => {
  const db = fakeDb();
  await attachToProduct(context(db, { productId: null }), 11);

  const [update] = wrote(db, /UPDATE mx_items SET product_id = NULL/);
  assert.deepEqual(update.binds, [11]);
  assert.equal(wrote(db, /DELETE FROM mx_items/).length, 0);
});

test('attaching under a label a sibling already uses is refused', async () => {
  const db = fakeDb({ clash: { id: 12 } });
  await assert.rejects(
    () => attachToProduct(context(db, { productId: 3, variant: '40W warm' }), 11),
    /already comes in/,
  );
});

// ------------------------------------------------------------- removing --

test('a product with variants still under it cannot be removed', async () => {
  const db = fakeDb({ held: 3 });
  await assert.rejects(() => deleteProduct(context(db, {}), 3), /still has variants/);
  assert.equal(wrote(db, /DELETE FROM mx_products/).length, 0);
});

test('an empty product goes', async () => {
  const db = fakeDb({ held: 0 });
  const res = await deleteProduct(context(db, {}), 3);

  assert.equal((await res.json()).ok, true);
  assert.equal(wrote(db, /DELETE FROM mx_products/).length, 1);
});

// -------------------------------------------------- before the tables exist --

test('a database that cannot hold products says so rather than reporting none', async () => {
  // The two are not the same thing, and treating them as one is what let the
  // setup screen offer a form that could only fail on its Create button.
  const db = fakeDb();
  db.prepare = (sql) => ({
    sql,
    bind() { return this; },
    async all() {
      if (/FROM mx_products/.test(sql)) throw new Error('D1_ERROR: no such table: mx_products');
      return { results: [] };
    },
    async first() { return null; },
    async run() { return { success: true }; },
  });

  const body = await (await listProducts({ db, session: { user: { name: 'Ama', role: 'admin' } } })).json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.products, []);
});

test('a database with the table but nothing in it is ready, not broken', async () => {
  const db = fakeDb();
  db.prepare = (sql) => ({
    sql,
    bind() { return this; },
    async all() { return { results: [] }; },
    async first() { return null; },
    async run() { return { success: true }; },
  });

  const body = await (await listProducts({ db, session: { user: { name: 'Ama', role: 'admin' } } })).json();
  assert.equal(body.ready, true);
  assert.deepEqual(body.products, []);
});
