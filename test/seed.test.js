import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * The paste-able schema files against the migrations they stand in for.
 *
 * There are two ways to set this system up — run the migrations, or paste
 * `seed/housekeeping-database.sql` into a console — and they must produce the
 * same database. If they drift, one group of installations quietly has a
 * different shape from the other, and every bug after that is unreproducible.
 *
 * Rebuild the files with `node scripts/build-seed.mjs` when a migration changes.
 */

const MIGRATIONS = readdirSync('migrations').sort();

/** The hand-paste upgrades, in the order a database part-way along needs them. */
const UPGRADE_FILES = [
  'housekeeping-upgrade-rounds.sql',
  'housekeeping-upgrade-notices.sql',
  'housekeeping-upgrade-notice-audience.sql',
];

function apply(db, files) {
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of files) db.exec(readFileSync(`migrations/${f}`, 'utf8'));
  return db;
}

/**
 * Every table and index, normalised down to what actually differs.
 *
 * Four things vary between the two routes without meaning anything: the
 * migrations keep their comments and the seed files strip them, a table that
 * has been rebuilt and renamed comes back with its name in quotes, the
 * whitespace is laid out differently, and a column added by ALTER is appended
 * to the stored DDL with its own spacing — "actor TEXT , audience TEXT)" where
 * a fresh CREATE writes "actor TEXT, audience TEXT )". None of that changes the
 * database.
 */
function shapeOf(db) {
  return db.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE name LIKE 'hk_%' OR name LIKE 'app_%' ORDER BY type, name`,
  ).all().map((r) => {
    const sql = String(r.sql)
      .split('\n').map((line) => line.split('--')[0]).join(' ')
      .replace(/"/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,)])/g, '$1')
      .replace(/\(\s+/g, '(')
      .trim();
    return `${r.type} ${r.name}: ${sql}`;
  });
}

test('the paste-able schema builds the same tables as running every migration', () => {
  const migrated = apply(new DatabaseSync(':memory:'), MIGRATIONS);
  const pasted = new DatabaseSync(':memory:');
  pasted.exec('PRAGMA foreign_keys = ON;');
  pasted.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));

  assert.deepEqual(shapeOf(pasted), shapeOf(migrated),
    'seed/housekeeping-database.sql has drifted — rebuild it with scripts/build-seed.mjs');
});

test('pasting it twice changes nothing', () => {
  const sql = readFileSync('seed/housekeeping-database.sql', 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(sql);
  const before = shapeOf(db);
  const rooms = db.prepare('SELECT COUNT(*) AS n FROM hk_rooms').get().n;
  const beds = db.prepare('SELECT COUNT(*) AS n FROM hk_beds').get().n;

  db.exec(sql);

  assert.deepEqual(shapeOf(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hk_rooms').get().n, rooms, 'the sample dorms doubled');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hk_beds').get().n, beds, 'the sample beds doubled');
});

test('a database can hold three rounds for one day, and no more of the same one', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));

  for (const slot of ['morning', 'housekeeping', 'evening']) {
    db.prepare('INSERT INTO hk_rounds (day, slot) VALUES (?, ?)').run('2026-08-13', slot);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hk_rounds WHERE day = '2026-08-13'").get().n, 3);

  assert.throws(
    () => db.prepare('INSERT INTO hk_rounds (day, slot) VALUES (?, ?)').run('2026-08-13', 'evening'),
    /UNIQUE/,
    'the same check twice in one day has to be refused, or two people overwrite each other',
  );
});

test('the schema file is refused by a database part-way along, and the upgrade file is not', () => {
  // The gap that bit a real setup: the schema file builds the destination and
  // skips whatever already exists, so on a database still holding the
  // one-check-a-day tables it leaves them alone and then fails on an index
  // naming a column they do not have. The upgrade file is what that database
  // needs, and nothing here should ever suggest otherwise.
  const old = () => apply(new DatabaseSync(':memory:'), MIGRATIONS.filter((f) => f < '0008'));

  assert.throws(
    () => old().exec(readFileSync('seed/housekeeping-database.sql', 'utf8')),
    /no such column: slot/,
    'if this stops throwing, the schema file has become safe to run on an old database — say so in the README',
  );

  // Every upgrade file, in order, is what a database part-way along needs — and
  // together they must land it exactly where a fresh one starts. If a later
  // migration adds another, this list is where it has to be named, and this
  // assertion is what says so.
  const upgraded = old();
  for (const file of UPGRADE_FILES) {
    upgraded.exec(readFileSync(`seed/${file}`, 'utf8'));
  }

  const fresh = new DatabaseSync(':memory:');
  fresh.exec('PRAGMA foreign_keys = ON;');
  fresh.exec(readFileSync('seed/housekeeping-database.sql', 'utf8'));

  assert.deepEqual(shapeOf(upgraded), shapeOf(fresh),
    'a database upgraded by hand must end up the same shape as one built fresh');
});

test('the notices upgrade can be run as often as you like', () => {
  // Unlike the rounds one it adds no columns, so a second paste is a no-op
  // rather than an error. Somebody will paste it twice.
  const db = apply(new DatabaseSync(':memory:'), MIGRATIONS.filter((f) => f < '0009'));
  const sql = readFileSync('seed/housekeeping-upgrade-notices.sql', 'utf8');

  db.exec(sql);
  const before = shapeOf(db);
  db.exec(sql);

  assert.deepEqual(shapeOf(db), before);
});

test('the upgrade file is the migration, so what holds for one holds for the other', () => {
  const viaMigration = apply(new DatabaseSync(':memory:'), MIGRATIONS.filter((f) => f < '0008'));
  viaMigration.exec(readFileSync('migrations/0008_check_rounds.sql', 'utf8'));

  const viaFile = apply(new DatabaseSync(':memory:'), MIGRATIONS.filter((f) => f < '0008'));
  viaFile.exec(readFileSync('seed/housekeeping-upgrade-rounds.sql', 'utf8'));

  assert.deepEqual(shapeOf(viaFile), shapeOf(viaMigration),
    'seed/housekeeping-upgrade-rounds.sql has drifted — rebuild it with scripts/build-seed.mjs');
});

test('upgrading an older database keeps the checks already recorded', () => {
  // The bug this guards: dropping hk_rounds to rebuild it performs an implicit
  // delete, and hk_checks cascades from it. A rebuild that looks careful takes
  // every check ever recorded with it, silently.
  const db = apply(new DatabaseSync(':memory:'), MIGRATIONS.filter((f) => f < '0008'));

  db.exec("INSERT INTO hk_rounds (day, submitted_at, submitted_by) VALUES ('2026-08-01','2026-08-01 10:00','Akosua')");
  const round = db.prepare("SELECT id FROM hk_rounds WHERE day = '2026-08-01'").get().id;
  for (const bed of db.prepare('SELECT id FROM hk_beds LIMIT 3').all()) {
    db.prepare(
      'INSERT INTO hk_checks (round_id, day, bed_id, state, name_tag, checked_by) VALUES (?,?,?,?,?,?)',
    ).run(round, '2026-08-01', bed.id, 'occupied', 0, 'Akosua');
  }

  db.exec(readFileSync('migrations/0008_check_rounds.sql', 'utf8'));

  const checks = db.prepare('SELECT day, slot, state, name_tag, checked_by FROM hk_checks').all();
  assert.equal(checks.length, 3, 'the recorded checks were lost in the rebuild');
  assert.ok(checks.every((c) => c.slot === 'morning'), 'a single daily check becomes the morning one');
  assert.ok(checks.every((c) => c.checked_by === 'Akosua'), 'and keeps who recorded it');

  const rounds = db.prepare('SELECT day, slot, submitted_by FROM hk_rounds').all();
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].day, '2026-08-01');
  assert.equal(rounds[0].slot, 'morning');
  assert.equal(rounds[0].submitted_by, 'Akosua', 'a submitted round stays submitted');

  // And the upgraded database can now take the other two rounds.
  db.prepare('INSERT INTO hk_rounds (day, slot) VALUES (?,?)').run('2026-08-01', 'evening');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM hk_rounds WHERE day='2026-08-01'").get().n, 2);
});

test('every file the database workflow offers actually exists', () => {
  // The button fails at the worst possible moment otherwise — after somebody
  // has clicked it, against a live database.
  const workflow = readFileSync('.github/workflows/housekeeping-db.yml', 'utf8');
  const offered = [...workflow.matchAll(/^\s+- (housekeeping[\w-]*\.sql)$/gm)].map((m) => m[1]);

  assert.ok(offered.length, 'no file options found — has the workflow changed shape?');
  for (const file of offered) {
    assert.ok(readFileSync(`seed/${file}`, 'utf8').trim().length, `seed/${file} is missing or empty`);
  }
  for (const file of UPGRADE_FILES) {
    assert.ok(offered.includes(file), `${file} is an upgrade nobody can run from the button`);
  }
});
