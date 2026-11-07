import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { loadDataset } from '../src/lib/analytics.js';
import { departmentsOf, storeStock } from '../src/lib/store.js';
import { createDelivery } from '../src/routes/catalog.js';
import {
  approveRequest, cancelRequest, catalog, createRequest, declineRequest, issueRequest, listRequests, receiveRequest, report,
} from '../src/routes/store.js';
import { todayIn } from '../src/util/dates.js';

/**
 * The storeroom.
 *
 * What matters is that stock moves once and in the right direction: out of the
 * storeroom when issued, into the kitchen only when it is the kitchen's and
 * only food, at the price fixed on the day. Every one of those can go wrong
 * quietly — a number that is plausible and false — so each is pinned.
 */

const TODAY = todayIn('Africa/Accra');

/**
 * `approval` is the store_approval setting. Most of these tests are about the
 * storeroom itself (asking, issuing, receiving), so they run with approvals
 * off and a request goes straight to the storekeeper; the approval step has
 * its own tests at the end, with it on, as a new database has it.
 */
function database({ approval = false } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  sqlite.exec(`
    UPDATE settings SET value = 'Africa/Accra' WHERE key = 'timezone';
    UPDATE settings SET value = '${approval ? '1' : '0'}' WHERE key = 'store_approval';
    UPDATE settings SET value = 'Kitchen
Restaurant bar' WHERE key = 'store_departments';
    INSERT INTO categories (id, name) VALUES (90, 'Larder'), (91, 'Cleaning & paper');
    INSERT INTO ingredients (id, category_id, name, unit, default_unit_cost, store_opening, store_par) VALUES
      (900, 90, 'Fresh milk', 'L', 10, 24, 10),
      (901, 90, 'Sugar', 'kg', 15, 9, 10);
    INSERT INTO ingredients (id, category_id, name, unit, kind, default_unit_cost, store_opening) VALUES
      (950, 91, 'Toilet tissue', 'roll', 'supply', 4.5, 40),
      (951, 91, 'Dish soap', 'bottle', 'supply', 30, 0);
    -- Milk was last bought at 14, which is what an issue is valued at.
    INSERT INTO purchases (day, ingredient_id, qty, unit_cost, location) VALUES ('2026-10-01', 900, 12, 14, 'store');
  `);

  const statement = (sql) => {
    const st = { sql, binds: [] };
    st.bind = (...a) => { st.binds = a; return st; };
    st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
    st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
    st.run = async () => {
      const r = sqlite.prepare(sql).run(...st.binds);
      return { success: true, meta: { changes: Number(r.changes) } };
    };
    return st;
  };
  const db = {
    prepare: statement,
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run()); // eslint-disable-line no-await-in-loop
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { sqlite, db };
}

const COOK = { id: 1, name: 'Ama', role: 'cook', permissions: ['entry', 'store_request'] };
const KEEPER = { id: 2, name: 'Kwesi', role: 'storekeeper', permissions: ['store_issue'] };
const MANAGER = { id: 3, name: 'Godfred', role: 'manager', permissions: ['reports', 'purchases', 'store_request'] };

function ctx(db, who, { body, query = '' } = {}) {
  const url = new URL(`https://example.com/api/store${query}`);
  return {
    db,
    env: {},
    url,
    session: { user: who, permissions: who.permissions },
    request: new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

const call = async (handler, db, who, opts = {}, ...args) => (await handler(ctx(db, who, opts), ...args)).json();

async function ask(db, lines, extra = {}) {
  const { request } = await call(createRequest, db, COOK, { body: { needed: 'now', lines, ...extra } });
  return request;
}

const lineFor = (request, name) => request.lines.find((l) => l.name === name);

// ---------------------------------------------------------------- asking --

test('a request waits for the storeroom, most urgent first', async () => {
  const { db } = database();
  await ask(db, [{ ingredient_id: 901, qty: 2 }], { needed: 'tomorrow' });
  const urgent = await ask(db, [{ ingredient_id: 900, qty: 6 }, { ingredient_id: 950, qty: 4 }]);

  assert.equal(urgent.ref, `R-${String(urgent.id).padStart(4, '0')}`);
  assert.equal(urgent.status, 'waiting');

  const queue = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  assert.deepEqual(queue.waiting.map((r) => r.id)[0], urgent.id, 'needed now comes before tomorrow');
});

test('the same item twice is one line', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 2 }, { ingredient_id: 900, qty: 3 }]);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].asked, 5);
});

test('somebody who can only ask never sees a price', async () => {
  const { db } = database();
  const cat = await call(catalog, db, COOK);
  assert.ok(cat.items.length > 0);
  assert.ok(cat.items.every((i) => i.unitCost === undefined));

  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);
  const mine = await call(listRequests, db, COOK);
  assert.equal(mine.requests[0].value, undefined);
  assert.equal(mine.requests[0].lines[0].unitCost, undefined);
});

test('an item switched off for requests cannot be asked for', async () => {
  const { db, sqlite } = database();
  sqlite.exec('UPDATE ingredients SET requestable = 0 WHERE id = 901');
  const res = await createRequest(ctx(db, COOK, { body: { lines: [{ ingredient_id: 901, qty: 1 }] } }))
    .catch((err) => err);
  assert.equal(res.status, 400);
});

test('only a department on the list may ask', async () => {
  const { db } = database();
  assert.deepEqual(departmentsOf({ store_departments: 'Kitchen\nRestaurant bar' }), ['Kitchen', 'Restaurant bar']);
  const res = await createRequest(ctx(db, COOK, {
    body: { department: 'Spa', lines: [{ ingredient_id: 900, qty: 1 }] },
  })).catch((err) => err);
  assert.equal(res.status, 400);
});

// --------------------------------------------------------------- issuing --

test('a short issue leaves the rest as a new waiting request', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }, { ingredient_id: 951, qty: 1 }]);
  const out = await call(issueRequest, db, KEEPER, {
    body: {
      lines: [
        { id: lineFor(r, 'Fresh milk').id, issued: 6 },
        { id: lineFor(r, 'Dish soap').id, issued: 0, reason: 'Out of stock' },
      ],
    },
  }, r.id);

  assert.equal(out.request.status, 'issued');
  assert.equal(out.request.day, TODAY);
  assert.ok(out.followUp, 'the soap is still owed');

  const queue = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  assert.equal(queue.waiting.length, 1);
  assert.equal(queue.waiting[0].ref, out.followUp);
  assert.deepEqual(queue.waiting[0].lines.map((l) => [l.name, l.asked]), [['Dish soap', 1]]);
  assert.equal(queue.waiting[0].follows, r.ref);
});

test('an issue is valued at the last price paid, and keeps it', async () => {
  const { db, sqlite } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  const out = await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);
  assert.equal(out.request.lines[0].unitCost, 14);
  assert.equal(out.request.value, 84);

  // A dearer delivery afterwards does not reprice what was already issued.
  sqlite.exec("INSERT INTO purchases (day, ingredient_id, qty, unit_cost, location) VALUES ('2026-10-20', 900, 12, 20, 'store')");
  const again = await call(listRequests, db, KEEPER);
  assert.equal(again.requests.find((x) => x.id === r.id).value, 84);
});

test('nobody can issue the same request twice', async () => {
  const { db, sqlite } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 2 }]);
  const body = { lines: [{ id: r.lines[0].id, issued: 2 }] };
  await call(issueRequest, db, KEEPER, { body }, r.id);
  const second = await issueRequest(ctx(db, KEEPER, { body }), r.id).catch((err) => err);
  assert.equal(second.status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get('store.issue').n, 1);
});

test('a short line needs a reason, and issuing nothing is a decline', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  const noReason = await issueRequest(ctx(db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 4 }] } }), r.id)
    .catch((err) => err);
  assert.equal(noReason.status, 400);

  const nothing = await issueRequest(ctx(db, KEEPER, {
    body: { lines: [{ id: r.lines[0].id, issued: 0, reason: 'Out of stock' }] },
  }), r.id).catch((err) => err);
  assert.equal(nothing.status, 400);

  const bare = await declineRequest(ctx(db, KEEPER, { body: {} }), r.id).catch((err) => err);
  assert.equal(bare.status, 400, 'a decline says why');
  const declined = await call(declineRequest, db, KEEPER, { body: { note: 'Ask the manager first' } }, r.id);
  assert.equal(declined.request.status, 'declined');
});

test('a closed period stops an issue, and leaves the request waiting', async () => {
  const { db, sqlite } = database();
  sqlite.exec(`INSERT INTO period_locks (from_day, to_day, reason) VALUES ('${TODAY}', '${TODAY}', 'Stocktake')`);
  const r = await ask(db, [{ ingredient_id: 900, qty: 2 }]);
  const res = await issueRequest(ctx(db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 2 }] } }), r.id)
    .catch((err) => err);
  assert.equal(res.status, 409);
  const queue = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  assert.equal(queue.waiting[0].status, 'waiting');
});

test('only a waiting request can be cancelled', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 2 }]);
  const cancelled = await call(cancelRequest, db, COOK, { body: {} }, r.id);
  assert.equal(cancelled.request.status, 'cancelled');
  const again = await cancelRequest(ctx(db, COOK, { body: {} }), r.id).catch((err) => err);
  assert.equal(again.status, 409);
});

// ------------------------------------------------------------- the stock --

test('stock leaves the storeroom when issued, and reaches the kitchen', async () => {
  const { db } = database();
  const before = (await storeStock(db)).find((i) => i.id === 900);
  assert.equal(before.stock, 36, '24 on the shelf at the start, 12 delivered');

  const kitchenBefore = (await loadDataset(db)).ledger.stockOn(900, TODAY);
  assert.equal(kitchenBefore, 0, 'a delivery into the storeroom is not kitchen stock');

  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);

  assert.equal((await storeStock(db)).find((i) => i.id === 900).stock, 30);
  const ds = await loadDataset(db);
  assert.equal(ds.ledger.stockOn(900, TODAY), 6);
  assert.equal(ds.ledger.unitCostOn(900, TODAY), 14, 'at the price it was issued at');
});

test('a delivery straight to the kitchen still goes straight to the kitchen', async () => {
  const { db } = database();
  await call(createDelivery, db, MANAGER, {
    body: { day: TODAY, location: 'kitchen', items: [{ ingredient_id: 901, qty: 5, unit_cost: 15 }] },
  });
  await call(createDelivery, db, MANAGER, {
    body: { day: TODAY, items: [{ ingredient_id: 901, qty: 7, unit_cost: 15 }] },
  });
  const ds = await loadDataset(db);
  assert.equal(ds.ledger.stockOn(901, TODAY), 5, 'the second went to the storeroom, the default');
  assert.equal((await storeStock(db)).find((i) => i.id === 901).stock, 16, '9 at the start and 7 delivered');
});

test('what goes to the bar never reaches the breakfast kitchen', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 4 }], { department: 'Restaurant bar' });
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 4 }] } }, r.id);
  assert.equal((await loadDataset(db)).ledger.stockOn(900, TODAY), 0);
  assert.equal((await storeStock(db)).find((i) => i.id === 900).stock, 32, 'but it did leave the storeroom');
});

test('supplies are kept out of the breakfast figures', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 950, qty: 4 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 4 }] } }, r.id);
  const ds = await loadDataset(db);
  assert.equal(ds.ingredients.some((i) => i.id === 950), false, 'not on the sheet, not in stock, not in cost per guest');
  assert.equal(ds.ingredientById.get(950).name, 'Toilet tissue', 'but still named where it is listed');
  assert.equal((await storeStock(db)).find((i) => i.id === 950).stock, 36);
});

// ------------------------------------------------------------- receiving --

test('a reported difference is what the kitchen gets, and is flagged', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);

  const noNote = await receiveRequest(ctx(db, COOK, { body: { lines: [{ id: r.lines[0].id, received: 5 }] } }), r.id)
    .catch((err) => err);
  assert.equal(noNote.status, 400, 'a difference says what was wrong');

  const got = await call(receiveRequest, db, COOK, {
    body: { lines: [{ id: r.lines[0].id, received: 5 }], note: 'One carton missing' },
  }, r.id);
  assert.equal(got.request.status, 'received');
  assert.equal(got.request.difference, true);
  assert.equal((await loadDataset(db)).ledger.stockOn(900, TODAY), 5);

  const rep = await call(report, db, MANAGER);
  assert.ok(rep.attention.some((a) => /Difference reported/.test(a.title)));
});

test('confirming with no lines means it all arrived', async () => {
  const { db } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);
  const got = await call(receiveRequest, db, COOK, { body: {} }, r.id);
  assert.equal(got.request.status, 'received');
  assert.equal(got.request.difference, false);
  assert.equal(got.request.receivedBy, 'Ama');
});

test('an issue nobody confirms is taken as received after a day, and says so', async () => {
  const { db, sqlite } = database();
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);
  sqlite.exec(`UPDATE store_requests SET issued_at = datetime('now', '-25 hours') WHERE id = ${r.id}`);

  const mine = await call(listRequests, db, COOK);
  const it = mine.requests.find((x) => x.id === r.id);
  assert.equal(it.status, 'received');
  assert.equal(it.receivedAuto, true);

  // Noticed late, still said.
  const late = await call(receiveRequest, db, COOK, {
    body: { lines: [{ id: r.lines[0].id, received: 4 }], note: 'Found two short this morning' },
  }, r.id);
  assert.equal(late.request.difference, true);
  assert.equal(late.request.receivedAuto, false);
});

// --------------------------------------------------------------- report --

test('the report adds up what was issued, by item and by department', async () => {
  const { db } = database();
  const a = await ask(db, [{ ingredient_id: 900, qty: 6 }, { ingredient_id: 950, qty: 4 }]);
  await call(issueRequest, db, KEEPER, {
    body: { lines: a.lines.map((l) => ({ id: l.id, issued: l.asked })) },
  }, a.id);
  const b = await ask(db, [{ ingredient_id: 900, qty: 2 }], { department: 'Restaurant bar' });
  await call(issueRequest, db, KEEPER, { body: { lines: [{ id: b.lines[0].id, issued: 2 }] } }, b.id);

  const rep = await call(report, db, MANAGER);
  // Milk 8 at 14 = 112; tissue 4 at its fallback 4.50 = 18.
  assert.equal(rep.value, 130);
  assert.deepEqual(rep.byItem.map((i) => [i.name, i.qty, i.value]), [['Fresh milk', 8, 112], ['Toilet tissue', 4, 18]]);
  assert.deepEqual(rep.byDepartment, [{ name: 'Kitchen', value: 102 }, { name: 'Restaurant bar', value: 28 }]);
  assert.equal(rep.counts.full, 2);
  assert.ok(rep.low.some((i) => i.name === 'Dish soap'), 'none of it on the shelf');
});

// ---------------------------------------------------------- telling people --

test('a new request is emailed to the storeroom; what follows is not', async () => {
  const { sqlite, db } = database();
  sqlite.exec(`
    UPDATE settings SET value = 'Breakfast <b@example.com>' WHERE key = 'email_from';
    UPDATE settings SET value = 'https://breakfast.example.com' WHERE key = 'site_url';
    INSERT INTO users (id, name, email, role, permissions) VALUES
      (2, 'Kwesi', 'kwesi@example.com', 'storekeeper', '["store_issue"]'),
      (1, 'Ama', 'ama@example.com', 'cook', '["entry","store_request"]');
  `);
  const mails = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('resend')) mails.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  };
  const withKey = (who, opts) => ({ ...ctx(db, who, opts), env: { RESEND_API_KEY: 'test-key' } });

  try {
    const { request } = await (await createRequest(withKey(COOK, {
      body: { needed: 'now', note: 'For the omelette station', lines: [{ ingredient_id: 900, qty: 6 }, { ingredient_id: 950, qty: 4 }] },
    }))).json();

    assert.equal(mails.length, 1, 'one email for the new request');
    assert.deepEqual(mails[0].to, ['kwesi@example.com'], 'to the storeroom, not to the person asking');
    assert.match(mails[0].subject, new RegExp(request.ref));
    assert.match(mails[0].html, /Fresh milk: 6/);
    assert.match(mails[0].html, /Toilet tissue: 4/);
    assert.match(mails[0].html, /omelette station/);
    assert.match(mails[0].html, /https:\/\/breakfast\.example\.com#\/store/);

    // Issued short, so a follow-up is raised too: still no more email.
    await issueRequest(withKey(KEEPER, {
      body: { lines: request.lines.map((l) => ({ id: l.id, issued: l.name === 'Fresh milk' ? 6 : 0, reason: 'none left' })) },
    }), request.id);
    const second = (await (await createRequest(withKey(COOK, { body: { lines: [{ ingredient_id: 901, qty: 1 }] } }))).json()).request;
    await cancelRequest(withKey(COOK, { body: {} }), second.id);
    assert.equal(mails.length, 2, 'the second request is emailed; the issue and the cancel are not');

    const kinds = sqlite.prepare('SELECT kind FROM app_notices ORDER BY id').all().map((r) => r.kind);
    assert.deepEqual(kinds, ['store_request', 'store_issued', 'store_request', 'store_cancelled'],
      'every step still lands on the bell');
  } finally {
    globalThis.fetch = original;
  }
});

// ------------------------------------------------------------- approving --

const BOSS = { id: 4, name: 'Efua', role: 'manager', permissions: ['reports', 'store_request', 'store_approve'] };

const expectStatus = async (promise, status, pattern) => {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
};

test('a new database asks a manager first', () => {
  // The migrations alone, without the fixture's choice of setting.
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  const { value } = sqlite.prepare("SELECT value FROM settings WHERE key = 'store_approval'").get();
  assert.equal(value, '1');
});

test('with approvals on, the storeroom cannot issue until a manager approves', async () => {
  const { db } = database({ approval: true });
  const r = await ask(db, [{ ingredient_id: 900, qty: 6 }]);
  assert.equal(r.status, 'waiting');

  const queue = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  assert.equal(queue.approval, true);
  assert.deepEqual(queue.waiting, [], 'nothing the storeroom may issue yet');
  assert.deepEqual(queue.awaitingApproval.map((x) => x.id), [r.id], 'but it can see what is coming');

  await expectStatus(
    issueRequest(ctx(db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }), r.id),
    409, /waiting for a manager/,
  );

  const toApprove = await call(listRequests, db, BOSS, { query: '?view=approve' });
  assert.deepEqual(toApprove.waiting.map((x) => x.id), [r.id]);

  const { request: approved } = await call(approveRequest, db, BOSS, {}, r.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'Efua');
  assert.ok(approved.approvedAt);

  const after = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  assert.deepEqual(after.waiting.map((x) => x.id), [r.id], 'now the storeroom has it');
  assert.deepEqual(after.awaitingApproval, []);
  assert.deepEqual((await call(listRequests, db, BOSS, { query: '?view=approve' })).waiting, []);

  const { request: issued } = await call(issueRequest, db, KEEPER, { body: { lines: [{ id: r.lines[0].id, issued: 6 }] } }, r.id);
  assert.equal(issued.status, 'issued');
  assert.equal(issued.approvedBy, 'Efua', 'who approved it stays on the record');
});

test('a request is approved once, and only while it is waiting', async () => {
  const { db } = database({ approval: true });
  const r = await ask(db, [{ ingredient_id: 900, qty: 1 }]);
  await call(approveRequest, db, BOSS, {}, r.id);
  await expectStatus(approveRequest(ctx(db, BOSS), r.id), 409, /already been approved/);

  const c = await ask(db, [{ ingredient_id: 900, qty: 1 }]);
  await call(cancelRequest, db, COOK, { body: {} }, c.id);
  await expectStatus(approveRequest(ctx(db, BOSS), c.id), 409, /cancelled/);
});

test('with approvals off there is nothing to approve', async () => {
  const { db } = database({ approval: false });
  const r = await ask(db, [{ ingredient_id: 900, qty: 1 }]);
  await expectStatus(approveRequest(ctx(db, BOSS), r.id), 409, /do not need approving/);
  assert.deepEqual((await call(listRequests, db, BOSS, { query: '?view=approve' })).waiting, []);
});

test('a manager can decline, before or after approving', async () => {
  const { db } = database({ approval: true });
  const a = await ask(db, [{ ingredient_id: 900, qty: 50 }]);
  const { request: no } = await call(declineRequest, db, BOSS, { body: { note: 'Fifty litres is a typo' } }, a.id);
  assert.equal(no.status, 'declined');
  assert.equal(no.issueNote, 'Fifty litres is a typo');

  const b = await ask(db, [{ ingredient_id: 900, qty: 2 }]);
  await call(approveRequest, db, BOSS, {}, b.id);
  const { request: second } = await call(declineRequest, db, KEEPER, { body: { note: 'None left' } }, b.id);
  assert.equal(second.status, 'declined', 'the storeroom can still say it has none');
});

test('an approved request can still be cancelled by whoever asked', async () => {
  const { db } = database({ approval: true });
  const r = await ask(db, [{ ingredient_id: 901, qty: 1 }]);
  await call(approveRequest, db, BOSS, {}, r.id);
  const { request } = await call(cancelRequest, db, COOK, { body: {} }, r.id);
  assert.equal(request.status, 'cancelled');
});

test('the rest of a short issue is already approved', async () => {
  const { db } = database({ approval: true });
  const r = await ask(db, [{ ingredient_id: 900, qty: 30 }]);
  await call(approveRequest, db, BOSS, {}, r.id);
  const { followUp } = await call(issueRequest, db, KEEPER, {
    body: { lines: [{ id: r.lines[0].id, issued: 24, reason: 'Not enough in stock' }] },
  }, r.id);
  assert.ok(followUp);

  const queue = await call(listRequests, db, KEEPER, { query: '?view=queue' });
  const rest = queue.waiting.find((x) => x.ref === followUp);
  assert.ok(rest, 'the rest goes straight back to the storeroom, not to a manager');
  assert.equal(rest.status, 'approved');
  assert.equal(rest.approvedBy, 'Efua');
  assert.equal(rest.lines[0].asked, 6);
});

test('with approvals on, a new request goes to the managers, and approving tells the storeroom', async () => {
  const { sqlite, db } = database({ approval: true });
  sqlite.exec(`
    UPDATE settings SET value = 'Breakfast <b@example.com>' WHERE key = 'email_from';
    INSERT INTO users (id, name, email, role, permissions) VALUES
      (2, 'Kwesi', 'kwesi@example.com', 'storekeeper', '["store_issue"]'),
      (4, 'Efua', 'efua@example.com', 'manager', '["reports","store_request","store_approve"]');
  `);
  const mails = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('resend')) mails.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  };
  try {
    const { request } = await (await createRequest({
      ...ctx(db, COOK, { body: { needed: 'now', lines: [{ id: 0, ingredient_id: 900, qty: 3 }] } }),
      env: { RESEND_API_KEY: 'test-key' },
    })).json();
    assert.equal(mails.length, 1);
    assert.deepEqual(mails[0].to, ['efua@example.com'], 'the manager, who acts next');
    assert.match(mails[0].subject, /^Approve storeroom request/);

    await call(approveRequest, db, BOSS, {}, request.id);
    assert.equal(mails.length, 1, 'approving is a nudge, not another email');

    const notices = sqlite.prepare('SELECT kind, audience FROM app_notices ORDER BY id').all()
      .map((n) => `${n.kind}:${n.audience}`);
    assert.deepEqual(notices, ['store_request:store_approve', 'store_approved:store_issue']);
  } finally {
    globalThis.fetch = original;
  }
});

test('switching approvals on lets through what was already waiting', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql') && n < '0026').sort()) {
    sqlite.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO categories (id, name) VALUES (90, 'Larder');
    INSERT INTO ingredients (id, category_id, name, unit) VALUES (900, 90, 'Fresh milk', 'L');
    INSERT INTO store_requests (id, requested_by, status) VALUES (1, 'Ama', 'waiting'), (2, 'Ama', 'issued');
  `);
  sqlite.exec(readFileSync('migrations/0026_store_approval.sql', 'utf8'));
  const rows = sqlite.prepare('SELECT id, status, approved_by FROM store_requests ORDER BY id').all()
    .map((r) => [r.id, r.status, r.approved_by]);
  assert.deepEqual(rows, [[1, 'approved', 'Before approvals began'], [2, 'issued', null]]);
});
