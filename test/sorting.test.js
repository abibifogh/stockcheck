import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextSort, sorted } from '../public/js/views/components.js';

/**
 * Sorting a list on screen.
 *
 * Two pure functions behind every sortable heading, which is why they are
 * worth pinning here rather than trusting to a click: the wrong default
 * direction and a broken tie-break both look like "the table just sorted
 * oddly" and neither announces itself.
 */

const PARTS = [
  { name: 'LED bulb — 100W white', par_level: 2, unit: 'pcs' },
  { name: 'LED bulb — 20W white', par_level: 10, unit: 'pcs' },
  { name: 'Tap washer', par_level: 40, unit: 'pcs' },
  { name: 'Hinge', par_level: 10, unit: 'set' },
];

const names = (rows) => rows.map((r) => r.name);

test('text sorts A to Z', () => {
  assert.deepEqual(names(sorted(PARTS, { key: 'name', dir: 'asc' })), [
    'Hinge',
    'LED bulb — 20W white',
    'LED bulb — 100W white',
    'Tap washer',
  ]);
});

test('numbers inside a name sort as numbers, not as text', () => {
  // Plain string comparison puts "100W" before "20W", which reads as a bug to
  // anybody looking at a shelf.
  const [, second, third] = sorted(PARTS, { key: 'name', dir: 'asc' });
  assert.equal(second.name, 'LED bulb — 20W white');
  assert.equal(third.name, 'LED bulb — 100W white');
});

test('a numeric column sorts by size', () => {
  assert.deepEqual(
    sorted(PARTS, { key: 'par_level', dir: 'desc' }).map((r) => r.par_level),
    [40, 10, 10, 2],
  );
});

test('sorting leaves the original list alone', () => {
  const before = names(PARTS);
  sorted(PARTS, { key: 'par_level', dir: 'desc' });
  assert.deepEqual(names(PARTS), before, 'the caller keeps whatever order it had');
});

test('a value function can sort by something not on the row', () => {
  // How the parts list sorts by category: by its name, never by the id number
  // nobody chose.
  const rows = [{ id: 1, category_id: 9 }, { id: 2, category_id: 3 }];
  const byCategory = { 9: 'Electrical', 3: 'Plumbing' };
  const out = sorted(rows, { key: 'category', dir: 'asc' }, {
    value: (r, k) => (k === 'category' ? byCategory[r.category_id] : r[k]),
  });
  assert.deepEqual(out.map((r) => r.id), [1, 2]);
});

test('missing values sort without throwing', () => {
  const rows = [{ name: 'Hinge' }, {}, { name: null }];
  assert.equal(sorted(rows, { key: 'name', dir: 'asc' }).length, 3);
});

// ------------------------------------------------------------- direction --

test('a new text column starts A to Z', () => {
  assert.deepEqual(nextSort({ key: 'par_level', dir: 'asc' }, 'name', { numeric: ['par_level'] }), {
    key: 'name', dir: 'asc',
  });
});

test('a new numeric column starts with the largest', () => {
  // "Sort by price" almost always means "what are the expensive ones".
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'default_unit_cost', {
    numeric: ['default_unit_cost'],
  }), { key: 'default_unit_cost', dir: 'desc' });
});

test('the column already sorted reverses instead', () => {
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'name'), { key: 'name', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'name', dir: 'desc' }, 'name'), { key: 'name', dir: 'asc' });
});
