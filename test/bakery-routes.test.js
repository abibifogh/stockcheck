import { test } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '../src/routes/bakery.js';

/**
 * What the server does with a bakery report, as opposed to what the analysis
 * later makes of it.
 *
 * Two rules live here and nowhere else. A second report for a day replaces the
 * first rather than adding to it — with one bake a day, a second send is a
 * correction or somebody checking whether the first went through, and adding
 * would put bread on the shelf that never existed. And a line carries two
 * destinations, written as two rows, so breakfast's and the bistro's can never
 * be added together by accident further down.
 *
 * A stub database: these are about which statements get written, and the stub
 * records them so the test can read them back.
 */

const ITEMS = [
  { id: 1, name: 'Sliced Bread', default_unit_cost: 15 },
  { id: 2, name: 'Rolls', default_unit_cost: 3 },
];

function fakeDb() {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM settings/.test(sql)) {
        // Notifications off, so the write path is all this test is looking at.
        return { results: [{ key: 'timezone', value: 'UTC' }, { key: 'notify_production', value: '0' }] };
      }
      // Only what was actually asked for. Returning the whole list would make
      // the route's "is everything here still on the bakery list?" check pass
      // for items the report never mentioned.
      if (/FROM ingredients/.test(sql)) {
        return { results: ITEMS.filter((i) => this.binds.includes(i.id)) };
      }
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
      // The first statement is the clear-out; report that it removed two rows.
      return statements.map((s, i) => ({ meta: { changes: i === 0 ? 2 : 1 } }));
    },
  };
}

function context(body, db = fakeDb()) {
  return {
    db,
    env: {},
    session: { user: { name: 'Adjoa', role: 'baker' } },
    request: new Request('https://example.com/api/production', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const inserts = (db) => db.written.filter((w) => /INSERT INTO production/.test(w.sql));
const deletes = (db) => db.written.filter((w) => /DELETE FROM production/.test(w.sql));

test('a report clears the day before it writes, so sending twice replaces', async () => {
  const db = fakeDb();
  await create(context({ day: '2026-08-10', lines: [{ ingredientId: 1, qty: 40 }] }, db));

  assert.equal(deletes(db).length, 1, 'the day is cleared exactly once');
  // Order matters: clearing after the insert would delete what was just written.
  assert.ok(
    db.written.findIndex((w) => /DELETE FROM production/.test(w.sql))
      < db.written.findIndex((w) => /INSERT INTO production/.test(w.sql)),
    'the clear-out must come before the inserts',
  );
  assert.equal(deletes(db)[0].binds[0], '2026-08-10', 'and only that day');
});

test('the clear-out is scoped to whoever is reporting', async () => {
  const db = fakeDb();
  await create(context({ day: '2026-08-10', lines: [{ ingredientId: 1, qty: 40 }] }, db));

  // A signed-in baker is not a link, so it clears the day's link-less rows and
  // leaves any bakery's own report alone.
  assert.match(deletes(db)[0].sql, /link_id IS NULL/);
});

test('a line with both destinations is written as two rows', async () => {
  const db = fakeDb();
  const res = await create(context({
    day: '2026-08-10',
    lines: [{ ingredientId: 1, qty: 40, bistroQty: 25 }],
  }, db));

  const rows = inserts(db);
  assert.equal(rows.length, 2);

  const destinations = rows.map((r) => r.binds.at(-1));
  assert.deepEqual(destinations.sort(), ['bistro', 'breakfast']);

  const qtyFor = (destination) => rows.find((r) => r.binds.at(-1) === destination).binds[3];
  assert.equal(qtyFor('breakfast'), 40);
  assert.equal(qtyFor('bistro'), 25);

  const body = await res.json();
  assert.match(body.summary, /40 Sliced Bread/, 'breakfast’s is the headline');
  assert.match(body.bistroSummary, /25 Sliced Bread/);
  assert.equal(body.replaced, 2, 'and it says what it replaced');
});

test('a bistro-only line still writes, and says breakfast got nothing', async () => {
  const db = fakeDb();
  const res = await create(context({
    day: '2026-08-10',
    lines: [{ ingredientId: 1, qty: 0, bistroQty: 30 }],
  }, db));

  const rows = inserts(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].binds.at(-1), 'bistro');

  const body = await res.json();
  assert.equal(body.summary, 'nothing for breakfast');
  assert.match(body.bistroSummary, /30 Sliced Bread/);
});

test('a line with no destination named is breakfast’s', async () => {
  const db = fakeDb();
  await create(context({ day: '2026-08-10', lines: [{ ingredientId: 1, qty: 12 }] }, db));

  const rows = inserts(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].binds.at(-1), 'breakfast');
});

test('every quantity zero is still refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => create(context({ day: '2026-08-10', lines: [{ ingredientId: 1, qty: 0, bistroQty: 0 }] }, db)),
    /Every quantity was zero/,
  );
  assert.equal(deletes(db).length, 0, 'and nothing is cleared on a refused report');
});
