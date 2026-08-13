import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { dataSummary, eraseData } from '../src/routes/admin.js';

/**
 * Erasing a chosen period.
 *
 * The one action in this system with no undo, so what it promises and what it
 * does have to be the same thing: the count the screen shows before you commit
 * is produced by the same columns the delete uses, and these hold them
 * together.
 */

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  sqlite.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));

  const beds = sqlite.prepare('SELECT id FROM hk_beds LIMIT 4').all().map((b) => b.id);
  let round = 0;
  for (const day of ['2026-08-01', '2026-08-05', '2026-08-10']) {
    for (const slot of ['morning', 'housekeeping', 'evening']) {
      round += 1;
      sqlite.prepare('INSERT INTO hk_rounds (id, day, slot) VALUES (?,?,?)').run(round, day, slot);
      for (const bed of beds) {
        sqlite.prepare(
          'INSERT INTO hk_checks (round_id, day, slot, bed_id, state) VALUES (?,?,?,?,?)',
        ).run(round, day, slot, bed, 'free');
      }
    }
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

  const ctx = (body, params = '') => ({
    db,
    env: { APP_SITE: 'housekeeping' },
    session: { user: { id: 1, name: 'Boss', role: 'admin' }, permissions: ['users'] },
    url: new URL(`https://x/api${params}`),
    request: new Request('https://x/api', body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
  });

  const counts = () => sqlite.prepare(
    `SELECT (SELECT COUNT(*) FROM hk_rounds) AS rounds,
            (SELECT COUNT(*) FROM hk_checks) AS checks,
            (SELECT COUNT(*) FROM hk_rooms)  AS rooms,
            (SELECT COUNT(*) FROM hk_beds)   AS beds`,
  ).get();

  return { sqlite, ctx, counts };
}

const read = async (response) => {
  const body = await response.json();
  if (response.status >= 400) throw new Error(body.error);
  return body;
};

test('the count shown before erasing is what erasing actually removes', async () => {
  const { ctx, counts } = setup();
  assert.deepEqual(
    { rounds: counts().rounds, checks: counts().checks },
    { rounds: 9, checks: 36 },
  );

  const preview = await read(await dataSummary(ctx(undefined, '?from=2026-08-04&to=2026-08-06')));
  assert.equal(preview.inRange.rounds, 3);
  assert.equal(preview.inRange.bed_checks, 12);

  const result = await read(await eraseData(ctx({
    confirm: 'ERASE', scope: 'records', from: '2026-08-04', to: '2026-08-06',
  })));

  // The promise and the deed, from the same columns.
  assert.equal(result.removed.rounds, preview.inRange.rounds);
  assert.equal(result.removed.bed_checks, preview.inRange.bed_checks);
});

test('only the chosen period goes', async () => {
  const { sqlite, ctx } = setup();
  await read(await eraseData(ctx({
    confirm: 'ERASE', scope: 'records', from: '2026-08-04', to: '2026-08-06',
  })));

  const left = sqlite.prepare('SELECT DISTINCT day FROM hk_rounds ORDER BY day').all().map((r) => r.day);
  assert.deepEqual(left, ['2026-08-01', '2026-08-10'], 'the days either side must survive');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM hk_checks WHERE day = '2026-08-05'").get().n, 0);
});

test('erasing a period never touches the dorms, the people or the settings', async () => {
  const { ctx, counts } = setup();
  const before = counts();

  await read(await eraseData(ctx({ confirm: 'ERASE', scope: 'records', from: '2026-08-01', to: '2026-08-31' })));

  const after = counts();
  assert.equal(after.rounds, 0, 'every check in the range went');
  assert.equal(after.rooms, before.rooms, 'the dorm rooms are not activity');
  assert.equal(after.beds, before.beds, 'and neither are the beds');
});

test('a period cannot be combined with erasing the dorms themselves', async () => {
  const { ctx } = setup();
  await assert.rejects(
    eraseData(ctx({ confirm: 'ERASE', scope: 'everything', from: '2026-08-01' })),
    (err) => {
      // Worded for the site somebody is actually looking at.
      assert.match(err.message, /dorm rooms and beds/);
      return true;
    },
  );
});

test('the confirmation phrase is not optional', async () => {
  const { ctx, counts } = setup();
  await assert.rejects(
    eraseData(ctx({ confirm: 'yes', scope: 'records', from: '2026-08-01', to: '2026-08-31' })),
    /ERASE/,
  );
  assert.equal(counts().rounds, 9, 'nothing was deleted on a failed confirmation');
});

test('a date nobody can parse is refused rather than guessed at', async () => {
  const { ctx } = setup();
  await assert.rejects(dataSummary(ctx(undefined, '?from=last-tuesday')), /Invalid start date/);
  await assert.rejects(
    eraseData(ctx({ confirm: 'ERASE', scope: 'records', from: 'last-tuesday' })),
    /Invalid start date/,
  );
});

test('with no period chosen, the screen is told there is nothing to preview', async () => {
  const { ctx } = setup();
  const summary = await read(await dataSummary(ctx(undefined, '')));
  assert.equal(summary.inRange, null, 'null is what makes the screen say "everything"');
  assert.equal(summary.counts.rounds, 9);
  assert.equal(summary.site, 'housekeeping');
});
