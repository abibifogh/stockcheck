import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inCategory } from '../public/js/views/components.js';

/**
 * Filtering a stock list by category.
 *
 * The screens above this are DOM, but the rule that decides which rows survive
 * a chip press is not, and it is the part that would quietly lose an item.
 */

const ROWS = [
  { name: 'Eggs', categoryName: 'Dairy & eggs', value: 40 },
  { name: 'Milk', categoryName: 'Dairy & eggs', value: 25 },
  { name: 'Bleach', categoryName: 'Cleaning', value: 12 },
  { name: 'Odd thing', categoryName: null, value: 3 },
];

test('no selection means everything, not nothing', () => {
  assert.equal(inCategory(ROWS, null).length, 4);
  assert.equal(inCategory(ROWS, undefined).length, 4);
  assert.equal(inCategory(ROWS, '').length, 4);
});

test('a selection keeps only that category', () => {
  assert.deepEqual(inCategory(ROWS, 'Dairy & eggs').map((r) => r.name), ['Eggs', 'Milk']);
  assert.deepEqual(inCategory(ROWS, 'Cleaning').map((r) => r.name), ['Bleach']);
});

test('an item with no category is reachable rather than lost', () => {
  // It is shown as "Uncategorised", and pressing that chip has to find it —
  // otherwise the only way to see it is to clear the filter, and an item you
  // cannot filter to is an item nobody reviews.
  assert.deepEqual(inCategory(ROWS, 'Uncategorised').map((r) => r.name), ['Odd thing']);
});

test('a category nobody is in gives an empty list, not the whole store', () => {
  assert.deepEqual(inCategory(ROWS, 'Bakery'), []);
});

test('the order the rows arrived in is kept', () => {
  // The server sorts stock worst-first; filtering must not quietly re-sort it.
  const rows = [
    { name: 'Negative', categoryName: 'Cleaning' },
    { name: 'Below par', categoryName: 'Cleaning' },
    { name: 'Fine', categoryName: 'Cleaning' },
  ];
  assert.deepEqual(inCategory(rows, 'Cleaning').map((r) => r.name),
    ['Negative', 'Below par', 'Fine']);
});

test('nothing at all does not throw', () => {
  assert.deepEqual(inCategory(undefined, null), []);
  assert.deepEqual(inCategory(null, 'Cleaning'), []);
});
