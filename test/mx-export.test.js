import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportAreas, exportItems } from '../src/routes/maintenance.js';

/**
 * The parts list and the room list as spreadsheets.
 *
 * Deliberately not the import template. That one exists to be written on and
 * handed back, so it carries only what the importer accepts; an export exists
 * to be read, so it carries the derived half — what is on the shelf now, what
 * it is worth, what each room has cost. The two are easy to conflate and the
 * failure is quiet: a balance in a template gets edited, uploaded, and
 * silently ignored.
 */

const ITEMS = [
  {
    id: 1, name: 'LED bulb — 9W', category_id: 1, unit: 'pcs', par_level: 40,
    opening_stock: 10, default_unit_cost: 25, is_common: 1, active: 1, note: 'warm white',
    attributes: JSON.stringify({ Size: '9W', Colour: 'Warm' }), product_id: 5, variant: '9W',
  },
  {
    id: 2, name: 'Tap washer', category_id: 2, unit: 'pcs', par_level: 20,
    opening_stock: 4, default_unit_cost: 2, is_common: 0, active: 1, note: null,
    attributes: null, product_id: null, variant: null,
  },
  {
    // Retired, and still holding stock. stockReport leaves it out because it
    // answers "what should I order"; a stock list has to include it.
    id: 3, name: 'Old brass fitting', category_id: 2, unit: 'pcs', par_level: 0,
    opening_stock: 6, default_unit_cost: 15, is_common: 0, active: 0, note: null,
    attributes: null, product_id: null, variant: null,
  },
];

const AREAS = [
  { id: 1, name: 'Room 101', kind: 'room', block: 'First floor', sort_order: 10, active: 1 },
  { id: 2, name: 'Roof plant room', kind: 'area', block: null, sort_order: 20, active: 1 },
  { id: 3, name: 'Old annexe', kind: 'room', block: 'Annexe', sort_order: 30, active: 0 },
];

const ISSUES = [
  { id: 1, day: '2026-09-01', item_id: 1, area_id: 1, qty: 2 },
  { id: 2, day: '2026-09-02', item_id: 2, area_id: 1, qty: 3 },
  // Issued to nowhere. A total that skips this is a total that does not add up.
  { id: 3, day: '2026-09-03', item_id: 1, area_id: null, qty: 1 },
];

function fakeDb({ items = ITEMS, areas = AREAS, issues = ISSUES, purchases = [] } = {}) {
  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM mx_items/.test(sql)) return { results: items };
      if (/FROM mx_areas/.test(sql)) return { results: areas };
      if (/FROM mx_issues/.test(sql)) return { results: issues };
      if (/FROM mx_purchases/.test(sql)) return { results: purchases };
      if (/FROM mx_categories/.test(sql)) {
        return { results: [{ id: 1, name: 'Electrical' }, { id: 2, name: 'Plumbing' }] };
      }
      if (/FROM mx_products/.test(sql)) return { results: [{ id: 5, name: 'LED bulb' }] };
      if (/FROM settings/.test(sql)) return { results: [{ key: 'currency', value: 'GHS' }] };
      return { results: [] };
    },
    async first() { return null; },
    async run() { return { success: true }; },
  });
  return { prepare: (sql) => statement(sql), async batch() { return []; } };
}

const ctx = (db, query = '') => ({
  db,
  env: {},
  url: new URL(`https://example.com/api/mx/items/export${query}`),
  session: { user: { name: 'Ama', role: 'admin' } },
  request: new Request('https://example.com/api/mx/items/export'),
});

/** Parse the response back into rows, so assertions are about the file. */
async function csv(res) {
  const text = (await res.text()).replace(/^﻿/, '');
  return text.split('\n').map((line) => {
    const cells = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cell); cell = ''; }
      else cell += c;
    }
    cells.push(cell);
    return cells;
  });
}

const col = (rows, name) => rows[0].indexOf(name);
const find = (rows, label) => rows.find((r) => r[0] === label);

// ------------------------------------------------------------------ parts --

test('it comes back as a downloadable csv, not as json', async () => {
  const res = await exportItems(ctx(fakeDb()));
  assert.match(res.headers.get('Content-Type'), /text\/csv/);
  assert.match(res.headers.get('Content-Disposition'), /attachment; filename="maintenance-parts-/);
});

test('every part is a row, retired ones included', async () => {
  const rows = await csv(await exportItems(ctx(fakeDb())));
  const names = rows.slice(1).map((r) => r[0]).filter(Boolean);
  assert.deepEqual(names.sort(), ['LED bulb — 9W', 'Old brass fitting', 'Tap washer']);
});

test('a retired part still holding stock is marked and still counted', async () => {
  // Six on a shelf is six the store owns, whether or not anybody will reorder
  // it. Leaving it out understates what the store is worth.
  const rows = await csv(await exportItems(ctx(fakeDb())));
  const row = find(rows, 'Old brass fitting');

  assert.equal(row[col(rows, 'Status')], 'retired');
  assert.equal(Number(row[col(rows, 'On shelf')]), 6);
  assert.equal(Number(row[col(rows, 'Value on shelf')]), 90, 'six at fifteen');
});

test('the balance is what is left, not the opening figure', async () => {
  // The template carries opening stock because that is what the importer
  // accepts. An export has to carry what the shelf actually holds.
  const rows = await csv(await exportItems(ctx(fakeDb())));

  assert.equal(Number(find(rows, 'LED bulb — 9W')[col(rows, 'On shelf')]), 7, '10 opening less 3 issued');
  assert.equal(Number(find(rows, 'Tap washer')[col(rows, 'On shelf')]), 1, '4 opening less 3 issued');
});

test('a part below its level says so rather than leaving it to be worked out', async () => {
  const rows = await csv(await exportItems(ctx(fakeDb())));
  assert.match(find(rows, 'LED bulb — 9W')[col(rows, 'Status')], /below its restock level/);
});

test('the product and variant travel with the part', async () => {
  const rows = await csv(await exportItems(ctx(fakeDb())));
  const row = find(rows, 'LED bulb — 9W');
  assert.equal(row[col(rows, 'Product')], 'LED bulb');
  assert.equal(row[col(rows, 'Variant')], '9W');
});

test('details are one cell, so adding one does not move every column', async () => {
  const rows = await csv(await exportItems(ctx(fakeDb())));
  assert.equal(find(rows, 'LED bulb — 9W')[col(rows, 'Details')], 'Size: 9W · Colour: Warm');
  assert.equal(find(rows, 'Tap washer')[col(rows, 'Details')], '');
});

test('a name with a comma survives the round trip', async () => {
  // The whole reason a csv writer is worth testing.
  const rows = await csv(await exportItems(ctx(fakeDb({
    items: [{ ...ITEMS[1], name: 'Washer, brass, 15mm' }],
  }))));
  assert.equal(rows[1][0], 'Washer, brass, 15mm');
});

// ------------------------------------------------------------------ rooms --

test('every room and area is a row, with what it has consumed', async () => {
  const rows = await csv(await exportAreas(ctx(fakeDb())));

  const room = find(rows, 'Room 101');
  assert.equal(room[col(rows, 'Kind')], 'Room');
  assert.equal(room[col(rows, 'Block or floor')], 'First floor');
  assert.equal(Number(room[col(rows, 'Issues recorded')]), 2);
  assert.equal(Number(room[col(rows, 'Cost to date')]), 56, '2 bulbs at 25 plus 3 washers at 2');
  assert.equal(room[col(rows, 'Last issue')], '2026-09-02');
});

test('a retired place is listed as retired rather than dropped', async () => {
  const rows = await csv(await exportAreas(ctx(fakeDb())));
  assert.equal(find(rows, 'Old annexe')[col(rows, 'In use')], 'retired');
});

test('a place that has consumed nothing reads as zero, not as blank', async () => {
  const rows = await csv(await exportAreas(ctx(fakeDb())));
  const roof = find(rows, 'Roof plant room');
  assert.equal(Number(roof[col(rows, 'Issues recorded')]), 0);
  assert.equal(Number(roof[col(rows, 'Cost to date')]), 0);
});

test('parts issued against no place get a row of their own', async () => {
  // Otherwise the column of costs quietly fails to add up to the total the
  // reports show, and nobody can see why.
  const rows = await csv(await exportAreas(ctx(fakeDb())));
  const loose = find(rows, 'Not recorded against a place');

  assert.ok(loose, 'the gap is admitted rather than hidden');
  assert.equal(Number(loose[col(rows, 'Issues recorded')]), 1);
  assert.equal(Number(loose[col(rows, 'Cost to date')]), 25);
});

test('nothing issued anywhere still produces a usable file', async () => {
  const rows = await csv(await exportAreas(ctx(fakeDb({ issues: [] }))));
  assert.equal(rows[0][0], 'Name', 'the header is still there');
  assert.equal(rows.length, 4, 'three places, no loose row');
});
