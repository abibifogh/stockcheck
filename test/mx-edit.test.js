import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renameVariant, updateProduct } from '../src/routes/maintenance.js';

/**
 * Correcting a product or a variant after the fact.
 *
 * The whole difficulty is that a variant's part name is *composed* — "LED bulb
 * — 40W warm" — so the heading and the parts under it can drift apart. Renaming
 * the heading alone leaves every parts screen, order list and count sheet still
 * printing the old name, which is the failure these pin.
 *
 * The other half is knowing when not to. A part that already existed and was
 * attached as a variant kept the name somebody gave it, and a part renamed by
 * hand since is a decision. Re-deriving either would overwrite a name this
 * rename was never asked about, and nobody would know it had happened.
 */

const PRODUCT = { id: 3, name: 'LED bulb', category_id: 2, note: null };

/**
 * `variants` are the rows under the product; `item` is the one being renamed.
 * Writes are recorded rather than applied, so a test asserts on the SQL that
 * would have run.
 */
function fakeDb({ product = PRODUCT, variants = [], item = null, clash = null } = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM mx_items WHERE product_id/.test(sql)) return { results: variants };
      return { results: [] };
    },
    async first() {
      if (/SELECT id FROM mx_items WHERE product_id/.test(sql)) return clash;
      if (/FROM mx_products/.test(sql)) return product;
      if (/FROM mx_items WHERE id/.test(sql)) return item;
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
    request: new Request('https://example.com/api/mx/products/3', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const itemWrites = (db) => db.written.filter((w) => /UPDATE mx_items/.test(w.sql));

// ------------------------------------------------------ renaming a product --

test('renaming a product carries the names composed from it', async () => {
  const db = fakeDb({
    variants: [
      { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', category_id: 2 },
      { id: 12, name: 'LED bulb — 60W', variant: '60W', category_id: 2 },
    ],
  });

  const res = await updateProduct(context(db, { name: 'LED lamp', categoryId: 2 }));

  assert.deepEqual(
    itemWrites(db).map((w) => w.binds[1]),
    ['LED lamp — 40W warm', 'LED lamp — 60W'],
    'both parts follow the heading',
  );
  assert.equal((await res.json()).carried, 2);
});

test('a part renamed by hand is left exactly as it is', async () => {
  const db = fakeDb({
    variants: [
      { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', category_id: 2 },
      // Somebody typed this one. It is a decision, not a derivation.
      { id: 12, name: 'The warehouse bulb', variant: '60W', category_id: 2 },
    ],
  });

  const res = await updateProduct(context(db, { name: 'LED lamp', categoryId: 2 }));

  const writes = itemWrites(db);
  assert.equal(writes.length, 1, 'only the composed one moves');
  assert.equal(writes[0].binds[0], 11);
  assert.equal((await res.json()).carried, 1, 'and it says how many, so one is not silently two');
});

test('a variant filed somewhere else on purpose keeps its category', async () => {
  const db = fakeDb({
    variants: [
      { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', category_id: 2 },
      { id: 12, name: 'LED bulb — 60W', variant: '60W', category_id: 7 },
    ],
  });

  await updateProduct(context(db, { name: 'LED bulb', categoryId: 5 }));

  const byId = new Map(itemWrites(db).map((w) => [w.binds[0], w.binds[2]]));
  assert.equal(byId.get(11), 5, 'the one filed with the product moves with it');
  // Not written back with its old value — not written at all, which is the
  // stronger promise: a row nothing touches cannot be touched wrongly.
  assert.equal(byId.has(12), false, 'the one filed elsewhere is left alone');
});

test('a product with nothing under it renames on its own', async () => {
  const db = fakeDb({ variants: [] });
  const res = await updateProduct(context(db, { name: 'LED lamp', categoryId: 2 }));

  assert.equal(itemWrites(db).length, 0);
  assert.equal((await res.json()).carried, 0);
});

test('the product row itself is written once, whatever hangs off it', async () => {
  const db = fakeDb({
    variants: [
      { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', category_id: 2 },
      { id: 12, name: 'LED bulb — 60W', variant: '60W', category_id: 2 },
    ],
  });

  await updateProduct(context(db, { name: 'LED lamp', categoryId: 2 }));

  const heads = db.written.filter((w) => /UPDATE mx_products/.test(w.sql));
  assert.equal(heads.length, 1);
  assert.equal(heads[0].binds[1], 'LED lamp');
});

test('a product that has gone is reported rather than silently recreated', async () => {
  const db = fakeDb({ product: null });
  await assert.rejects(
    () => updateProduct(context(db, { name: 'LED lamp' })),
    /no longer exists/,
  );
});

// ------------------------------------------------------ renaming a variant --

test('the label and the part name move together', async () => {
  const db = fakeDb({
    item: { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', product_id: 3 },
  });

  await renameVariant(context(db, { variant: '40W soft' }), 11);

  const write = itemWrites(db)[0];
  assert.equal(write.binds[1], '40W soft', 'the label');
  assert.equal(write.binds[2], 'LED bulb — 40W soft', 'and the name derived from it');
});

test('a hand-typed part name survives a label change', async () => {
  const db = fakeDb({
    item: { id: 11, name: 'The warehouse bulb', variant: '60W', product_id: 3 },
  });

  await renameVariant(context(db, { variant: '60W clear' }), 11);

  const write = itemWrites(db)[0];
  assert.equal(write.binds[1], '60W clear');
  assert.equal(write.binds[2], 'The warehouse bulb', 'untouched');
});

test('two variants of one product cannot share a label', async () => {
  const db = fakeDb({
    item: { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', product_id: 3 },
    clash: { id: 12 },
  });

  await assert.rejects(
    () => renameVariant(context(db, { variant: '60W' }), 11),
    /already comes in 60W/,
  );
  assert.equal(itemWrites(db).length, 0, 'and nothing is written');
});

test('a part that belongs to no product is not a variant to rename', async () => {
  const db = fakeDb({
    item: { id: 11, name: 'Tap washer', variant: null, product_id: null },
  });

  await assert.rejects(
    () => renameVariant(context(db, { variant: '15mm' }), 11),
    /not a variant of anything/,
  );
});

test('an empty label is refused rather than composing a name ending in a dash', async () => {
  const db = fakeDb({
    item: { id: 11, name: 'LED bulb — 40W warm', variant: '40W warm', product_id: 3 },
  });

  await assert.rejects(() => renameVariant(context(db, { variant: '   ' }), 11));
  assert.equal(itemWrites(db).length, 0);
});
