import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { bootstrap } from '../src/routes/housekeeping.js';

/**
 * What the check screen is actually handed.
 *
 * The rule is enforced in the analytics layer and tested there; this is the
 * other half of it — that the data never reaches the phone in the first place.
 * A round filtered out of the interface but present in the response is a round
 * anybody can read with the browser's own tools, and "hidden" would be a
 * decoration rather than a fact.
 */

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));

  const bed = sqlite.prepare('SELECT id FROM hk_beds ORDER BY id LIMIT 1').get().id;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Accra', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // All three rounds walked and submitted today, so nothing is hidden merely
  // for being empty.
  let id = 0;
  for (const slot of ['morning', 'housekeeping', 'evening']) {
    id += 1;
    sqlite.prepare(
      "INSERT INTO hk_rounds (id, day, slot, submitted_at, submitted_by) VALUES (?,?,?,datetime('now'),?)",
    ).run(id, today, slot, `${slot} person`);
    sqlite.prepare(
      'INSERT INTO hk_checks (round_id, day, slot, bed_id, state) VALUES (?,?,?,?,?)',
    ).run(id, today, slot, bed, 'free');
  }

  const db = {
    prepare(sql) {
      const st = { sql, binds: [] };
      st.bind = (...a) => { st.binds = a; return st; };
      st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
      st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
      st.run = async () => sqlite.prepare(sql).run(...st.binds);
      return st;
    },
    async batch(stmts) { for (const s of stmts) await s.run(); },
  };

  const view = async (role, { permissions = ['hk_check'], query = '' } = {}) => {
    const response = await bootstrap({
      db,
      env: { APP_SITE: 'housekeeping' },
      session: { user: { id: 1, name: 'Kofi', role }, permissions },
      url: new URL(`https://x/api/hk/bootstrap${query}`),
      request: new Request('https://x/api/hk/bootstrap'),
    });
    return response.json();
  };

  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra', hour: '2-digit', hour12: false,
  }).format(new Date()));

  return { view, today, hour };
}

const slotsIn = (data) => data.rounds.map((r) => r.slot);

test('a receptionist is handed one round: the one their shift is on', async () => {
  const { view, hour } = setup();
  const data = await view('receptionist');

  assert.deepEqual(slotsIn(data), [hour < 14 ? 'morning' : 'evening']);
  assert.equal(data.slot, hour < 14 ? 'morning' : 'evening');
  // Not the housekeeping round, and not the other shift's — including the
  // submitter's name and the counts behind them.
  assert.ok(!JSON.stringify(data.rounds).includes('housekeeping person'));
});

test('a housekeeper is handed theirs, and only theirs', async () => {
  const { view } = setup();
  const data = await view('housekeeper');
  assert.deepEqual(slotsIn(data), ['housekeeping']);
  assert.equal(data.slot, 'housekeeping');
});

test('asking for somebody else’s round by hand does not produce it', async () => {
  const { view } = setup();
  // The screen would never offer this; a URL can still be typed.
  const data = await view('receptionist', { query: '?slot=housekeeping' });

  assert.notEqual(data.slot, 'housekeeping', 'it lands on their own round instead');
  assert.deepEqual(slotsIn(data).filter((s) => s === 'housekeeping'), []);
});

test('a manager is handed all three', async () => {
  const { view } = setup();
  const data = await view('housekeeping_manager', { permissions: ['hk_check', 'hk_reports'] });
  assert.deepEqual(slotsIn(data), ['morning', 'housekeeping', 'evening']);
});

test('a past day is bounded the same way as today', async () => {
  // Yesterday's morning check belongs to the morning shift. The afternoon desk
  // opening an old day still sees only afternoon checks — a finished round with
  // somebody else's name on it is not theirs to tidy up, whichever day it is on.
  const { view, hour } = setup();
  const data = await view('receptionist', { query: '?day=2026-08-01' });
  assert.deepEqual(slotsIn(data), [hour < 14 ? 'morning' : 'evening']);
});

test('the earlier rounds at the foot of the screen keep the same boundary', async () => {
  // That list is the way back into a past round, so it is bounded exactly as
  // the tabs are: your own shift's rounds, and nobody else's.
  const { view, hour } = setup();
  const mine = hour < 14 ? 'morning' : 'evening';

  const desk = await view('receptionist');
  assert.ok(desk.recent.every((r) => r.slot === mine),
    'only the shift they are on, on every day it lists');

  const housekeeper = await view('housekeeper');
  assert.ok(housekeeper.recent.every((r) => r.slot === 'housekeeping'));

  // A manager keeps the lot: they are the way anything in another shift's
  // round gets put right.
  const boss = await view('housekeeping_manager', { permissions: ['hk_check', 'hk_reports'] });
  assert.equal(new Set(boss.recent.map((r) => r.slot)).size, 3);
});
