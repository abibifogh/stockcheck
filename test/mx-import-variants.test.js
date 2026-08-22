import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importParts } from '../src/routes/maintenance.js';

/**
 * Loading products and their variants from a spreadsheet.
 *
 * Typing three sizes of the same bulb into a form three times is how a store
 * ends up with two of them, so the sheet takes the pair of columns that say
 * what a part is a variant of.
 *
 * The rules that matter are the ones that stop a file quietly making a mess: a
 * product with no variant, two rows claiming the same variant, and a part that
 * already exists joining a product without losing anything.
 */

const EXISTING_ITEMS = [
  { id: 4, name: 'Tap washer 15mm', product_id: null, variant: null },
  { id: 5, name: 'LED bulb — 40W warm', product_id: 3, variant: '40W warm' },
];
const EXISTING_PRODUCTS = [{ id: 3, name: 'LED bulb' }];

function fakeDb({ products = EXISTING_PRODUCTS, hasProducts = true } = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM mx_products/.test(sql)) {
        if (!hasProducts) throw new Error('no such table: mx_products');
        return { results: products };
      }
      if (/FROM mx_items/.test(sql)) return { results: EXISTING_ITEMS };
      if (/FROM mx_categories/.test(sql)) return { results: [{ id: 1, name: 'Electrical' }] };
      return { results: [] };
    },
    async first() { return null; },
    async run() { written.push({ sql, binds: this.binds }); return { success: true }; },
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

function context(db, csv, { apply = false, overwrite = false } = {}) {
  return {
    db,
    env: {},
    session: { user: { name: 'Ama', role: 'admin' } },
    request: new Request('https://example.com/api/mx/items/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv, apply, overwrite }),
    }),
  };
}

const csv = (...lines) => lines.join('\n');
const HEAD = 'Name,Product,Variant,Category,Unit,Restock level,On shelf now,Price each';
const wrote = (db, re) => db.written.filter((w) => re.test(w.sql));

// ------------------------------------------------------------- reading --

test('a row with a product and variant needs no name of its own', async () => {
  const db = fakeDb();
  const res = await importParts(context(db, csv(
    HEAD,
    ',Door handle,Chrome,Fittings,pcs,4,0,25',
    ',Door handle,Brass,Fittings,pcs,4,0,28',
  )));

  const body = await res.json();
  assert.equal(body.summary.willCreate, 2);
  assert.deepEqual(body.summary.newProducts, ['Door handle']);
  // Composed from the two columns beside it, the same way the form composes it.
  assert.deepEqual(body.preview.map((p) => p.name), [
    'Door handle — Chrome',
    'Door handle — Brass',
  ]);
});

test('a product with no variant is refused, and says why', async () => {
  const db = fakeDb();
  const res = await importParts(context(db, csv(HEAD, ',Door handle,,Fittings,pcs,4,0,25')));

  const body = await res.json();
  assert.match(body.summary.errors[0], /needs a variant/);
  assert.equal(body.summary.willCreate, 0);
});

test('a variant with no product is refused too', async () => {
  const db = fakeDb();
  const res = await importParts(context(db, csv(HEAD, ',,Chrome,Fittings,pcs,4,0,25')));

  assert.match((await res.json()).summary.errors[0], /no product to belong to/);
});

test('the same variant twice in one file is caught', async () => {
  const db = fakeDb();
  const res = await importParts(context(db, csv(
    HEAD,
    ',Door handle,Chrome,Fittings,pcs,4,0,25',
    ',Door handle,chrome,Fittings,pcs,4,0,25',
  )));

  assert.match((await res.json()).summary.errors[0], /given “chrome” twice/);
});

test('a variant another part already holds is caught', async () => {
  // LED bulb already comes in 40W warm, as part 5. A different part cannot
  // claim the same label under the same product.
  const db = fakeDb();
  const res = await importParts(context(db, csv(
    HEAD,
    'Some other bulb,LED bulb,40W warm,Electrical,pcs,4,0,25',
  )));

  assert.match((await res.json()).summary.errors[0], /already comes in “40W warm”/);
});

test('re-importing a variant against its own part is not a clash', async () => {
  // The same row the template exported. It is that part, not a rival for the label.
  const db = fakeDb();
  const res = await importParts(context(db, csv(
    HEAD,
    'LED bulb — 40W warm,LED bulb,40W warm,Electrical,pcs,4,0,25',
  )));

  const body = await res.json();
  assert.equal(body.summary.errorCount, 0);
  assert.equal(body.summary.willSkip, 1, 'skipped, because overwrite was not asked for');
});

test('a file naming products is refused where the database cannot hold them', async () => {
  const db = fakeDb({ hasProducts: false });
  const res = await importParts(context(db, csv(HEAD, ',Door handle,Chrome,Fittings,pcs,4,0,25')));

  assert.match((await res.json()).summary.errors[0], /cannot hold products yet/);
});

test('a file with no product columns imports exactly as it always did', async () => {
  const db = fakeDb({ hasProducts: false });
  const res = await importParts(context(db, csv(
    'Name,Category,Unit,Restock level,On shelf now,Price each',
    'Hinge,Fittings,pcs,10,0,5',
  )));

  const body = await res.json();
  assert.equal(body.summary.errorCount, 0);
  assert.equal(body.summary.willCreate, 1);
});

// ------------------------------------------------------------- writing --

test('applying creates the product before the parts that point at it', async () => {
  const db = fakeDb();
  await importParts(context(db, csv(
    HEAD,
    ',Door handle,Chrome,Fittings,pcs,4,0,25',
  ), { apply: true }));

  const productAt = db.written.findIndex((w) => /INSERT OR IGNORE INTO mx_products/.test(w.sql));
  const itemAt = db.written.findIndex((w) => /INSERT INTO mx_items/.test(w.sql));
  assert.ok(productAt !== -1, 'the product is created');
  assert.ok(productAt < itemAt, 'and before the part that references it');
});

test('an existing part joins a product without being replaced', async () => {
  const db = fakeDb();
  await importParts(context(db, csv(
    HEAD,
    'Tap washer 15mm,Tap washer,15mm,Plumbing,pcs,10,0,2',
  ), { apply: true, overwrite: true }));

  const [update] = wrote(db, /UPDATE mx_items SET/);
  assert.match(update.sql, /product_id = \?10, variant = \?11/);
  assert.equal(update.binds[0], 4, 'the part it already was');
  assert.equal(update.binds[10], '15mm');

  assert.equal(wrote(db, /INSERT INTO mx_items/).length, 0, 'no replacement row');
  assert.equal(wrote(db, /DELETE FROM mx_items/).length, 0);
});

test('a row naming no product leaves an existing grouping alone', async () => {
  // Otherwise re-importing an old spreadsheet would silently scatter every
  // product somebody had set up since.
  const db = fakeDb();
  await importParts(context(db, csv(
    'Name,Category,Unit,Restock level,On shelf now,Price each',
    'LED bulb — 40W warm,Electrical,pcs,4,0,25',
  ), { apply: true, overwrite: true }));

  const [update] = wrote(db, /UPDATE mx_items SET/);
  assert.ok(!/product_id/.test(update.sql), 'the grouping columns are not touched');
});
