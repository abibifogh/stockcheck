import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  byArea, byItem, compare, issueCost, makeDataset, overview, periodReport, stockReport,
} from '../src/lib/maintenance.js';

const CATEGORIES = [
  { id: 1, name: 'Electrical', sort_order: 10 },
  { id: 2, name: 'Plumbing', sort_order: 20 },
];

const ITEMS = [
  { id: 1, category_id: 1, name: 'LED Bulb 9W', unit: 'pcs', par_level: 40, opening_stock: 100, default_unit_cost: 25, is_common: 1, active: 1 },
  { id: 2, category_id: 2, name: 'Tap Washer Set', unit: 'set', par_level: 30, opening_stock: 60, default_unit_cost: 8, is_common: 1, active: 1 },
  { id: 3, category_id: 2, name: 'Basin Tap', unit: 'pcs', par_level: 8, opening_stock: 10, default_unit_cost: 180, is_common: 0, active: 1 },
];

const AREAS = [
  { id: 1, name: 'Room 101', kind: 'room', block: 'First floor', sort_order: 10, active: 1 },
  { id: 2, name: 'Room 102', kind: 'room', block: 'First floor', sort_order: 20, active: 1 },
  { id: 3, name: 'Room 103', kind: 'room', block: 'First floor', sort_order: 30, active: 1 },
  { id: 4, name: 'Room 104', kind: 'room', block: 'First floor', sort_order: 40, active: 1 },
  { id: 5, name: 'Lobby', kind: 'area', block: 'Public', sort_order: 50, active: 1 },
];

let nextId = 1;
const issue = (day, itemId, qty, areaId, extra = {}) => ({
  id: nextId++, day, at: `${day} 09:00:00`, item_id: itemId, qty, area_id: areaId,
  job_ref: null, note: null, issued_by: 'Kwame', ...extra,
});

function build(overrides = {}) {
  return makeDataset({
    categories: CATEGORIES,
    items: ITEMS,
    areas: AREAS,
    settings: [{ key: 'currency', value: 'GHS' }, { key: 'mx_low_cover_days', value: '7' }],
    issues: [],
    purchases: [],
    counts: [],
    ...overrides,
  });
}

// ------------------------------------------------------------------ costing --

test('an issue is costed at the price in force on the day it went out', () => {
  const ds = build({
    purchases: [
      { id: 1, day: '2026-06-10', item_id: 1, qty: 100, unit_cost: 35 },
    ],
    issues: [issue('2026-06-05', 1, 10, 1), issue('2026-06-15', 1, 10, 2)],
  });

  // Before the delivery: the opening stock's own price.
  assert.equal(issueCost(ds, ds.issues[0]), 250);
  // After: the 90 still on the shelf at 25 blended with 100 bought at 35
  // gives 5,750 over 190 units — 30.26 each, not the new price.
  assert.equal(issueCost(ds, ds.issues[1]), 302.63);
});

test('book stock falls as parts are issued and rises when they are bought', () => {
  const ds = build({
    purchases: [{ id: 1, day: '2026-06-10', item_id: 2, qty: 50, unit_cost: 9 }],
    issues: [issue('2026-06-05', 2, 20, 1), issue('2026-06-20', 2, 30, 2)],
  });
  // 60 opening − 20 + 50 − 30
  assert.equal(ds.ledger.stockOn(2, '2026-06-30'), 60);
  assert.equal(ds.ledger.stockOn(2, '2026-06-06'), 40);
});

test('negative stock is kept, not hidden, because it means a purchase was missed', () => {
  const ds = build({ issues: [issue('2026-06-05', 3, 25, 1)] });
  const report = stockReport(ds, '2026-06-30');
  const tap = report.rows.find((r) => r.itemId === 3);
  assert.equal(tap.stock, -15);
  assert.equal(tap.status, 'negative');
});

// -------------------------------------------------------------------- areas --

test('spend is grouped by room, ranked, and the worst room is named', () => {
  const issues = [
    // Room 101 is a problem: bulbs going in every week.
    issue('2026-06-01', 1, 6, 1), issue('2026-06-08', 1, 6, 1),
    issue('2026-06-15', 1, 6, 1), issue('2026-06-22', 1, 6, 1),
    // The others are ordinary.
    issue('2026-06-03', 1, 1, 2), issue('2026-06-05', 2, 1, 3),
    issue('2026-06-09', 1, 1, 4), issue('2026-06-11', 2, 1, 5),
  ];
  const ds = build({ issues });
  const result = byArea(ds, '2026-06-01', '2026-06-30');

  assert.equal(result.rows[0].name, 'Room 101');
  assert.equal(result.rows[0].cost, 600); // 24 bulbs × 25
  assert.equal(result.rows[0].issues, 4);
  assert.equal(result.rows[0].visits, 4);
  assert.equal(result.rows[0].topItems[0].name, 'LED Bulb 9W');
  assert.equal(result.rows[0].heavy, true);
  assert.equal(result.heavy.length, 1);

  // An ordinary room is not flagged.
  assert.equal(result.rows.find((r) => r.name === 'Room 102').heavy, false);
});

test('rooms that all cost about the same produce no complaints', () => {
  const issues = AREAS.map((a, i) => issue(`2026-06-0${i + 1}`, 1, 2, a.id));
  const ds = build({ issues });
  const result = byArea(ds, '2026-06-01', '2026-06-30');
  assert.equal(result.heavy.length, 0);
});

test('parts issued without a place are reported rather than dropped', () => {
  const ds = build({ issues: [issue('2026-06-01', 1, 4, null)] });
  const result = byArea(ds, '2026-06-01', '2026-06-30');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, 'Not recorded');
  assert.equal(result.rows[0].cost, 100);
});

// -------------------------------------------------------------------- items --

test('items are ranked by money, with how many places they went', () => {
  const ds = build({
    issues: [
      issue('2026-06-01', 1, 4, 1), issue('2026-06-02', 1, 4, 2),
      issue('2026-06-03', 2, 10, 1),
    ],
  });
  const result = byItem(ds, '2026-06-01', '2026-06-30');

  assert.equal(result.rows[0].name, 'LED Bulb 9W');
  assert.equal(result.rows[0].cost, 200);
  assert.equal(result.rows[0].areas, 2);
  assert.equal(result.rows[1].name, 'Tap Washer Set');
  assert.equal(result.rows[1].cost, 80);
  assert.equal(result.categories[0].name, 'Electrical');
  assert.equal(result.total, 280);
});

// -------------------------------------------------------------------- stock --

test('the restock list says what to order and what it will cost', () => {
  const ds = build({ issues: [issue('2026-06-01', 1, 70, 1)] });
  const report = stockReport(ds, '2026-06-30');
  const bulb = report.rows.find((r) => r.itemId === 1);

  assert.equal(bulb.stock, 30);          // 100 − 70
  assert.equal(bulb.status, 'below_par'); // par is 40
  assert.equal(bulb.suggestedOrder, 10);
  assert.equal(bulb.suggestedOrderValue, 250);
  assert.ok(report.reorder.some((r) => r.itemId === 1));
  assert.equal(report.reorderValue > 0, true);
});

test('stock sitting untouched for three months is reported as idle money', () => {
  const ds = build({ issues: [issue('2026-06-01', 1, 5, 1)] });
  const report = stockReport(ds, '2026-06-30');

  // The bulbs moved; the taps and washers did not.
  assert.equal(report.idle.some((r) => r.itemId === 1), false);
  assert.equal(report.idle.some((r) => r.itemId === 3), true);
  assert.equal(report.idle[0].value >= 0, true);
});

test('a count awaiting approval is reported as a difference but moves nothing', () => {
  const ds = build({
    issues: [issue('2026-06-01', 1, 10, 1)],
    counts: [{ id: 1, day: '2026-06-02', item_id: 1, counted_qty: 85, status: 'pending' }],
  });
  const report = stockReport(ds, '2026-06-30');
  const bulb = report.rows.find((r) => r.itemId === 1);

  // The book is untouched: 100 opening less 10 issued.
  assert.equal(bulb.stock, 90);
  assert.equal(bulb.pendingCountQty, 85);
  assert.equal(bulb.countVariance, -5); // book says 90, shelf holds 85
  assert.equal(bulb.countVarianceValue, -125);
  assert.equal(report.shrinkage[0].itemId, 1);
});

test('an approved count becomes the stock figure, and the gap closes', () => {
  const ds = build({
    issues: [issue('2026-06-01', 1, 10, 1)],
    counts: [{ id: 1, day: '2026-06-02', item_id: 1, counted_qty: 85, status: 'approved' }],
  });
  const report = stockReport(ds, '2026-06-30');
  const bulb = report.rows.find((r) => r.itemId === 1);

  assert.equal(bulb.stock, 85);          // the shelf won
  assert.equal(bulb.lastCountDay, '2026-06-02');
  assert.equal(bulb.pendingCountQty, null);
  assert.equal(bulb.countVariance, null); // nothing outstanding
  assert.equal(report.shrinkage.length, 0);
});

test('a rejected count changes nothing and stops being chased', () => {
  const ds = build({
    issues: [issue('2026-06-01', 1, 10, 1)],
    counts: [{ id: 1, day: '2026-06-02', item_id: 1, counted_qty: 85, status: 'rejected' }],
  });
  const report = stockReport(ds, '2026-06-30');
  const bulb = report.rows.find((r) => r.itemId === 1);

  assert.equal(bulb.stock, 90);
  assert.equal(bulb.pendingCountQty, null);
  assert.equal(bulb.countVariance, null);
  assert.equal(report.shrinkage.length, 0);
});

test('a count with no status at all is treated as still waiting', () => {
  // Rows written before the approval step existed must surface for a decision
  // rather than silently moving stock or silently vanishing.
  const ds = build({
    issues: [issue('2026-06-01', 1, 10, 1)],
    counts: [{ id: 1, day: '2026-06-02', item_id: 1, counted_qty: 85 }],
  });
  const report = stockReport(ds, '2026-06-30');
  const bulb = report.rows.find((r) => r.itemId === 1);

  assert.equal(bulb.stock, 90);           // book untouched
  assert.equal(bulb.pendingCountQty, 85); // and visible
  assert.equal(bulb.countVariance, -5);
});

// ------------------------------------------------------------------- period --

test('a period is measured against the period immediately before it', () => {
  const ds = build({
    issues: [
      issue('2026-05-05', 1, 4, 1),   // previous month
      issue('2026-06-05', 1, 8, 1),   // this month, double
      issue('2026-06-06', 2, 5, 2),
    ],
  });
  const report = periodReport(ds, '2026-06-01', '2026-06-30');

  assert.equal(report.current.cost, 240);   // 8×25 + 5×8
  assert.equal(report.previous.cost, 100);  // 4×25
  assert.equal(report.previous.from, '2026-05-02');
  assert.equal(report.previous.to, '2026-05-31');
  assert.equal(report.deltas.cost, 140);
  assert.equal(report.risers[0].name, 'LED Bulb 9W');
  assert.equal(report.risers[0].deltaCost, 100);
});

test('repeatedly patching the same thing in the same place is flagged', () => {
  const ds = build({
    issues: [
      issue('2026-06-01', 3, 1, 2), issue('2026-06-09', 3, 1, 2), issue('2026-06-17', 3, 1, 2),
    ],
  });
  const report = periodReport(ds, '2026-06-01', '2026-06-30');
  const repeat = report.alerts.find((a) => a.kind === 'repeat');

  assert.ok(repeat, 'expected a repeat-failure alert');
  assert.match(repeat.title, /Basin Tap/);
  assert.match(repeat.title, /Room 102/);
});

test('one visit to a room raises nothing', () => {
  const ds = build({ issues: [issue('2026-06-01', 3, 1, 2)] });
  const report = periodReport(ds, '2026-06-01', '2026-06-30');
  assert.equal(report.alerts.filter((a) => a.kind === 'repeat').length, 0);
});

test('buying more than you issue is reported as money moving onto the shelf', () => {
  const ds = build({
    purchases: [{ id: 1, day: '2026-06-10', item_id: 1, qty: 100, unit_cost: 25 }],
    issues: [issue('2026-06-11', 1, 10, 1)],
  });
  const report = periodReport(ds, '2026-06-01', '2026-06-30');
  assert.equal(report.inventory.purchaseValue, 2500);
  assert.equal(report.inventory.issuedValue, 250);
  assert.equal(report.inventory.movement, 2250);
});

// ------------------------------------------------------------------ compare --

test('two periods are compared, and different lengths are called out', () => {
  const ds = build({
    issues: [
      issue('2026-05-05', 1, 4, 1),
      issue('2026-06-05', 1, 8, 1), issue('2026-06-06', 2, 5, 2),
    ],
  });

  const equal = compare(ds,
    { from: '2026-06-01', to: '2026-06-30' },
    { from: '2026-05-01', to: '2026-05-30' });
  assert.equal(equal.comparable.sameLength, true);
  assert.equal(equal.comparable.note, null);
  assert.equal(equal.a.cost, 240);
  assert.equal(equal.b.cost, 100);

  const uneven = compare(ds,
    { from: '2026-06-01', to: '2026-06-30' },
    { from: '2026-05-01', to: '2026-05-07' });
  assert.equal(uneven.comparable.sameLength, false);
  assert.match(uneven.comparable.note, /different lengths \(30 days against 7\)/);
  assert.equal(uneven.series.a.length, 30);
  assert.equal(uneven.series.b.length, 7);
});

test('a room that appears in only one of the two periods still shows up', () => {
  const ds = build({
    issues: [issue('2026-06-05', 1, 4, 1), issue('2026-05-05', 1, 4, 3)],
  });
  const result = compare(ds,
    { from: '2026-06-01', to: '2026-06-30' },
    { from: '2026-05-01', to: '2026-05-30' });

  const names = result.areas.map((a) => a.name);
  assert.ok(names.includes('Room 101'));
  assert.ok(names.includes('Room 103'));
  assert.equal(result.areas.find((a) => a.name === 'Room 103').aCost, 0);
});

// ----------------------------------------------------------------- overview --

test('the overview leads with the month, the shelf and what needs deciding', () => {
  const ds = build({
    issues: [
      issue('2026-06-02', 1, 70, 1),
      issue('2026-06-03', 2, 4, 5),
    ],
  });
  const view = overview(ds, '2026-06-15');

  assert.equal(view.headline.monthIssues, 2);
  assert.equal(view.headline.monthCost, 1782); // 70×25 + 4×8
  assert.equal(view.headline.monthAreas, 2);
  assert.ok(view.headline.stockValue > 0);
  assert.ok(view.headline.reorderCount >= 1);
  assert.equal(view.recent[0].item, 'Tap Washer Set');
  assert.equal(view.recent[0].area, 'Lobby');
  assert.equal(view.series.length, 30);
  assert.ok(view.alerts.some((a) => a.kind === 'stock'));
});

test('an empty store reports nothing rather than dividing by zero', () => {
  const ds = build();
  const view = overview(ds, '2026-06-15');
  assert.equal(view.headline.monthCost, 0);
  assert.equal(view.headline.monthIssues, 0);
  assert.equal(view.recent.length, 0);

  const report = periodReport(ds, '2026-06-01', '2026-06-30');
  assert.equal(report.current.costPerArea, null);
  assert.equal(report.current.costPerDay, null);
  assert.equal(report.deltas.cost, null);
});

// ------------------------------------------------------------- part details --

test('part details are cleaned up rather than stored as typed', async () => {
  const { readAttributes } = await import('../src/routes/maintenance.js');

  assert.equal(readAttributes({ Size: '9W', Colour: 'Warm white' }),
    '{"Size":"9W","Colour":"Warm white"}');

  // Whitespace is not a value, and a row with only half of it filled in is
  // somebody who started typing and thought better of it — not an error.
  assert.equal(readAttributes({ Size: ' 9W ', Colour: '  ', '': 'orphan' }), '{"Size":"9W"}');

  // Nothing at all is stored as nothing, not as an empty object.
  assert.equal(readAttributes({}), null);
  assert.equal(readAttributes(null), null);
  assert.equal(readAttributes(''), null);
  assert.equal(readAttributes({ Colour: '' }), null);

  // A JSON string is accepted, since that is how it comes back out of the row.
  assert.equal(readAttributes('{"Size":"9W"}'), '{"Size":"9W"}');
});

test('part details that would abuse the column are refused', async () => {
  const { readAttributes } = await import('../src/routes/maintenance.js');

  const tooMany = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`K${i}`, 'v']));
  assert.throws(() => readAttributes(tooMany), /up to 12 details/);
  assert.throws(() => readAttributes({ ['x'.repeat(45)]: 'v' }), /too long for a label/);
  assert.throws(() => readAttributes({ Size: 'y'.repeat(90) }), /value for .* is too long/);
  assert.throws(() => readAttributes(['a', 'b']), /could not be read/);
  assert.throws(() => readAttributes('not json at all'), /could not be read/);
});

test('exactly twelve details is allowed; thirteen is not', async () => {
  const { readAttributes } = await import('../src/routes/maintenance.js');
  const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`K${i}`, 'v']));
  assert.equal(Object.keys(JSON.parse(readAttributes(twelve))).length, 12);
  assert.throws(() => readAttributes({ ...twelve, K12: 'v' }), /up to 12 details/);
});

// -------------------------------------------------------------- bulk upload --

test('spreadsheet headings are matched however they were typed', async () => {
  const { columnKey } = await import('../src/routes/maintenance.js');

  // The template's own wording.
  assert.equal(columnKey('Name'), 'name');
  assert.equal(columnKey('Restock level'), 'parLevel');
  assert.equal(columnKey('On shelf now'), 'openingStock');
  assert.equal(columnKey('Price each'), 'defaultUnitCost');
  assert.equal(columnKey('Everyday part'), 'isCommon');

  // What somebody typing their own sheet would plausibly write instead.
  assert.equal(columnKey('part'), 'name');
  assert.equal(columnKey('ITEM NAME'), 'name');
  assert.equal(columnKey('Unit (kg)'), 'unit');
  assert.equal(columnKey('re-order level'), 'parLevel');
  assert.equal(columnKey('  Qty  '), 'openingStock');
  assert.equal(columnKey('Unit Cost'), 'defaultUnitCost');

  // Anything unrecognised is a detail column, which is the whole mechanism.
  assert.equal(columnKey('Size'), null);
  assert.equal(columnKey('Colour'), null);
  assert.equal(columnKey('Fitting'), null);
  assert.equal(columnKey(''), null);
  assert.equal(columnKey(undefined), null);
});

test('a column called Size is never mistaken for a real field', async () => {
  const { columnKey } = await import('../src/routes/maintenance.js');
  // Guards against an alias list that grows until it swallows a detail name.
  for (const label of ['Size', 'Colour', 'Color', 'Material', 'Finish', 'Rating', 'Model', 'Voltage']) {
    assert.equal(columnKey(label), null, `${label} must stay a detail column`);
  }
});

test('the everyday-part column accepts the ways people write yes', async () => {
  const { yesish } = await import('../src/routes/maintenance.js');
  for (const yes of ['yes', 'Yes', 'YES', 'y', '1', 'true', 'x', ' everyday ']) {
    assert.equal(yesish(yes), true, `${JSON.stringify(yes)} should mean yes`);
  }
  for (const no of ['', 'no', 'n', '0', 'false', undefined, null, 'maybe']) {
    assert.equal(yesish(no), false, `${JSON.stringify(no)} should not mean yes`);
  }
});

// ----------------------------------------------------------- bulk removal --

test('a selection sent from the browser is cleaned before it touches anything', async () => {
  const { readIds } = await import('../src/routes/maintenance.js');

  assert.deepEqual(readIds([3, 1, 2]), [3, 1, 2]);
  // Checkbox values arrive as strings, and a row ticked twice is still one row.
  assert.deepEqual(readIds(['4', 4, '5']), [4, 5]);

  // Anything that is not a real row id is dropped rather than passed to SQL.
  assert.deepEqual(readIds([1, 'x', null, -2, 0, 1.5, NaN]), [1]);
});

test('an empty or impossible selection is refused rather than guessed at', async () => {
  const { readIds } = await import('../src/routes/maintenance.js');

  for (const bad of [[], ['x'], [0], [-1], null, undefined, 'all', 42, {}]) {
    assert.throws(() => readIds(bad), /Nothing was selected/, `${JSON.stringify(bad)} should be refused`);
  }

  assert.throws(() => readIds(Array.from({ length: 501 }, (_, i) => i + 1)), /more than 500/);
  // Exactly at the limit is fine.
  assert.equal(readIds(Array.from({ length: 500 }, (_, i) => i + 1)).length, 500);
});
