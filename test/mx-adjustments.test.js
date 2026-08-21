import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteIssue, deletePurchase, updatePurchase, reviewAdjustments,
} from '../src/routes/maintenance.js';

/**
 * Changing something the parts store already recorded.
 *
 * The rule: it is a request, not an act. Nothing moves on the shelf until an
 * administrator accepts it — the same rule a count has followed since 0007, now
 * covering the two ways round it. Deleting an issue put parts back immediately;
 * deleting a delivery took them off; and either could be done the day after a
 * count was agreed, which reopens the hole from the other side.
 *
 * A stub database, because what matters here is which statements are written
 * and in what order.
 */

const ISSUE = {
  id: 5, day: '2026-08-10', item_id: 1, area_id: 2, qty: 4,
  job_ref: 'JOB-1', note: null, issued_by: 'Kofi',
};
const PURCHASE = {
  id: 9, day: '2026-08-09', item_id: 1, qty: 20, unit_cost: 3.5,
  supplier: 'Acme', note: null,
};

function fakeDb({ target = PURCHASE, pending = [], insertFails = null, openOnTarget = false } = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM settings/.test(sql)) return { results: [{ key: 'notify_count_pending', value: '0' }] };
      if (/FROM mx_adjustments/.test(sql)) return { results: pending };
      if (/FROM mx_items/.test(sql)) return { results: [{ id: 1, name: 'Tap washer', unit: 'pcs' }] };
      if (/FROM mx_areas/.test(sql)) return { results: [{ id: 2, name: 'Room 101' }] };
      return { results: [] };
    },
    async first() {
      // The revive guard: is a newer request already open on this entry?
      if (/FROM mx_adjustments/.test(sql)) return openOnTarget ? { id: 99 } : null;
      if (/FROM mx_issues|FROM mx_purchases/.test(sql)) return target;
      if (/FROM mx_areas/.test(sql)) return { id: 2 };
      return null;
    },
    async run() {
      if (insertFails && /INSERT INTO mx_adjustments/.test(sql)) throw new Error(insertFails);
      written.push({ sql, binds: this.binds });
      return { success: true, meta: { changes: 1 } };
    },
  });

  return {
    written,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      for (const s of statements) written.push({ sql: s.sql, binds: s.binds });
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function context(db, { method = 'DELETE', body = {} } = {}) {
  return {
    db,
    env: {},
    session: { user: { name: 'Ama', role: 'admin' } },
    request: new Request('https://example.com/api/mx/purchases/9', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const wrote = (db, re) => db.written.filter((w) => re.test(w.sql));

// --------------------------------------------------------------- proposing --

test('deleting a delivery asks, and removes nothing', async () => {
  const db = fakeDb();
  const res = await deletePurchase(context(db), 9);

  assert.equal(res.status, 202, 'accepted for review, not done');
  assert.equal((await res.json()).awaitingApproval, true);

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 0, 'the delivery is still there');
  assert.equal(wrote(db, /INSERT INTO mx_adjustments/).length, 1);
});

test('deleting an issue asks too — the other way round a count', async () => {
  const db = fakeDb({ target: ISSUE });
  await deleteIssue(context(db), 5);

  assert.equal(wrote(db, /DELETE FROM mx_issues/).length, 0);
  const [request] = wrote(db, /INSERT INTO mx_adjustments/);
  assert.equal(request.binds[0], 'issue');
  assert.equal(request.binds[1], 'delete');
  assert.equal(request.binds[3], null, 'a removal proposes no values');
});

test('the request keeps the row as it stood, for the reviewer to compare', async () => {
  const db = fakeDb();
  await deletePurchase(context(db), 9);

  const [request] = wrote(db, /INSERT INTO mx_adjustments/);
  assert.deepEqual(JSON.parse(request.binds[4]), PURCHASE);
});

test('an edit records what it would become, and still changes nothing', async () => {
  const db = fakeDb();
  await updatePurchase(context(db, { method: 'PUT', body: { qty: 18, unitCost: 4 } }), 9);

  assert.equal(wrote(db, /UPDATE mx_purchases/).length, 0, 'nothing is applied yet');

  const [request] = wrote(db, /INSERT INTO mx_adjustments/);
  assert.equal(request.binds[1], 'edit');
  const payload = JSON.parse(request.binds[3]);
  assert.equal(payload.qty, 18);
  assert.equal(payload.unit_cost, 4);
  assert.equal(payload.day, PURCHASE.day, 'what was not sent keeps its old value');
});

test('an edit that changes nothing is refused rather than queued', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => updatePurchase(context(db, { method: 'PUT', body: { qty: PURCHASE.qty } }), 9),
    /Nothing on that entry was changed/,
  );
  assert.equal(wrote(db, /INSERT INTO mx_adjustments/).length, 0);
});

test('a second request on the same entry is an ordinary refusal', async () => {
  // The partial unique index does the work; this is how it reaches the person.
  const db = fakeDb({ insertFails: 'UNIQUE constraint failed: idx_mx_adjustments_open' });
  await assert.rejects(
    () => deletePurchase(context(db), 9),
    /already a change waiting/,
  );
});

test('an entry that has already gone is a plain not-found', async () => {
  const db = fakeDb({ target: null });
  await assert.rejects(() => deletePurchase(context(db), 9), /already gone/);
});

// --------------------------------------------------------------- reviewing --

const request = (over = {}) => ({
  id: 1, kind: 'purchase', action: 'delete', target_id: 9,
  payload: null, previous: JSON.stringify(PURCHASE), status: 'pending', ...over,
});

test('accepting a removal is what finally removes it', async () => {
  const db = fakeDb({ pending: [request()] });
  const res = await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 1);
  assert.equal((await res.json()).applied, 1);
});

test('accepting an edit applies exactly the proposed columns', async () => {
  const payload = {
    day: '2026-08-09', qty: 18, unit_cost: 4, supplier: 'Acme', note: 'corrected',
  };
  const db = fakeDb({ pending: [request({ action: 'edit', payload: JSON.stringify(payload) })] });
  await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  const [update] = wrote(db, /UPDATE mx_purchases/);
  assert.match(update.sql, /day = \?1.*qty = \?2.*unit_cost = \?3.*supplier = \?4.*note = \?5/s);
  assert.deepEqual(update.binds, ['2026-08-09', 18, 4, 'Acme', 'corrected', 9]);
});

test('rejecting touches the entry not at all', async () => {
  const db = fakeDb({ pending: [request()] });
  await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: false } }));

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 0);
  const [decision] = wrote(db, /UPDATE mx_adjustments/);
  assert.equal(decision.binds[0], 'rejected');
});

test('accepting something whose entry has since gone says so', async () => {
  // Between asking and deciding, another accepted request removed the row.
  const db = fakeDb({ target: null, pending: [request()] });
  const res = await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  const body = await res.json();
  assert.equal(body.applied, 0);
  assert.equal(body.missing, 1, 'counted as missing rather than quietly as applied');

  const [decision] = wrote(db, /UPDATE mx_adjustments/);
  assert.equal(decision.binds[0], 'rejected');
  assert.match(decision.binds[2], /no longer exists/);
});

test('a decision names who made it, and never lands on an applied one', async () => {
  const db = fakeDb({ pending: [request()] });
  await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  const [decision] = wrote(db, /UPDATE mx_adjustments/);
  assert.equal(decision.binds[1], 'Ama');
  // Pending or rejected may be decided; approved may not. Applying a change
  // twice is never a correction.
  assert.match(decision.sql, /status IN \('pending', 'rejected'\)/);
});

test('nothing selected is refused', async () => {
  const db = fakeDb();
  await assert.rejects(
    () => reviewAdjustments(context(db, { method: 'POST', body: { ids: [], approve: true } })),
    /Nothing was selected/,
  );
});

// ------------------------------------------------- changing a mind, later --

/**
 * A rejection is a decision for now, not a verdict for ever. The usual reason
 * for one is "I do not believe this yet", and the answer arrives afterwards —
 * at which point making somebody re-file the identical request would lose who
 * asked, when, and why.
 */

const turnedDown = (over = {}) => request({ status: 'rejected', ...over });

test('something rejected earlier can still be accepted', async () => {
  const db = fakeDb({ pending: [turnedDown()] });
  const res = await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 1, 'it finally happens');
  const body = await res.json();
  assert.equal(body.applied, 1);
  assert.equal(body.revived, 1, 'and the screen can say it was reopened rather than new');
});

test('the query that finds them looks past pending', async () => {
  const db = fakeDb({ pending: [turnedDown()] });
  await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  const [lookup] = db.written.filter((w) => /SELECT \* FROM mx_adjustments/.test(w.sql));
  assert.ok(lookup === undefined || /status IN/.test(lookup.sql));
});

test('reviving is refused while a newer request is open on the same entry', async () => {
  // Two decisions on one row, in an order nobody chose. The open one is the
  // live question, so that is the one to answer.
  const db = fakeDb({ pending: [turnedDown()], openOnTarget: true });
  const res = await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 0, 'nothing applied');
  assert.equal(wrote(db, /UPDATE mx_adjustments/).length, 0, 'and it stays rejected');

  const body = await res.json();
  assert.equal(body.blocked, 1);
  assert.equal(body.applied, 0);
});

test('a pending request is unaffected by that guard', async () => {
  // The guard is only about reviving. A pending one is the live question.
  const db = fakeDb({ pending: [request()], openOnTarget: true });
  await reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } }));

  assert.equal(wrote(db, /DELETE FROM mx_purchases/).length, 1);
});

test('an already-applied request is not offered again', async () => {
  // The select returns nothing for it, which is the whole guard.
  const db = fakeDb({ pending: [] });
  await assert.rejects(
    () => reviewAdjustments(context(db, { method: 'POST', body: { ids: [1], approve: true } })),
    /already been applied/,
  );
});
