import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { suppliers } from '../src/routes/link.js';
import { signLink } from '../src/lib/link.js';

/**
 * The supplier list Insight sends: only when Insight signed it; added or
 * brought up to date by Odoo id, key suppliers first; one no longer sent is
 * retired; suppliers added here by hand are left alone. Made-up suppliers.
 */

const SECRET = 'shared-with-insight';
const PATH = '/api/link/suppliers';

function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  const statement = (sql) => {
    const st = { binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
    st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
    st.run = async () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...st.binds).changes) } });
    return st;
  };
  return { sqlite, db: { prepare: statement } };
}

async function send(db, body, { secret = SECRET } = {}) {
  const text = JSON.stringify(body);
  const request = new Request(`https://breakfast.example.test${PATH}`, { method: 'POST', headers: await signLink(secret, PATH, text), body: text });
  const res = await suppliers({ request, env: { INSIGHT_SSO_SECRET: SECRET }, db });
  return res.json();
}

test('only Insight may send the list', async () => {
  const { db } = freshDb();
  await assert.rejects(send(db, { suppliers: [] }, { secret: 'wrong' }), /Only Insight/);
});

test('added by Odoo id, key suppliers first, matched by name the first time, retired when no longer sent', async () => {
  const { sqlite, db } = freshDb();
  sqlite.exec("INSERT INTO suppliers (name, phone) VALUES ('A Dairy', '0240000009'), ('A Corner Shop', NULL)");
  let out = await send(db, { suppliers: [
    { odooId: 12, name: 'A Bakery Supplier', key: true, group: 'Food & breakfast' },
    { odooId: 13, name: 'A Dairy', key: false, phone: null },
    { odooId: 14, name: 'A Hardware Shop', key: false },
  ] });
  assert.deepEqual([out.added, out.updated, out.retired], [2, 1, 0]);
  const pick = () => sqlite.prepare('SELECT name, odoo_id, key_supplier, grp, active, phone FROM suppliers WHERE active = 1 ORDER BY sort_order, name').all().map((r) => ({ ...r }));
  // Key suppliers first, then ones added here by hand, then the rest of Odoo's list.
  assert.deepEqual(pick().map((r) => r.name), ['A Bakery Supplier', 'A Corner Shop', 'A Dairy', 'A Hardware Shop']);
  const dairy = pick().find((r) => r.name === 'A Dairy');
  assert.deepEqual([dairy.odoo_id, dairy.phone], [13, '0240000009'], 'matched by name, its phone kept');

  // Renamed in Odoo, no longer key, one gone: brought up to date and retired; the hand-added one untouched.
  out = await send(db, { suppliers: [
    { odooId: 12, name: 'A Bakery Supplier Ltd', key: false },
    { odooId: 13, name: 'A Dairy', key: true, group: 'Food & breakfast' },
  ] });
  assert.equal(out.retired, 1);
  assert.deepEqual(pick().map((r) => `${r.key_supplier ? '★' : ''}${r.name}`), ['★A Dairy', 'A Corner Shop', 'A Bakery Supplier Ltd']);
  assert.equal(sqlite.prepare("SELECT active FROM suppliers WHERE name = 'A Hardware Shop'").get().active, 0);
});
