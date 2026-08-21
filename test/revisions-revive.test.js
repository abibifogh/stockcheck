import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listRevisions, reviewRevision } from '../src/routes/revisions.js';

/**
 * Reopening a change to a breakfast day that was turned down.
 *
 * A rejection usually means "I do not believe this yet", and the cook's
 * explanation arrives the next morning. Making them re-submit the identical
 * sheet would lose who proposed it and when, so the original is accepted
 * instead — the same rule the parts store follows.
 *
 * Two things make that a bad idea, and both are invisible on the request
 * itself: a newer proposal waiting on the same day, and the day having moved on
 * since. These pin down that both are noticed.
 */

const PREVIOUS = {
  inhouse_guests: 30,
  outside_guests: 2,
  note: null,
  usage: { 1: 4, 2: 6 },
};
const PAYLOAD = {
  inhouse_guests: 34,
  outside_guests: 2,
  note: null,
  usage: { 1: 5, 2: 6 },
  cleared: [],
};

const REVISION = {
  id: 7,
  day: '2026-08-10',
  status: 'rejected',
  payload: JSON.stringify(PAYLOAD),
  previous: JSON.stringify(PREVIOUS),
  submitted_by: 'Kofi',
  submitted_at: '2026-08-10T09:00:00',
  reviewed_by: 'Ama (admin)',
  reviewed_at: '2026-08-10T10:00:00',
  review_note: 'Ask Kofi what happened first',
};

/**
 * @param live  the day as it stands now — omit to leave it matching `previous`
 * @param open  whether a newer proposal is waiting on the same day
 */
function fakeDb({ revision = REVISION, live = null, open = false, rows = null } = {}) {
  const written = [];
  const sheet = live?.sheet ?? {
    day: REVISION.day,
    inhouse_guests: PREVIOUS.inhouse_guests,
    outside_guests: PREVIOUS.outside_guests,
    note: PREVIOUS.note,
  };
  const usage = live?.usage ?? Object.entries(PREVIOUS.usage)
    .map(([id, qty]) => ({ day: REVISION.day, ingredient_id: Number(id), qty }));

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM day_revisions WHERE status = 'pending'/.test(sql)) {
        return { results: open ? [{ day: REVISION.day }] : [] };
      }
      if (/FROM day_revisions/.test(sql)) return { results: rows ?? [revision] };
      if (/FROM ingredients/.test(sql)) {
        return { results: [{ id: 1, name: 'Eggs', unit: 'pcs' }, { id: 2, name: 'Bread', unit: 'loaf' }] };
      }
      if (/FROM service_days/.test(sql)) return { results: [sheet] };
      if (/FROM usage/.test(sql)) return { results: usage };
      return { results: [] };
    },
    async first() {
      if (/FROM day_revisions WHERE day = \? AND status = 'pending'/.test(sql)) {
        return open ? { id: 99 } : null;
      }
      if (/FROM day_revisions WHERE id = \?/.test(sql)) return revision;
      if (/FROM period_locks/.test(sql)) return null;
      return null;
    },
    async run() { written.push({ sql, binds: this.binds }); return { success: true }; },
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

function context(db, { body = {}, status = 'rejected' } = {}) {
  return {
    db,
    env: {},
    url: new URL(`https://example.com/api/revisions?status=${status}`),
    session: { user: { name: 'Ama', role: 'admin' } },
    request: new Request('https://example.com/api/revisions/7', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

const wrote = (db, re) => db.written.filter((w) => re.test(w.sql));
const only = async (res) => (await res.json()).revisions[0];

// ------------------------------------------------------------- reviewing --

test('a rejected change can still be accepted', async () => {
  const db = fakeDb();
  const res = await reviewRevision(context(db, { body: { approve: true } }), 7);

  assert.equal((await res.json()).status, 'approved');
  assert.ok(wrote(db, /INSERT INTO service_days/).length, 'the sheet is written');
  assert.ok(wrote(db, /INSERT INTO usage/).length, 'and so are the quantities');
});

test('accepting is refused while a newer change waits on the same day', async () => {
  const db = fakeDb({ open: true });
  await assert.rejects(
    () => reviewRevision(context(db, { body: { approve: true } }), 7),
    /newer change for that day/,
  );
  assert.equal(wrote(db, /INSERT INTO service_days/).length, 0, 'nothing was applied');
});

test('that guard does not block rejecting it again', async () => {
  // Only accepting can collide. Re-rejecting just records a fresh note.
  const db = fakeDb({ open: true });
  const res = await reviewRevision(context(db, { body: { approve: false, note: 'still no' } }), 7);
  assert.equal((await res.json()).status, 'rejected');
});

test('an already-approved change is still refused', async () => {
  // Applying a sheet twice is not a correction.
  const db = fakeDb({ revision: { ...REVISION, status: 'approved' } });
  await assert.rejects(
    () => reviewRevision(context(db, { body: { approve: true } }), 7),
    /already approved/,
  );
});

test('a superseded one stays refused too', async () => {
  // A newer proposal already replaced it; reviving it would undo that.
  const db = fakeDb({ revision: { ...REVISION, status: 'superseded' } });
  await assert.rejects(
    () => reviewRevision(context(db, { body: { approve: true } }), 7),
    /already superseded/,
  );
});

// ------------------------------------------------- what the screen is told --

test('an untouched day is not flagged stale', async () => {
  const db = fakeDb();
  const row = await only(await listRevisions(context(db)));

  assert.equal(row.stale, false);
  assert.equal(row.supersededByOpen, false);
});

test('a changed quantity since the rejection is flagged', async () => {
  const db = fakeDb({
    live: { usage: [{ day: REVISION.day, ingredient_id: 1, qty: 9 }, { day: REVISION.day, ingredient_id: 2, qty: 6 }] },
  });
  assert.equal((await only(await listRevisions(context(db)))).stale, true);
});

test('a changed headcount since the rejection is flagged', async () => {
  const db = fakeDb({
    live: { sheet: { day: REVISION.day, inhouse_guests: 41, outside_guests: 2, note: null } },
  });
  assert.equal((await only(await listRevisions(context(db)))).stale, true);
});

test('an item recorded since, that the snapshot never had, is flagged', async () => {
  const db = fakeDb({
    live: {
      usage: [
        { day: REVISION.day, ingredient_id: 1, qty: 4 },
        { day: REVISION.day, ingredient_id: 2, qty: 6 },
        { day: REVISION.day, ingredient_id: 3, qty: 2 },
      ],
    },
  });
  assert.equal((await only(await listRevisions(context(db)))).stale, true);
});

test('a newer waiting change is reported on the rejected one', async () => {
  const db = fakeDb({ open: true });
  assert.equal((await only(await listRevisions(context(db)))).supersededByOpen, true);
});

test('pending rows carry neither flag — they are the live question', async () => {
  const db = fakeDb({ rows: [{ ...REVISION, status: 'pending' }] });
  const row = await only(await listRevisions(context(db, { status: 'pending' })));

  assert.equal(row.stale, undefined);
  assert.equal(row.supersededByOpen, undefined);
});
