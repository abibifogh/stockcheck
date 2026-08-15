/**
 * Build the paste-able schema files in seed/ from the migrations.
 *
 *   node scripts/build-seed.mjs
 *
 * A migration is a step from one shape to the next, and some steps cannot be
 * repeated — adding a column twice is an error. Somebody setting this up
 * through a browser has no migration runner keeping count, and will paste twice
 * the first time something looks wrong. So the files here are not the steps:
 * they are the destination, written out directly, and running one a second time
 * does nothing at all.
 *
 * `test/seed.test.js` checks the two agree — that a database built from these
 * files is the same shape as one built by running every migration in order.
 * Change a migration without rebuilding, and that test says so.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

/**
 * The tables 0008 rebuilds, in their finished form.
 *
 * 0007 creates them one way and 0008 rebuilds them another; a fresh database
 * only ever wants the second. Keyed by the table each block defines so the
 * replacement is obvious rather than positional.
 */
const FINAL_TABLES = {
  hk_rounds: `CREATE TABLE IF NOT EXISTS hk_rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT NOT NULL,
  slot         TEXT NOT NULL DEFAULT 'morning',
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  submitted_by TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (day, slot)
);
CREATE INDEX IF NOT EXISTS idx_hk_rounds_day ON hk_rounds (day, slot);`,

  hk_checks: `CREATE TABLE IF NOT EXISTS hk_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id       INTEGER NOT NULL REFERENCES hk_rounds (id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  slot           TEXT NOT NULL DEFAULT 'morning',
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  state          TEXT NOT NULL,
  name_tag       INTEGER,
  expected_state TEXT,
  note           TEXT,
  checked_by     TEXT,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (round_id, bed_id)
);
CREATE INDEX IF NOT EXISTS idx_hk_checks_day ON hk_checks (day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_bed ON hk_checks (bed_id, day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_round ON hk_checks (round_id);
CREATE INDEX IF NOT EXISTS idx_hk_checks_slot ON hk_checks (day, slot);`,

  // 0009 creates it and 0013 adds `audience`. A fresh database wants the
  // finished shape in one statement, because an ALTER cannot be pasted twice
  // and these files are written to be.
  app_notices: `CREATE TABLE IF NOT EXISTS app_notices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  kind     TEXT NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info',
  title    TEXT NOT NULL,
  body     TEXT,
  link     TEXT,
  day      TEXT,
  slot     TEXT,
  actor    TEXT,
  audience TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);`,
};

/**
 * The columns FINAL_TABLES already includes.
 *
 * Their ALTERs have to come out, or pasting the file a second time stops on
 * "duplicate column name" — which is exactly the failure these files exist to
 * avoid.
 */
const FOLDED_IN = [/^ALTER TABLE app_notices ADD COLUMN audience\b.*$/gm];

/** Comments are stripped: the D1 console rejects a paste it reads as only those. */
function statementsOf(file) {
  const out = [];
  for (const line of readFileSync(`migrations/${file}`, 'utf8').split('\n')) {
    const code = line.split('--')[0].trimEnd();
    if (code.trim()) out.push(code);
  }
  return out.join('\n');
}

/** Swap a CREATE TABLE block, and the indexes that follow it, for the final one. */
function withFinalTables(sql) {
  for (const [table, replacement] of Object.entries(FINAL_TABLES)) {
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'g');
    if (!create.test(sql)) continue;
    sql = sql.replace(create, replacement);
    // The old indexes are now duplicated inside the replacement block.
    sql = sql.replace(
      new RegExp(`^CREATE INDEX IF NOT EXISTS \\w+ ON ${table} \\([^)]*\\);$`, 'gm'),
      '',
    );
    // Put the replacement's own indexes back, which the sweep above removed.
    sql = sql.replace(replacement.split('\n);')[0] + '\n);', replacement.split('\n);')[0] + '\n);');
  }
  return sql.split('\n').filter((l) => l.trim()).join('\n');
}

function build(files, out) {
  let sql = files.map(statementsOf).join('\n');
  sql = withFinalTables(sql);
  for (const pattern of FOLDED_IN) sql = sql.replace(pattern, '');
  // Re-attach the index lines that belong to the rebuilt tables.
  const indexes = Object.values(FINAL_TABLES)
    .flatMap((block) => block.split('\n').filter((l) => l.startsWith('CREATE INDEX')))
    .filter((line) => !sql.includes(line));
  writeFileSync(out, `${[sql, ...indexes].join('\n')}\n`);
}

// `.sql` only: `migrations/console/` is a directory of paste-able copies.
const all = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
// 0007 creates the bed-check tables one way and 0008 rebuilds them another; a
// fresh database only ever wants the second, which FINAL_TABLES supplies.
const upgrades = (f) => f !== '0008_check_rounds.sql' && f !== '0008_notifications_and_stocktakes.sql';

/**
 * Migrations that build a store the housekeeping site does not serve.
 *
 * Named rather than numbered on purpose. Two branches once numbered from 0007
 * at the same time, so "everything except 0007" stopped meaning one thing —
 * and a filter that silently included an ALTER against a table this seed never
 * creates failed with "no such table" only after the file had been written.
 */
const OTHER_STORES = new Set([
  '0005_maintenance.sql',
  '0006_part_attributes.sql',
  '0007_count_approval.sql',
  '0010_craft_shop.sql',
  '0011_bakery.sql',
  // Alters the kitchen's stock_counts, which this site never reads.
  '0012_breakfast_count_approval.sql',
]);

// The whole database a housekeeping-only site needs.
build(all.filter((f) => upgrades(f) && !OTHER_STORES.has(f)), 'seed/housekeeping-database.sql');

// Just the bed check's own tables, for adding them to a database that already
// has the rest. Named, not numbered — the other 0007 belongs to the parts
// store, and a prefix match once put an ALTER against mx_counts in here.
build(['0007_housekeeping.sql'], 'seed/housekeeping-tables.sql');

// The step from the one-check-a-day shape to three. The files above build the
// destination and skip anything already there, which is exactly wrong for a
// database part-way along: CREATE TABLE IF NOT EXISTS leaves the old table
// alone and the next index fails on a column it does not have. So the upgrade
// is its own file, and it is the migration verbatim.
writeFileSync('seed/housekeeping-upgrade-rounds.sql', `${statementsOf('0008_check_rounds.sql')}\n`);

// The in-app notices, for a database that already has everything else. Pure
// CREATE TABLE IF NOT EXISTS, so unlike the rounds upgrade it can be run as
// often as you like.
writeFileSync('seed/housekeeping-upgrade-notices.sql', `${statementsOf('0009_notices.sql')}\n`);

// The audience column on a notice, for a database that already has the bell.
// Its own file rather than an addition to the notices upgrade above: that one
// is pure CREATE TABLE IF NOT EXISTS and can be run repeatedly, and folding an
// ALTER into it would take that away.
writeFileSync('seed/housekeeping-upgrade-notice-audience.sql',
  `${statementsOf('0013_notice_audience.sql')}\n`);

console.log('wrote the seed/ schema files');
