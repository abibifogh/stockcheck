import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issue, markReturned, retire, setParent } from '../src/routes/mx-tools.js';

/**
 * Tools that come with things.
 *
 * An accessory is a tool with a parent, which is what buys it a history of its
 * own — and the whole point is that the history stays separate. A charger that
 * does not come back with the drill is the case worth being able to answer, so
 * these pin the places where the two could get merged: issuing, returning, and
 * retiring the parent.
 */

const DRILL = { id: 3, name: 'Impact drill', active: 1, parent_tool_id: null };

function fakeDb({
  tool = DRILL,
  accessories = [],
  trip = null,
  alongside = [],
  outOfStock = new Set(),
  parent = null,
  ownAccessories = 0,
  // Who holds a tool that is already out. Answers both the collision message
  // when issuing and the guard that stops a tool being retired mid-journey.
  heldBy = 'Yaa',
} = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM settings/.test(sql)) return { results: [{ key: 'mx_tool_hours', value: '24' }] };
      // The accessories asked for, read back so an id that is not one cannot
      // sneak through.
      if (/FROM mx_tools\s+WHERE parent_tool_id/.test(sql)) {
        const asked = new Set(this.binds.slice(1));
        return { results: accessories.filter((a) => asked.has(a.id)) };
      }
      if (/JOIN mx_tools t ON t\.id = m\.tool_id/.test(sql)) return { results: alongside };
      return { results: [] };
    },
    async first() {
      if (/INSERT INTO mx_tool_movements/.test(sql)) {
        // binds[0] is the tool; an accessory somebody else has is refused by
        // the partial unique index, exactly as it would be in SQLite.
        if (outOfStock.has(this.binds[0])) throw new Error('UNIQUE constraint failed: idx_mx_tool_out');
        written.push({ sql, binds: this.binds });
        return { id: 77 };
      }
      if (/COUNT\(\*\) AS n FROM mx_tools/.test(sql)) return { n: ownAccessories };
      if (/FROM mx_tools WHERE id = \? AND active = 1/.test(sql)) {
        return Number(this.binds[0]) === tool.id ? tool : parent;
      }
      if (/FROM mx_tools/.test(sql)) return tool;
      if (/issued_to FROM mx_tool_movements/.test(sql)) return heldBy ? { issued_to: heldBy } : null;
      if (/FROM mx_tool_movements/.test(sql)) return trip;
      if (/FROM mx_areas/.test(sql)) return { id: 2 };
      return null;
    },
    async run() {
      if (outOfStock.has(this.binds[0]) && /INSERT INTO mx_tool_movements/.test(sql)) {
        throw new Error('UNIQUE constraint failed: idx_mx_tool_out');
      }
      written.push({ sql, binds: this.binds });
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    written,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      for (const st of statements) written.push({ sql: st.sql, binds: st.binds });
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

const ctx = (db, body) => ({
  db,
  env: {},
  session: { user: { name: 'Ama', role: 'admin' } },
  request: new Request('https://example.com/api/mx/tools/3/issue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

const moves = (db) => db.written.filter((w) => /INSERT INTO mx_tool_movements/.test(w.sql));

const CHARGER = { id: 8, name: 'Charger' };
const CASE = { id: 9, name: 'Carry case' };

// ------------------------------------------------------------- issuing --

test('accessories go out as journeys of their own, pointing at the parent trip', async () => {
  const db = fakeDb({ accessories: [CHARGER, CASE] });

  const res = await issue(ctx(db, { issuedTo: 'Kofi', areaId: 2, accessoryIds: [8, 9] }), 3);

  const rows = moves(db);
  assert.equal(rows.length, 3, 'the drill and its two accessories');
  assert.deepEqual(rows.map((r) => r.binds[0]), [3, 8, 9]);
  // Which is what keeps them findable separately later.
  assert.deepEqual(rows.slice(1).map((r) => r.binds[7]), [77, 77], 'both link to the drill’s trip');
  assert.equal(rows[0].binds[7], undefined, 'the parent links to nothing');
  assert.deepEqual((await res.json()).accessories, ['Charger', 'Carry case']);
});

test('one accessory already out does not refuse the rest', async () => {
  // The storeman is at the counter. Handing over three of four and being told
  // about the fourth beats being told to come back later.
  const db = fakeDb({ accessories: [CHARGER, CASE], outOfStock: new Set([9]) });

  const res = await issue(ctx(db, { issuedTo: 'Kofi', accessoryIds: [8, 9] }), 3);
  const body = await res.json();

  assert.deepEqual(moves(db).map((r) => r.binds[0]), [3, 8], 'the drill and the charger went');
  assert.deepEqual(body.accessories, ['Charger']);
  assert.match(body.missed[0], /Carry case is already out with Yaa/);
});

test('an id that is not an accessory of this tool is ignored', async () => {
  // Read back rather than trusted: otherwise one request could issue anything
  // in the register under somebody else's name.
  const db = fakeDb({ accessories: [CHARGER] });

  await issue(ctx(db, { issuedTo: 'Kofi', accessoryIds: [8, 4242] }), 3);

  assert.deepEqual(moves(db).map((r) => r.binds[0]), [3, 8]);
});

test('asking for no accessories issues only the tool', async () => {
  const db = fakeDb({ accessories: [CHARGER, CASE] });
  await issue(ctx(db, { issuedTo: 'Kofi', accessoryIds: [] }), 3);
  assert.equal(moves(db).length, 1);
});

// ----------------------------------------------------------- returning --

test('what went out together comes back together', async () => {
  const db = fakeDb({
    trip: { id: 77, issued_to: 'Kofi', overdue_notified_at: null },
    alongside: [{ id: 78, name: 'Charger' }, { id: 79, name: 'Carry case' }],
  });

  const res = await markReturned(ctx(db, {}), 3);

  const closed = db.written.filter((w) => /SET returned_at/.test(w.sql));
  assert.equal(closed.length, 3, 'the trip and both accessories');
  assert.deepEqual((await res.json()).accessories, ['Charger', 'Carry case']);
});

test('an accessory can be left out on purpose', async () => {
  // A charger still on a job while the drill comes back is an ordinary
  // Tuesday, and only the store keeper can see which it is.
  const db = fakeDb({
    trip: { id: 77, issued_to: 'Kofi', overdue_notified_at: null },
    alongside: [{ id: 78, name: 'Charger' }],
  });

  const res = await markReturned(ctx(db, { withAccessories: false }), 3);
  const body = await res.json();

  assert.equal(db.written.filter((w) => /SET returned_at/.test(w.sql)).length, 1);
  assert.deepEqual(body.accessories, []);
  assert.deepEqual(body.stillOut, ['Charger'], 'and it says so rather than showing fewer');
});

// ------------------------------------------------------------- linking --

test('a tool cannot be an accessory of itself', async () => {
  const db = fakeDb();
  await assert.rejects(() => setParent(ctx(db, { parentId: 3 }), 3), /cannot be an accessory of itself/);
});

test('accessories go one level deep', async () => {
  // A charger belongs to a drill, not to a drill's case. Refusing this is what
  // makes a cycle impossible rather than merely unlikely.
  const db = fakeDb({
    tool: { id: 8, name: 'Charger', active: 1, parent_tool_id: null },
    parent: { id: 9, name: 'Carry case', active: 1, parent_tool_id: 3 },
  });

  await assert.rejects(() => setParent(ctx(db, { parentId: 9 }), 8), /one level deep/);
});

test('a tool with accessories of its own cannot become one', async () => {
  const db = fakeDb({
    parent: { id: 5, name: 'Tool chest', active: 1, parent_tool_id: null },
    ownAccessories: 2,
  });

  await assert.rejects(() => setParent(ctx(db, { parentId: 5 }), 3), /Detach those first/);
});

test('detaching sets it loose without touching its journeys', async () => {
  const db = fakeDb({ tool: { id: 8, name: 'Charger', active: 1, parent_tool_id: 3 } });

  await setParent(ctx(db, { parentId: null }), 8);

  const writes = db.written.filter((w) => /UPDATE mx_tools/.test(w.sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /parent_tool_id = NULL/);
  assert.equal(db.written.some((w) => /mx_tool_movements/.test(w.sql)), false, 'no journey moves');
});

// ------------------------------------------------------------- retiring --

test('retiring a tool sets its accessories loose rather than hiding them', async () => {
  // Leaving them pointing at a retired parent would take them off every screen
  // while leaving them in the database — present and invisible.
  const db = fakeDb({ trip: null, ownAccessories: 2, heldBy: null });

  const res = await retire(ctx(db, {}), 3);

  const freed = db.written.find((w) => /parent_tool_id = NULL WHERE parent_tool_id/.test(w.sql));
  assert.ok(freed, 'the accessories are detached in the same batch');
  assert.equal((await res.json()).freed, 2);
});
