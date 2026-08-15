import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getRoster, reopenRoster, saveChecks, saveRoster } from '../src/routes/housekeeping.js';

/**
 * Confirming last night, and what that settles.
 *
 * The roster for a night is a plan until the next morning: cancellations and
 * walk-ins arrive all day. So while a night is open, correcting it has to reach
 * the rounds already judged against it — otherwise the eight o'clock check is
 * measured against a roster written after it, which is the problem this whole
 * shape exists to fix. Once the night is confirmed it stops moving for good.
 *
 * A real SQLite database rather than a stub: the point of these is what ends up
 * in the rows.
 */

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));
  // The seed carries the standing roster over as last night and tonight, which
  // would put rows on days these tests are about. Start from nothing.
  sqlite.exec('DELETE FROM hk_roster');

  const beds = sqlite.prepare('SELECT id FROM hk_beds ORDER BY id LIMIT 3').all().map((b) => b.id);

  const db = {
    prepare(sql) {
      const st = { sql, binds: [] };
      st.bind = (...a) => { st.binds = a; return st; };
      st.all = async () => ({ results: sqlite.prepare(sql).all(...st.binds) });
      st.first = async () => sqlite.prepare(sql).get(...st.binds) ?? null;
      st.run = async () => {
        const r = sqlite.prepare(sql).run(...st.binds);
        return { meta: { changes: Number(r.changes ?? 0) } };
      };
      return st;
    },
    async batch(stmts) { for (const s of stmts) await s.run(); },
  };

  const ctx = (body, { permissions = ['hk_roster'], name = 'Ama', query = '' } = {}) => ({
    db,
    env: { APP_SITE: 'housekeeping' },
    session: { user: { id: 1, name, role: 'receptionist' }, permissions },
    url: new URL(`https://x/api/hk/roster${query}`),
    request: new Request('https://x/api/hk/roster', body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });

  const setRoster = async (day, states, opts = {}) => read(await saveRoster(ctx({
    day,
    confirm: opts.confirm === true,
    beds: beds.map((id, i) => ({ bedId: id, expected: states[i] ?? null })),
  }, opts)));

  const checkOf = (day, slot, bedId) => sqlite.prepare(
    'SELECT * FROM hk_checks WHERE day = ? AND slot = ? AND bed_id = ?',
  ).get(day, slot, bedId);

  return { sqlite, db, ctx, beds, setRoster, checkOf };
}

const read = async (response) => {
  const body = await response.json();
  if (response.status >= 400) throw new Error(body.error);
  return body;
};

/**
 * Record a round, the way a phone does.
 *
 * As a manager, because these tests choose which round to walk and the suite
 * cannot choose what hour it runs at — the shift rules are tested in
 * slots.test.js and housekeeping-routes.test.js.
 */
async function walk({ db, beds }, day, slot, states, permissions = ['hk_check', 'hk_reports']) {
  const request = new Request('https://x/api/hk/checks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      day,
      slot,
      checks: beds.map((id, i) => ({
        bedId: id,
        state: states[i],
        nameTag: states[i] === 'occupied' ? true : undefined,
      })),
    }),
  });
  return read(await saveChecks({
    db,
    env: {},
    url: new URL('https://x/api/hk/checks'),
    session: { user: { name: 'Akosua', role: 'housekeeper' }, permissions },
    request,
  }));
}

// ---------------------------------------------------------------------------

test('the morning check is stamped with last night’s roster, not tonight’s', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['occupied', 'free', 'occupied']);
  await env.setRoster('2026-08-12', ['free', 'free', 'occupied']);

  await walk(env, '2026-08-12', 'morning', ['occupied', 'free', 'occupied']);

  assert.equal(env.checkOf('2026-08-12', 'morning', env.beds[0]).expected_state, 'occupied',
    'bed 1 was sold last night, even though tonight it is free');

  await walk(env, '2026-08-12', 'evening', ['free', 'free', 'occupied']);
  assert.equal(env.checkOf('2026-08-12', 'evening', env.beds[0]).expected_state, 'free',
    'the evening check is judged against tonight');
});

test('a guest who checked out is not reported as a bed found empty', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['occupied', null, null]);
  await env.setRoster('2026-08-12', ['free', null, null]);

  // Eleven in the morning, the guest has gone and nobody has arrived.
  await walk(env, '2026-08-12', 'housekeeping', ['free', 'free', 'free']);
  assert.equal(env.checkOf('2026-08-12', 'housekeeping', env.beds[0]).expected_state, null,
    'a bed changing hands is judged by neither night');
});

test('correcting an open night reaches the round already judged against it', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['free', 'free', 'free']);

  // Eight o'clock: a bed nobody had a booking for is found occupied.
  await walk(env, '2026-08-12', 'morning', ['occupied', 'free', 'free']);
  assert.equal(env.checkOf('2026-08-12', 'morning', env.beds[0]).expected_state, 'free');

  // Nine o'clock: the front desk remembers the walk-in at eleven last night.
  const result = await env.setRoster('2026-08-11', ['occupied', 'free', 'free']);
  assert.ok(result.restamped >= 1, 'the morning check has to be brought back into line');
  assert.equal(env.checkOf('2026-08-12', 'morning', env.beds[0]).expected_state, 'occupied',
    'so the guest who paid stops being reported as a stranger');
});

test('confirming a night settles it, and nothing moves afterwards', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['occupied', 'free', 'free']);
  await walk(env, '2026-08-12', 'morning', ['occupied', 'free', 'free']);

  await env.setRoster('2026-08-11', ['occupied', 'free', 'free'], { confirm: true });

  const row = env.sqlite.prepare('SELECT * FROM hk_roster WHERE day = ? LIMIT 1').get('2026-08-11');
  assert.ok(row.confirmed_at, 'the night is stamped');
  assert.equal(row.confirmed_by, 'Ama');

  await assert.rejects(
    () => env.setRoster('2026-08-11', ['free', 'free', 'free']),
    /confirmed by Ama/,
    'the front desk cannot rewrite a settled night',
  );
  assert.equal(env.checkOf('2026-08-12', 'morning', env.beds[0]).expected_state, 'occupied');
});

test('a manager can reopen a night confirmed too early', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['occupied', 'free', 'free'], { confirm: true });

  // Somebody with setup can push through the confirmation...
  await env.setRoster('2026-08-11', ['free', 'free', 'free'], { permissions: ['hk_setup'] });
  // ...and can lift it entirely, for the late checkout heard about at ten.
  const reopened = await read(await reopenRoster(env.ctx(undefined, { permissions: ['hk_setup'] }), '2026-08-11'));
  assert.ok(reopened.beds >= 1);

  const row = env.sqlite.prepare('SELECT * FROM hk_roster WHERE day = ? LIMIT 1').get('2026-08-11');
  assert.equal(row.confirmed_at, null);
  await env.setRoster('2026-08-11', ['occupied', 'free', 'free']);
});

test('the roster screen is handed both nights at once', async () => {
  const env = setup();
  await env.setRoster('2026-08-11', ['occupied', 'free', null]);
  await env.setRoster('2026-08-12', ['free', 'occupied', null]);

  const view = await read(await getRoster(env.ctx(undefined, { query: '?day=2026-08-12' })));
  assert.equal(view.day, '2026-08-12');
  assert.equal(view.previousDay, '2026-08-11');
  assert.equal(view.lastNightConfirmed, null, 'nobody has closed it off yet');

  const bed = view.rooms[0].beds[0];
  assert.equal(bed.lastNight, 'occupied');
  assert.equal(bed.tonight, 'free');
});

test('a night nobody wrote a roster for is carried forward, and says so', async () => {
  const env = setup();
  await env.setRoster('2026-08-10', ['occupied', 'free', null]);

  const view = await read(await getRoster(env.ctx(undefined, { query: '?day=2026-08-13' })));
  assert.equal(view.tonightFrom, '2026-08-10', 'the screen names where it came from');
  assert.equal(view.rooms[0].beds[0].tonight, 'occupied');

  // And a check that night is judged by it rather than by nothing at all.
  await walk(env, '2026-08-13', 'evening', ['free', 'free', 'free']);
  assert.equal(env.checkOf('2026-08-13', 'evening', env.beds[0]).expected_state, 'occupied');
});
