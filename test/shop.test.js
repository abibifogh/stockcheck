import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  byCategory, byItem, compare, makeDataset, periodReport, stockReport, totals,
} from '../src/lib/shop.js';

/**
 * The craft shop's arithmetic.
 *
 * The rules worth pinning down are the ones a shop loses money to quietly: a
 * voided sale that still counts, a price change that rewrites last month, and
 * a margin figure that flatters because the cost was never subtracted.
 */

const SETTINGS = [
  { key: 'currency', value: 'GHS' },
  { key: 'shop_low_cover_days', value: '21' },
];

/** Two products, bought at a known cost, sold at a known price. */
function shop({ sales = [], lines = [], purchases = [], counts = [], items = null } = {}) {
  return makeDataset({
    settings: SETTINGS,
    categories: [{ id: 1, name: 'Textiles' }, { id: 2, name: 'Carvings' }],
    items: items ?? [
      {
        id: 1, name: 'Kente stole', category_id: 1, unit: 'pcs',
        sell_price: 400, default_unit_cost: 160, opening_stock: 10, par_level: 4, active: 1,
      },
      {
        id: 2, name: 'Carved mask', category_id: 2, unit: 'pcs',
        sell_price: 250, default_unit_cost: 100, opening_stock: 6, par_level: 2, active: 1,
      },
    ],
    sales,
    lines,
    purchases,
    counts,
  });
}

/** One sale, with its lines, in the shape loadDataset hands over. */
function sale({ id, day, method = 'cash', voided = 0, lines }) {
  const total = lines.reduce((n, l) => n + l.qty * l.unitPrice, 0);
  return {
    header: {
      id, day, at: `${day} 11:00:00`, payment_method: method, total,
      tendered: null, change_due: null, sold_by: 'Akua', voided,
    },
    lines: lines.map((l, i) => ({
      id: id * 100 + i,
      sale_id: id,
      item_id: l.itemId,
      qty: l.qty,
      unit_price: l.unitPrice,
      line_total: l.qty * l.unitPrice,
      day,
      voided,
      payment_method: method,
    })),
  };
}

function build(saleSpecs, extra = {}) {
  const built = saleSpecs.map(sale);
  return shop({
    sales: built.map((s) => s.header),
    lines: built.flatMap((s) => s.lines),
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

test('margin is what came in less what the stock had cost', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
  ]);
  const t = totals(ds, ds.lines, ds.sales);

  assert.equal(t.revenue, 400);
  assert.equal(t.cost, 160);
  assert.equal(t.margin, 240);
  assert.equal(t.marginPct, 60);
});

test('a shop that sells nothing has no margin percentage rather than zero', () => {
  const ds = build([]);
  const t = totals(ds, ds.lines, ds.sales);
  assert.equal(t.revenue, 0);
  assert.equal(t.marginPct, null, 'zero divided by zero is not 0%');
  assert.equal(t.averageSale, 0);
});

test('cash and card are counted apart, because only one of them can be short', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', method: 'cash', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
    { id: 2, day: '2026-08-01', method: 'card', lines: [{ itemId: 2, qty: 1, unitPrice: 250 }] },
  ]);
  const t = totals(ds, ds.lines, ds.sales);

  assert.equal(t.cash, 400);
  assert.equal(t.card, 250);
  assert.equal(t.cash + t.card, t.revenue);
});

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

test('a voided sale took no money and took nothing off the shelf', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 2, unitPrice: 400 }] },
    { id: 2, day: '2026-08-01', voided: 1, lines: [{ itemId: 1, qty: 3, unitPrice: 400 }] },
  ]);

  const t = totals(ds, ds.lines, ds.sales);
  assert.equal(t.revenue, 800, 'only the sale that stood counts');
  assert.equal(t.saleCount, 1);

  // Opening 10, two sold, three voided: the three are still there.
  assert.equal(stockReport(ds, '2026-08-01').rows.find((r) => r.itemId === 1).stock, 8);
});

test('voiding the only sale of the day leaves a day with no takings, not a negative one', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', voided: 1, lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
  ]);
  const t = totals(ds, ds.lines, ds.sales);
  assert.equal(t.revenue, 0);
  assert.equal(t.margin, 0);
  assert.equal(stockReport(ds, '2026-08-01').rows.find((r) => r.itemId === 1).stock, 10);
});

// ---------------------------------------------------------------------------
// Prices are facts about the day they happened
// ---------------------------------------------------------------------------

test('a price rise does not rewrite what earlier sales were rung up at', () => {
  // Sold at 400 in July. The product now lists at 550.
  const ds = shop({
    items: [{
      id: 1, name: 'Kente stole', category_id: 1, unit: 'pcs',
      sell_price: 550, default_unit_cost: 160, opening_stock: 10, par_level: 4, active: 1,
    }],
    sales: [sale({ id: 1, day: '2026-07-04', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] }).header],
    lines: sale({ id: 1, day: '2026-07-04', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] }).lines,
  });

  assert.equal(totals(ds, ds.lines, ds.sales).revenue, 400, 'July took 400, not 550');
});

test('cost follows the ledger, so a later delivery does not restate an earlier sale', () => {
  // Bought 10 at 160 (opening). Sold one. Then bought 10 more at 300.
  const ds = build(
    [{ id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] }],
    { purchases: [{ day: '2026-08-05', item_id: 1, qty: 10, unit_cost: 300 }] },
  );

  const t = totals(ds, ds.lines, ds.sales);
  assert.equal(t.cost, 160, 'the piece sold on the 1st cost what it cost on the 1st');
  assert.equal(t.margin, 240);
});

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

test('the shelf is worth two different numbers, and both are wanted', () => {
  const ds = build([]);
  const stock = stockReport(ds, '2026-08-01');

  // 10 × 160 + 6 × 100 at cost; 10 × 400 + 6 × 250 at what it would fetch.
  assert.equal(stock.totalValue, 2200);
  assert.equal(stock.totalRetailValue, 5500);
});

test('a product priced below what it cost is found before it sells', () => {
  const ds = shop({
    items: [{
      id: 1, name: 'Mispriced mask', category_id: 2, unit: 'pcs',
      sell_price: 40, default_unit_cost: 90, opening_stock: 3, par_level: 0, active: 1,
    }],
  });

  const stock = stockReport(ds, '2026-08-01');
  assert.deepEqual(stock.underpriced.map((r) => r.name), ['Mispriced mask']);
  assert.equal(stock.rows[0].marginPct, -125);
});

test('stock that has not moved in three months is money sitting still', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
  ]);
  const stock = stockReport(ds, '2026-08-01');

  // The mask sold nothing and is still on the shelf; the stole moved.
  assert.deepEqual(stock.idle.map((r) => r.name), ['Carved mask']);
});

test('only an approved count moves the book', () => {
  const pending = build([], {
    counts: [{ day: '2026-08-02', item_id: 1, counted_qty: 7, status: 'pending' }],
  });
  const approved = build([], {
    counts: [{ day: '2026-08-02', item_id: 1, counted_qty: 7, status: 'approved' }],
  });

  const waiting = stockReport(pending, '2026-08-03').rows.find((r) => r.itemId === 1);
  assert.equal(waiting.stock, 10, 'the shelf still reads what the book says');
  assert.equal(waiting.pendingCountQty, 7);
  assert.equal(waiting.countVariance, -3, 'the difference is reported, not applied');

  const settled = stockReport(approved, '2026-08-03').rows.find((r) => r.itemId === 1);
  assert.equal(settled.stock, 7, 'accepted, so the count is now the truth');
  assert.equal(settled.countVariance, null);
});

// ---------------------------------------------------------------------------
// Grouping and comparison
// ---------------------------------------------------------------------------

test('products are ranked by what they brought in, not by how many went out', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', lines: [{ itemId: 2, qty: 3, unitPrice: 250 }] },  // 750
    { id: 2, day: '2026-08-01', lines: [{ itemId: 1, qty: 2, unitPrice: 400 }] },  // 800
  ]);

  const rows = byItem(ds, '2026-08-01', '2026-08-01');
  assert.deepEqual(rows.map((r) => r.name), ['Kente stole', 'Carved mask']);
  assert.equal(rows[0].revenue, 800);
  assert.equal(rows[1].qty, 3);
});

test('category shares add up to the whole', () => {
  const ds = build([
    { id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
    { id: 2, day: '2026-08-01', lines: [{ itemId: 2, qty: 1, unitPrice: 100 }] },
  ]);

  const rows = byCategory(ds, '2026-08-01', '2026-08-01');
  assert.equal(rows.reduce((n, r) => n + r.shareOfRevenue, 0), 100);
  assert.equal(rows[0].name, 'Textiles');
  assert.equal(rows[0].shareOfRevenue, 80);
});

test('a period is compared against the one immediately before it', () => {
  const ds = build([
    { id: 1, day: '2026-07-31', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
    { id: 2, day: '2026-08-01', lines: [{ itemId: 1, qty: 2, unitPrice: 400 }] },
  ]);

  const report = periodReport(ds, '2026-08-01', '2026-08-01');
  assert.equal(report.current.revenue, 800);
  assert.equal(report.previous.revenue, 400, 'the day before');
  assert.equal(report.previousRange.from, '2026-07-31');
  assert.equal(report.change.revenue.changePct, 100);
});

test('two arbitrary windows can be set against each other', () => {
  const ds = build([
    { id: 1, day: '2026-06-10', lines: [{ itemId: 1, qty: 1, unitPrice: 400 }] },
    { id: 2, day: '2026-08-10', lines: [{ itemId: 1, qty: 3, unitPrice: 400 }] },
  ]);

  const result = compare(ds,
    { from: '2026-06-01', to: '2026-06-30' },
    { from: '2026-08-01', to: '2026-08-31' });

  assert.equal(result.a.revenue, 400);
  assert.equal(result.b.revenue, 1200);
  assert.equal(result.change.revenue.change, 800);
  assert.equal(result.items[0].name, 'Kente stole');
  assert.equal(result.items[0].change, 800);
});

// ---------------------------------------------------------------------------
// What the report says out loud
// ---------------------------------------------------------------------------

test('selling below cost is called out, once, by name', () => {
  const ds = shop({
    items: [{
      id: 1, name: 'Carved mask', category_id: 2, unit: 'pcs',
      sell_price: 80, default_unit_cost: 100, opening_stock: 5, par_level: 0, active: 1,
    }],
    ...(() => {
      const s = sale({ id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 1, unitPrice: 80 }] });
      return { sales: [s.header], lines: s.lines };
    })(),
  });

  const report = periodReport(ds, '2026-08-01', '2026-08-01');
  const titles = report.alerts.map((a) => a.title);

  assert.ok(titles.some((t) => /sold below cost/.test(t)), titles.join(' | '));
  assert.ok(titles.some((t) => /priced below cost/.test(t)), titles.join(' | '));
});

test('a restock alert never claims it will cost nothing to fix', () => {
  // Below its level: there is a real amount to spend.
  const short = shop({
    items: [{
      id: 1, name: 'Kente stole', category_id: 1, unit: 'pcs',
      sell_price: 400, default_unit_cost: 160, opening_stock: 1, par_level: 10, active: 1,
    }],
  });
  const alerts = periodReport(short, '2026-08-01', '2026-08-01').alerts;
  const restock = alerts.find((a) => /below the level/.test(a.title));
  assert.ok(restock, alerts.map((a) => a.title).join(' | '));
  assert.ok(!/ 0 /.test(restock.detail), `"${restock.detail}" should name a real amount`);

  // Selling faster than the shelf covers is a different sentence, with no
  // money in it — with no level set there is nothing to top up to, so quoting
  // a figure would mean quoting zero.
  const noLevel = (() => {
    const s = sale({ id: 1, day: '2026-08-01', lines: [{ itemId: 1, qty: 9, unitPrice: 400 }] });
    return shop({
      items: [{
        id: 1, name: 'Kente stole', category_id: 1, unit: 'pcs',
        sell_price: 400, default_unit_cost: 160, opening_stock: 10, par_level: 0, active: 1,
      }],
      sales: [s.header],
      lines: s.lines,
    });
  })();

  const fastAlerts = periodReport(noLevel, '2026-08-01', '2026-08-01').alerts;
  const cover = fastAlerts.find((a) => /faster than the shelf/.test(a.title));
  assert.ok(cover, fastAlerts.map((a) => a.title).join(' | '));
  assert.ok(!/GHS/.test(cover.detail), `"${cover.detail}" should not quote an amount`);
  assert.ok(!fastAlerts.some((a) => /below the level/.test(a.title)),
    'nothing is below a level that was never set');
});
