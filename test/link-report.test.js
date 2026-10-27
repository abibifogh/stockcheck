import { test } from 'node:test';
import assert from 'node:assert/strict';

import { report } from '../src/routes/link.js';
import { signLink, verifyLink } from '../src/lib/link.js';

/**
 * The management report Insight asks for: only when Insight signed it, and
 * then this app's own week or month, the stock, deliveries by supplier, the
 * bakery and the days nobody recorded. Made-up items, suppliers and figures.
 */

const SECRET = 'shared-with-insight';
const TABLES = {
  categories: [{ id: 1, name: 'Dairy', sort_order: 0 }, { id: 2, name: 'Bakery', sort_order: 1 }],
  ingredients: [
    { id: 1, category_id: 1, name: 'Butter', unit: 'kg', par_level: 3, default_unit_cost: 90, opening_stock: 5, is_core: 1, active: 1 },
    { id: 2, category_id: 2, name: 'Bread', unit: 'loaf', par_level: 0, default_unit_cost: 15, opening_stock: 0, is_core: 1, active: 1 },
  ],
  service_days: [
    { day: '2026-10-19', inhouse_guests: 30, outside_guests: 2, outsider_fee: 50, submitted_at: '2026-10-19 09:00' },
    { day: '2026-10-20', inhouse_guests: 28, outside_guests: 0, outsider_fee: 50, submitted_at: '2026-10-20 09:00' },
  ],
  usage: [{ day: '2026-10-19', ingredient_id: 1, qty: 1 }, { day: '2026-10-20', ingredient_id: 1, qty: 1.5 }, { day: '2026-10-19', ingredient_id: 2, qty: 6 }],
  purchases: [
    { id: 1, day: '2026-10-19', ingredient_id: 1, qty: 2, unit_cost: 100, supplier: 'A Dairy' },
    { id: 2, day: '2026-10-21', ingredient_id: 1, qty: 1, unit_cost: 100, supplier: '' },
    { id: 3, day: '2026-10-12', ingredient_id: 1, qty: 9, unit_cost: 80, supplier: 'Last week’s' },
  ],
  settings: [{ key: 'timezone', value: 'UTC' }],
  stock_counts: [],
  production: [{ id: 1, day: '2026-10-20', ingredient_id: 2, qty: 12, unit_cost: 5, destination: 'breakfast' }],
};
const db = {
  prepare: (sql) => ({
    bind() { return this; },
    async all() {
      const t = Object.keys(TABLES).find((name) => new RegExp(`FROM ${name}\\b`).test(sql));
      return { results: t ? TABLES[t] : [] };
    },
  }),
};

async function ask(body, { secret = SECRET, tamper = false } = {}) {
  const text = JSON.stringify(body);
  const headers = await signLink(secret, '/api/link/report', text);
  const request = new Request('https://breakfast.example.test/api/link/report', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: tamper ? `${text} ` : text });
  return report({ request, env: { INSIGHT_SSO_SECRET: SECRET }, db });
}

test('only a request Insight signed, recently and unaltered', async () => {
  await assert.rejects(ask({ period: 'week', week: '2026-10-21' }, { secret: 'somebody else' }), (e) => e.status === 401);
  await assert.rejects(ask({ period: 'week', week: '2026-10-21' }, { tamper: true }), (e) => e.status === 401);
  const old = await signLink(SECRET, '/api/link/report', '{}', Date.now() - 10 * 60 * 1000);
  assert.equal(await verifyLink(SECRET, { at: old['X-Till-At'], sig: old['X-Till-Sig'], path: '/api/link/report', bodyText: '{}' }), false);
  await assert.rejects(ask({ period: 'week', week: 'soon' }), (e) => e.status === 400);
});

test('a week: the app’s own week report, stock, deliveries by supplier, the bakery, days not recorded', async () => {
  const out = await (await ask({ period: 'week', week: '2026-10-21' })).json();
  assert.deepEqual([out.period, out.from, out.to], ['week', '2026-10-19', '2026-10-25']);
  assert.equal(out.insights.weekStart, '2026-10-19');
  assert.equal(out.insights.current.guests, 60);
  assert.deepEqual(out.suppliers, [{ name: 'A Dairy', value: 200 }, { name: 'No supplier named', value: 100 }], 'only this week’s deliveries');
  assert.deepEqual(out.bakery, { runs: 1, qty: 12, value: 60 });
  assert.ok(out.missingDays.includes('2026-10-21'), 'Wednesday had no breakfast recorded');
  assert.ok(!out.missingDays.includes('2026-10-19'));
  assert.ok(Array.isArray(out.stock.reorder));
});

test('a month: the app’s own month report', async () => {
  const out = await (await ask({ period: 'month', month: '2026-10' })).json();
  assert.deepEqual([out.period, out.from, out.to], ['month', '2026-10-01', '2026-10-31']);
  assert.equal(out.insights.month, '2026-10');
  assert.ok(out.suppliers.some((s) => s.name === 'Last week’s'));
});
