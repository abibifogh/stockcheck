import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDataset, stockReport } from '../src/lib/analytics.js';

/**
 * Bread baked in-house, as a stock input.
 *
 * The rule this pins down is the one everything else depends on: production
 * puts stock on the shelf exactly as a delivery does, and the morning sheet
 * takes it back off. The rule it also pins down is the one that is easy to
 * break by accident — production must never be counted as money spent with a
 * supplier.
 */

const SETTINGS = [{ key: 'currency', value: 'GHS' }, { key: 'timezone', value: 'UTC' }];

const BREAD = {
  id: 1, category_id: 1, name: 'Sliced Bread', unit: 'loaf', step: 1,
  par_level: 20, default_unit_cost: 15, opening_stock: 0, is_core: 1, is_produced: 1,
  active: 1, sort_order: 1,
};
const EGGS = {
  id: 2, category_id: 1, name: 'Eggs', unit: 'pcs', step: 6,
  par_level: 0, default_unit_cost: 1.5, opening_stock: 100, is_core: 1, is_produced: 0,
  active: 1, sort_order: 2,
};

function kitchen({ production = [], usage = [], purchases = [], days = [] } = {}) {
  return makeDataset({
    settings: SETTINGS,
    categories: [{ id: 1, name: 'Bakery' }],
    ingredients: [BREAD, EGGS],
    serviceDays: days,
    usage,
    purchases,
    stockCounts: [],
    production,
  });
}

const bake = (day, qty, cycle = 'Morning', unitCost = 15) => ({
  id: Math.random(), day, cycle, ingredient_id: 1, qty, unit_cost: unitCost,
  at: `${day} 05:00:00`, produced_by: 'Adjoa', link_id: 1,
});

const day = (d) => ({ day: d, inhouse_guests: 30, outside_guests: 0, outsider_fee: 0 });

test('a bake puts bread on the shelf', () => {
  const ds = kitchen({ production: [bake('2026-08-10', 40)] });
  const row = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread');
  assert.equal(row.stock, 40);
});

test('the morning sheet draws against it', () => {
  const ds = kitchen({
    production: [bake('2026-08-10', 40)],
    days: [day('2026-08-10')],
    usage: [{ day: '2026-08-10', ingredient_id: 1, qty: 12 }],
  });

  const row = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread');
  assert.equal(row.stock, 28, '40 baked less 12 used');
});

test('several cycles in one day all count', () => {
  const ds = kitchen({
    production: [
      bake('2026-08-10', 40, 'Morning'),
      bake('2026-08-10', 25, 'Afternoon'),
      bake('2026-08-10', 18, 'Night'),
    ],
    days: [day('2026-08-10')],
    usage: [{ day: '2026-08-10', ingredient_id: 1, qty: 30 }],
  });

  const row = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread');
  assert.equal(row.stock, 53, '83 baked across three runs, 30 used');
});

test('bread that was never baked goes negative, and says so', () => {
  const ds = kitchen({
    days: [day('2026-08-10')],
    usage: [{ day: '2026-08-10', ingredient_id: 1, qty: 12 }],
  });

  const row = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread');
  assert.equal(row.stock, -12);
  assert.equal(row.status, 'negative', 'the same signal as an unrecorded delivery');
});

test('a bake is valued at what it costs to make, not at nothing', () => {
  const ds = kitchen({ production: [bake('2026-08-10', 40)] });
  const row = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread');

  assert.equal(row.unitCost, 15);
  assert.equal(row.value, 600, '40 loaves at 15 each');
});

test('production carries the cost it was recorded at, not the cost today', () => {
  // Flour got dearer: the second run cost more to make. The average follows,
  // and the first run is not restated.
  const ds = kitchen({
    production: [bake('2026-08-10', 40, 'Morning', 15), bake('2026-08-11', 40, 'Morning', 25)],
  });

  assert.equal(stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Sliced Bread').unitCost, 15);
  assert.equal(stockReport(ds, '2026-08-11').rows.find((r) => r.name === 'Sliced Bread').unitCost, 20,
    'eighty loaves, half at 15 and half at 25');
});

test('production is stock, not spend', () => {
  const ds = kitchen({
    production: [bake('2026-08-10', 40)],
    purchases: [{ day: '2026-08-10', ingredient_id: 2, qty: 100, unit_cost: 2 }],
  });

  // The purchase list is what money went to suppliers. Baking our own bread is
  // not a purchase, however much stock it puts on the shelf.
  assert.equal(ds.purchases.length, 1);
  assert.equal(ds.purchases[0].ingredient_id, 2);
  assert.equal(ds.production.length, 1);
});

test('a store with no bakery behaves exactly as it did before', () => {
  const ds = kitchen({
    purchases: [{ day: '2026-08-10', ingredient_id: 2, qty: 100, unit_cost: 2 }],
    days: [day('2026-08-10')],
    usage: [{ day: '2026-08-10', ingredient_id: 2, qty: 60 }],
  });

  const eggs = stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Eggs');
  assert.equal(eggs.stock, 140, '100 opening plus 100 bought less 60 used');
  assert.deepEqual(ds.production, []);
});

test('an installation without the bakery migration still loads', () => {
  // makeDataset is handed no production key at all, which is what the
  // tolerated-missing query produces before the migration is run.
  const ds = makeDataset({
    settings: SETTINGS,
    categories: [{ id: 1, name: 'Bakery' }],
    ingredients: [BREAD, EGGS],
    serviceDays: [day('2026-08-10')],
    usage: [{ day: '2026-08-10', ingredient_id: 2, qty: 10 }],
    purchases: [],
    stockCounts: [],
  });

  assert.deepEqual(ds.production, []);
  assert.equal(stockReport(ds, '2026-08-10').rows.find((r) => r.name === 'Eggs').stock, 90);
});

test('what was baked on a day is available without walking the list again', () => {
  const ds = kitchen({
    production: [bake('2026-08-10', 40, 'Morning'), bake('2026-08-10', 25, 'Night')],
  });

  assert.equal(ds.producedByDay.get('2026-08-10').get(1), 65);
  assert.equal(ds.producedByDay.has('2026-08-11'), false);
});
