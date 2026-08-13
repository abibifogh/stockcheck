import { test } from 'node:test';
import assert from 'node:assert/strict';

import { saveChecks } from '../src/routes/housekeeping.js';
import { HttpError } from '../src/lib/http.js';

/**
 * The rules that live at the edge of the bed check rather than in its
 * analytics: what the server will and will not accept from a phone.
 *
 * A stub database rather than a real one — these are about the shape of what
 * gets written, and the statements are recorded so the test can read them.
 */

const BEDS = [
  { id: 1, label: 'Bed 1', expected_state: 'occupied', active: 1 },
  { id: 2, label: 'Bed 2', expected_state: 'free', active: 1 },
  { id: 3, label: 'Bed 3', expected_state: null, active: 1 },
  // Sits in a room that has been closed, so the query that folds the room's
  // state into the bed's reports it as inactive.
  { id: 9, label: 'Bed 1', expected_state: null, active: 0 },
];

function fakeDb({ beds = BEDS, round = { id: 7, day: '2026-08-10', submitted_at: null } } = {}) {
  const written = [];

  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM hk_beds/.test(sql)) return { results: beds };
      if (/FROM settings/.test(sql)) return { results: [{ value: 'Africa/Accra' }] };
      return { results: [] };
    },
    async first() {
      if (/FROM hk_rounds/.test(sql)) return round;
      if (/AS checked/.test(sql)) return { checked: 3, occupied: 2, untagged: 1 };
      return null;
    },
    async run() { written.push({ sql, binds: this.binds }); return { success: true }; },
  });

  return {
    written,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      for (const s of statements) written.push({ sql: s.sql, binds: s.binds });
    },
  };
}

function context(body, db = fakeDb()) {
  return {
    db,
    env: {},
    url: new URL('https://example.test/api/hk/checks'),
    session: { user: { name: 'Akosua', role: 'housekeeper' }, permissions: ['hk_check'] },
    request: new Request('https://example.test/api/hk/checks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

/** The rows the batch actually wrote to hk_checks. */
function savedChecks(db) {
  return db.written.filter((w) => /INSERT INTO hk_checks/.test(w.sql)).map((w) => ({
    roundId: w.binds[0],
    day: w.binds[1],
    slot: w.binds[2],
    bedId: w.binds[3],
    state: w.binds[4],
    nameTag: w.binds[5],
    expected: w.binds[6],
    note: w.binds[7],
    by: w.binds[8],
  }));
}

/** The round the save opened or reused. */
function openedRound(db) {
  const row = db.written.find((w) => /INSERT INTO hk_rounds/.test(w.sql));
  return row ? { day: row.binds[0], slot: row.binds[1] } : null;
}

test('an occupied bed must answer the name tag question, by name', async () => {
  const ctx = context({ day: '2026-08-10', checks: [{ bedId: 1, state: 'occupied' }] });

  await assert.rejects(saveChecks(ctx), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    // Naming the bed is the difference between a message somebody can act on
    // and one they have to go hunting for.
    assert.match(err.message, /Bed 1/);
    return true;
  });
});

test('a free bed stores no answer to a question it was never asked', async () => {
  const db = fakeDb();
  const response = await saveChecks(context({
    day: '2026-08-10',
    checks: [{ bedId: 3, state: 'free' }],
  }, db));

  assert.equal(response.status, 200);
  const [saved] = savedChecks(db);
  assert.equal(saved.state, 'free');
  assert.equal(saved.nameTag, null, 'null, not 0 — an empty bed has no missing tag');
  assert.equal(saved.by, 'Akosua');
});

test('the roster is copied onto the check as it stands at the moment of the round', async () => {
  const db = fakeDb();
  await saveChecks(context({
    day: '2026-08-10',
    slot: 'evening',
    checks: [
      { bedId: 1, state: 'occupied', nameTag: true },
      { bedId: 2, state: 'occupied', nameTag: false, note: 'someone is in it' },
      { bedId: 3, state: 'free' },
    ],
  }, db));

  const saved = savedChecks(db);
  assert.deepEqual(saved.map((s) => s.expected), ['occupied', 'free', null]);
  assert.deepEqual(saved.map((s) => s.nameTag), [1, 0, null]);
  assert.equal(saved[1].note, 'someone is in it');
  assert.ok(saved.every((s) => s.roundId === 7 && s.day === '2026-08-10'));
});

// ------------------------------------------------------------- the rounds --

test('a save opens the round it names, and stamps it onto every check', async () => {
  const db = fakeDb();
  await saveChecks(context({
    day: '2026-08-10', slot: 'evening', checks: [{ bedId: 3, state: 'free' }],
  }, db));

  assert.deepEqual(openedRound(db), { day: '2026-08-10', slot: 'evening' });
  assert.equal(savedChecks(db)[0].slot, 'evening');
});

test('each of the three checks is its own round on the same day', async () => {
  for (const slot of ['morning', 'housekeeping', 'evening']) {
    const db = fakeDb();
    await saveChecks(context({ day: '2026-08-10', slot, checks: [{ bedId: 3, state: 'free' }] }, db));
    assert.equal(openedRound(db).slot, slot);
    assert.equal(savedChecks(db)[0].slot, slot);
  }
});

test('a check that names no round falls to the one the clock is in', async () => {
  const db = fakeDb();
  await saveChecks(context({ day: '2026-08-10', checks: [{ bedId: 3, state: 'free' }] }, db));

  // Whichever it picked, it must be a real one rather than blank — a check
  // filed against nothing would vanish from every report.
  const { slot } = openedRound(db);
  assert.ok(['morning', 'housekeeping', 'evening'].includes(slot), `picked ${slot}`);
  assert.equal(savedChecks(db)[0].slot, slot);
});

test('a round nobody recognises is refused rather than invented', async () => {
  const db = fakeDb();
  await saveChecks(context({
    day: '2026-08-10', slot: 'midnight-snack', checks: [{ bedId: 3, state: 'free' }],
  }, db));

  // An unknown name falls back to the clock rather than writing 'midnight-snack'
  // into a column every report groups by.
  assert.ok(['morning', 'housekeeping', 'evening'].includes(openedRound(db).slot));
});

test('a bed in a closed room is not something to answer for', async () => {
  await assert.rejects(
    saveChecks(context({ day: '2026-08-10', checks: [{ bedId: 9, state: 'free' }] })),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /no longer on the list/);
      return true;
    },
  );
});

test('a bed that does not exist is refused rather than written against nothing', async () => {
  await assert.rejects(
    saveChecks(context({ day: '2026-08-10', checks: [{ bedId: 404, state: 'free' }] })),
    (err) => err.status === 400,
  );
});

test('a state that is neither occupied nor free is refused', async () => {
  await assert.rejects(
    saveChecks(context({ day: '2026-08-10', checks: [{ bedId: 1, state: 'maybe' }] })),
    (err) => {
      assert.match(err.message, /occupied or free/);
      return true;
    },
  );
});

test('a round cannot be recorded for a day that has not happened', async () => {
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  await assert.rejects(
    saveChecks(context({ day: future, checks: [{ bedId: 3, state: 'free' }] })),
    (err) => {
      assert.match(err.message, /future/);
      return true;
    },
  );
});

test('an empty save is refused rather than opening an empty round', async () => {
  const db = fakeDb();
  await assert.rejects(saveChecks(context({ day: '2026-08-10', checks: [] }, db)), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(db.written.length, 0, 'nothing should have been written at all');
});
