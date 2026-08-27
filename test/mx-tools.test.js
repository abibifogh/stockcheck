import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chaseOverdueTools, dueBackAt, graceHours, overdueBy } from '../src/lib/tools.js';
import { issue, markReturned, retire } from '../src/routes/mx-tools.js';

/**
 * Tools that go out and come back.
 *
 * The chasing is where this kind of job goes wrong, and it goes wrong quietly:
 * telling somebody once an hour until a drill reappears teaches them to ignore
 * the bell, and telling them never is the same as not having built it. Both
 * failures look like silence from the outside, so they are pinned here.
 */

// ------------------------------------------------------------ the clock --

test('the grace period defaults to a day, and survives nonsense', () => {
  assert.equal(graceHours({ mx_tool_hours: '24' }), 24);
  assert.equal(graceHours({ mx_tool_hours: '8' }), 8);
  assert.equal(graceHours({}), 24, 'unset is a day');
  assert.equal(graceHours({ mx_tool_hours: 'soon' }), 24);
  assert.equal(graceHours({ mx_tool_hours: '0' }), 24, 'zero would chase everything instantly');
  assert.equal(graceHours({ mx_tool_hours: '-5' }), 24);
});

test('an absurd grace period is capped rather than obeyed', () => {
  // Somebody typing a year would never be told about anything again, which is
  // indistinguishable from the feature being broken.
  assert.equal(graceHours({ mx_tool_hours: '9000' }), 24 * 14);
});

test('due back is the issue time plus the grace period', () => {
  assert.equal(dueBackAt('2026-08-24 09:00:00', 24), '2026-08-25 09:00:00');
  assert.equal(dueBackAt('2026-08-24 09:00:00', 8), '2026-08-24 17:00:00');
});

test('due back crosses midnight and month ends correctly', () => {
  assert.equal(dueBackAt('2026-08-31 20:00:00', 24), '2026-09-01 20:00:00');
});

test('an unreadable issue time yields nothing rather than a wrong date', () => {
  assert.equal(dueBackAt('not a time', 24), null);
});

test('lateness is said in units somebody can act on', () => {
  // "51 hours" makes the reader do arithmetic before deciding whether to walk
  // down the corridor.
  assert.equal(overdueBy('2026-08-24 09:00:00', '2026-08-24 09:30:00'), 'just now');
  assert.equal(overdueBy('2026-08-24 09:00:00', '2026-08-24 12:00:00'), '3 hours');
  assert.equal(overdueBy('2026-08-24 09:00:00', '2026-08-24 10:00:00'), '1 hour');
  assert.equal(overdueBy('2026-08-24 09:00:00', '2026-08-26 12:00:00'), '2 days');
});

// ----------------------------------------------------------- the sweep --

const LATE = {
  id: 7,
  tool_id: 3,
  issued_to: 'Kofi',
  issued_at: '2026-08-23 08:00:00',
  due_back_at: '2026-08-24 08:00:00',
  tool_name: 'Impact drill',
  tag: 'MX-014',
  area_name: 'Room 214',
};

function fakeDb({ late = [LATE], settings = [] } = {}) {
  const written = [];
  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM settings/.test(sql)) return { results: settings };
      if (/FROM mx_tool_movements/.test(sql)) return { results: late };
      if (/FROM users/.test(sql)) return { results: [] };
      return { results: [] };
    },
    async first() { return null; },
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

const wrote = (db, re) => db.written.filter((w) => re.test(w.sql));

test('a tool still out past its time is chased', async () => {
  const db = fakeDb();
  const result = await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  assert.equal(result.chased, 1);
  assert.deepEqual(result.tools[0], { id: 3, name: 'Impact drill', issuedTo: 'Kofi' });
});

test('it is marked as told, so the next sweep says nothing', async () => {
  // The whole difference between a useful notice and an hourly nag.
  const db = fakeDb();
  await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  const [mark] = wrote(db, /UPDATE mx_tool_movements SET overdue_notified_at/);
  assert.deepEqual(mark.binds, ['2026-08-24 12:00:00', 7]);
  assert.match(mark.sql, /overdue_notified_at IS NULL/, 'and only if nobody else marked it first');
});

test('the mark is written before the telling, not after', async () => {
  // A notification that throws must not leave the row unmarked; being chased
  // twice about one drill is how people learn to ignore the bell.
  const db = fakeDb();
  await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  const markAt = db.written.findIndex((w) => /overdue_notified_at =/.test(w.sql));
  const noticeAt = db.written.findIndex((w) => /INSERT INTO app_notices/.test(w.sql));
  assert.ok(markAt !== -1, 'it is marked');
  if (noticeAt !== -1) assert.ok(markAt < noticeAt, 'and marked first');
});

test('nothing late means nothing written', async () => {
  const db = fakeDb({ late: [] });
  const result = await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  assert.equal(result.chased, 0);
  assert.equal(wrote(db, /UPDATE mx_tool_movements/).length, 0);
});

test('the sweep can be switched off', async () => {
  const db = fakeDb({ settings: [{ key: 'notify_tool_overdue', value: '0' }] });
  const result = await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  assert.equal(result.chased, 0);
  assert.equal(db.written.length, 0, 'and it does not even look');
});

test('the query asks only for what is out, late and unmentioned', async () => {
  const db = fakeDb();
  let asked = '';
  const inner = db.prepare;
  db.prepare = (sql) => { if (/FROM mx_tool_movements/.test(sql)) asked = sql; return inner(sql); };
  await chaseOverdueTools(db, {}, '2026-08-24 12:00:00');

  assert.match(asked, /returned_at IS NULL/);
  assert.match(asked, /overdue_notified_at IS NULL/);
  assert.match(asked, /due_back_at <= \?/);
});

// ------------------------------------------------------ out and back --

function routeDb({ tool = { id: 3, name: 'Impact drill', active: 1 }, trip = null, issueFails = null } = {}) {
  const written = [];
  const statement = (sql) => ({
    sql,
    binds: [],
    bind(...args) { this.binds = args; return this; },
    async all() {
      if (/FROM settings/.test(sql)) return { results: [{ key: 'mx_tool_hours', value: '24' }] };
      return { results: [] };
    },
    async first() {
      if (/FROM mx_tools/.test(sql)) return tool;
      if (/FROM mx_tool_movements/.test(sql)) return trip;
      if (/FROM mx_areas/.test(sql)) return { id: 2 };
      return null;
    },
    async run() {
      if (issueFails && /INSERT INTO mx_tool_movements/.test(sql)) throw new Error(issueFails);
      written.push({ sql, binds: this.binds });
      return { success: true, meta: { changes: 1 } };
    },
  });
  return { written, prepare: (sql) => statement(sql), async batch() { return []; } };
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

test('issuing records who, where and when it is due', async () => {
  const db = routeDb();
  await issue(ctx(db, { issuedTo: 'Kofi', areaId: 2 }), 3);

  const [move] = wrote(db, /INSERT INTO mx_tool_movements/);
  assert.equal(move.binds[0], 3, 'the tool');
  assert.equal(move.binds[1], 2, 'the area');
  assert.equal(move.binds[2], 'Kofi', 'who took it');
  assert.equal(move.binds[3], 'Ama', 'who handed it over');
  assert.equal(dueBackAt(move.binds[4], 24), move.binds[5], 'due back is a day after out');
});

test('a tool already out is refused by name, not by a server error', async () => {
  // The partial unique index does the work; this is how it reaches a person.
  const db = routeDb({ issueFails: 'UNIQUE constraint failed: idx_mx_tool_out' });
  await assert.rejects(
    () => issue(ctx(db, { issuedTo: 'Yaa' }), 3),
    /Impact drill is already out/,
  );
});

test('nobody to issue it to is refused', async () => {
  const db = routeDb();
  await assert.rejects(() => issue(ctx(db, { issuedTo: '' }), 3), /required/i);
});

test('returning closes the open trip and nothing else', async () => {
  const db = routeDb({ trip: { id: 7, issued_to: 'Kofi', overdue_notified_at: null } });
  await markReturned(ctx(db, { returnNote: 'chuck is loose' }), 3);

  const [update] = wrote(db, /UPDATE mx_tool_movements/);
  assert.match(update.sql, /returned_at IS NULL/, 'only a trip that is still open');
  assert.equal(update.binds[1], 'Ama', 'who took it back in');
  assert.equal(update.binds[2], 'chuck is loose');
  assert.equal(update.binds[3], 7);
});

test('returning something that is not out says so', async () => {
  const db = routeDb({ trip: null });
  await assert.rejects(() => markReturned(ctx(db, {}), 3), /not out/);
});

test('a tool that is out cannot be retired', async () => {
  // Retiring it would strand the trip, and the drill is still in a van.
  const db = routeDb({ trip: { id: 7, issued_to: 'Kofi' } });
  await assert.rejects(() => retire(ctx(db, {}), 3), /still out with Kofi/);
  assert.equal(wrote(db, /UPDATE mx_tools/).length, 0);
});

test('retiring keeps the tool and its journeys', async () => {
  const db = routeDb({ trip: null });
  await retire(ctx(db, {}), 3);

  const [update] = wrote(db, /UPDATE mx_tools/);
  assert.match(update.sql, /SET active = 0/, 'retired, never deleted');
  assert.equal(wrote(db, /DELETE FROM mx_tool/).length, 0);
});
