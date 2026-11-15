import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getDay, recordsOnly } from '../src/routes/day.js';

/**
 * Who the morning sheet treats as the person recording it.
 *
 * Two rules hang on it: a submitted day opens blank for them, so a correction
 * is counted again rather than nudged; and "cooks see everyday items only"
 * applies to them. A cook also asks the storeroom for things, and that second
 * permission once quietly turned both rules off.
 */

const COOK = ['entry', 'store_request'];
const MANAGER = ['entry', 'reports', 'stock', 'purchases', 'approvals', 'bakery', 'store_request', 'store_approve'];

test('a cook who also asks the storeroom still records rather than reviews', () => {
  assert.equal(recordsOnly(['entry']), true);
  assert.equal(recordsOnly(COOK), true);
  assert.equal(recordsOnly(MANAGER), false, 'can see reports, so reviewing');
  assert.equal(recordsOnly(['store_issue']), false, 'no sheet at all');
  assert.equal(recordsOnly([]), false);
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  sqlite.exec(`
    INSERT OR REPLACE INTO settings (key, value) VALUES ('restrict_cooks_to_everyday', '1');
    INSERT INTO categories (id, name) VALUES (90, 'Larder');
    INSERT INTO ingredients (id, category_id, name, unit, is_core) VALUES (900, 90, 'Eggs', 'pcs', 1);
    INSERT INTO service_days (day, inhouse_guests, outside_guests, outsider_fee, submitted_at, submitted_by)
      VALUES ('2026-11-10', 30, 2, 0, '2026-11-10 07:40:00', 'Henry');
    INSERT INTO usage (day, ingredient_id, qty) VALUES ('2026-11-10', 900, 64);
  `);
  const statement = (sql) => {
    const st = { binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
    st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
    st.run = async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...st.binds).changes) } });
    return st;
  };
  return { prepare: statement, batch: async (stmts) => Promise.all(stmts.map((s) => s.run())) };
}

const open = async (db, permissions) => (await getDay({
  db, session: { user: { id: 1, name: 'x' }, permissions },
}, '2026-11-10')).json();

test('a submitted day opens blank for a cook, with the storeroom permission too', async () => {
  const db = database();
  const cook = await open(db, COOK);
  assert.equal(cook.clearedForEntry, true);
  assert.deepEqual(cook.usage, {}, 'the figures sent are not sent back to be nudged');
  assert.equal(cook.service.inhouse_guests, null);
  assert.ok(cook.service.submitted_at, 'but the day still says it was submitted');
  assert.equal(cook.restrictToEveryday, true, 'and the everyday-only setting applies');

  const manager = await open(db, MANAGER);
  assert.equal(manager.clearedForEntry, false);
  assert.deepEqual(manager.usage, { 900: 64 }, 'a reviewer sees what was recorded');
  assert.equal(manager.restrictToEveryday, false);
});
