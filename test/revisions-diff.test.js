import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listRevisions } from '../src/routes/revisions.js';

/**
 * What an approver is shown about an amended breakfast sheet.
 *
 * The decision they are making is whether the day should read differently, and
 * a bare before/after table leaves them to work out the two things that
 * actually matter: whether accepting it costs the hotel more or less, and
 * whether anything appeared or disappeared rather than merely moving.
 *
 * Both are easy to get quietly wrong — a cost added up the wrong way is still
 * a plausible-looking number — so they are pinned here.
 */

const INGREDIENTS = [
  { id: 1, name: 'Eggs', unit: 'pcs', default_unit_cost: 2 },
  { id: 2, name: 'Bread', unit: 'loaf', default_unit_cost: 10 },
  { id: 3, name: 'Butter', unit: 'kg', default_unit_cost: 40 },
];

// Eggs have been bought since, so the price paid wins over the fallback.
const PURCHASES = [{ ingredient_id: 1, unit_cost: 3, day: '2026-08-01', supplier: 'Mensah' }];

function fakeDb({ previous, payload, status = 'pending', purchases = PURCHASES }) {
  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM day_revisions WHERE status = 'pending'/.test(sql)) return { results: [] };
      if (/FROM day_revisions/.test(sql)) {
        return {
          results: [{
            id: 7,
            day: '2026-08-10',
            status,
            payload: JSON.stringify(payload),
            previous: JSON.stringify(previous),
            submitted_by: 'Kofi',
            submitted_at: '2026-08-10T09:00:00',
          }],
        };
      }
      if (/FROM ingredients/.test(sql)) return { results: INGREDIENTS };
      if (/FROM purchases/.test(sql)) return { results: purchases };
      return { results: [] };
    },
    async first() { return null; },
    async run() { return { success: true }; },
  });
  return { prepare: (sql) => statement(sql), async batch() { return []; } };
}

const context = (db) => ({
  db,
  env: {},
  url: new URL('https://example.com/api/revisions?status=pending'),
  session: { user: { name: 'Ama', role: 'admin' } },
  request: new Request('https://example.com/api/revisions'),
});

async function only(db) {
  const res = await listRevisions(context(db));
  return (await res.json()).revisions[0];
}

const byName = (rev, name) => rev.changes.find((c) => c.label === name);

// ------------------------------------------------------ added and removed --

test('an item nobody recorded is marked as added, not as a figure that moved', async () => {
  // "We did not use this" and "nobody wrote it down" are the same quantity and
  // a different claim, and the claim is what is being approved.
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10, 3: 2 } },
  }));

  assert.equal(byName(rev, 'Butter').change, 'added');
  assert.equal(rev.summary.added, 1);
  assert.equal(rev.summary.changed, 0);
});

test('an item taken off the sheet is marked as removed', async () => {
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10, 3: 2 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10 } },
  }));

  assert.equal(byName(rev, 'Butter').change, 'removed');
  assert.equal(rev.summary.removed, 1);
});

// ------------------------------------------------------------------ cost --

test('the cost effect uses the last price paid, not the fallback', async () => {
  // Eggs were bought at 3; the ingredient's own default says 2. The reports
  // use what was actually paid, so this must agree with them.
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 14 } },
  }));

  assert.equal(byName(rev, 'Eggs').costDelta, 12, 'four more eggs at 3');
  assert.equal(rev.summary.costDelta, 12);
});

test('an item never bought falls back to its own cost', async () => {
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 2: 1 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 2: 3 } },
  }));

  assert.equal(byName(rev, 'Bread').costDelta, 20, 'two more loaves at 10');
});

test('rises and falls net off into one figure', async () => {
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10, 2: 4 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 20, 2: 2 } },
  }));

  // +10 eggs at 3 = +30, −2 loaves at 10 = −20.
  assert.equal(rev.summary.costDelta, 10);
});

test('an added item costs its whole amount, not the difference from nothing', async () => {
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: {} },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 3: 2 } },
  }));

  assert.equal(byName(rev, 'Butter').costDelta, 80, 'two kilos at 40');
});

test('no cost is claimed where nothing carries a price', async () => {
  // A confident zero and "we cannot say" look identical on a screen, and only
  // one of them is true.
  const db = fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: {} },
    payload: { inhouse_guests: 34, outside_guests: 0, usage: {} },
    purchases: [],
  });
  const rev = await only(db);

  assert.equal(rev.summary.costDelta, null);
  assert.equal(rev.summary.guestDelta, 4);
});

// --------------------------------------------------------------- ordering --

test('the biggest change by money comes first, whatever the units', async () => {
  // Sorted by raw quantity, two hundred eggs outranked five kilos of butter.
  // Money is the only measure that means the same thing across both.
  const rev = await only(fakeDb({
    previous: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10, 3: 1 } },
    payload: { inhouse_guests: 30, outside_guests: 0, usage: { 1: 15, 3: 6 } },
  }));

  const usage = rev.changes.filter((c) => c.kind === 'usage');
  assert.equal(usage[0].label, 'Butter', '5kg at 40 beats 5 eggs at 3');
  assert.equal(usage[1].label, 'Eggs');
});

// --------------------------------------------------------------- summary --

test('the summary counts each kind of change separately', async () => {
  const rev = await only(fakeDb({
    previous: {
      inhouse_guests: 30, outside_guests: 2, note: 'as usual', usage: { 1: 10, 2: 4 },
    },
    payload: {
      inhouse_guests: 36, outside_guests: 2, note: 'two coach parties', usage: { 1: 12, 3: 1 },
    },
  }));

  assert.deepEqual(
    {
      changed: rev.summary.changed,
      added: rev.summary.added,
      removed: rev.summary.removed,
      guestDelta: rev.summary.guestDelta,
      noteChanged: rev.summary.noteChanged,
    },
    { changed: 1, added: 1, removed: 1, guestDelta: 6, noteChanged: true },
  );
});

test('a sheet that differs in nothing says so rather than showing an empty table', async () => {
  const same = { inhouse_guests: 30, outside_guests: 0, usage: { 1: 10 } };
  const rev = await only(fakeDb({ previous: same, payload: { ...same } }));

  assert.equal(rev.changes.length, 0);
  assert.equal(rev.summary.costDelta, null);
});
