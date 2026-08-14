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

/**
 * The `users` table after 0003 has rebuilt it.
 *
 * Only the correspondence seed uses this. That file skips 0003 — a paste-able
 * schema must never run `DROP TABLE users` against a database whose own tables
 * reference it — so the finished shape has to be written out directly instead.
 */
const FINAL_USERS = {
  users: `CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  pin_hash      TEXT    UNIQUE,
  email         TEXT    UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'cook',
  permissions   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);`,
};

/** Swap a CREATE TABLE block, and the indexes that follow it, for the final one. */
function withFinalTables(sql, tables = FINAL_TABLES) {
  for (const [table, replacement] of Object.entries(tables)) {
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'g');
    if (!create.test(sql)) continue;
    sql = sql.replace(create, replacement);
    // The old indexes are now duplicated inside the replacement block.
    sql = sql.replace(
      // Tolerant of the spacing: the migrations line their index names up in
      // columns, so `idx_users_email  ON users` has two spaces where
      // `idx_users_active ON users` has one. A pattern that only matched one
      // left the wider line behind and the file ended up with the index twice.
      new RegExp(`^CREATE INDEX IF NOT EXISTS \\w+ +ON ${table} +\\([^)]*\\);$`, 'gm'),
      '',
    );
    // Put the replacement's own indexes back, which the sweep above removed.
    sql = sql.replace(replacement.split('\n);')[0] + '\n);', replacement.split('\n);')[0] + '\n);');
  }
  return sql.split('\n').filter((l) => l.trim()).join('\n');
}

/**
 * Take a table out of the finished file entirely.
 *
 * Some migrations create shared foundations and one site's own tables in the
 * same file — 0001 has `settings` and `audit_log` next to `ingredients`. A
 * deployment that has no kitchen should not be handed a kitchen, so the tables
 * that do not belong are removed by name after the file is assembled rather
 * than by splitting every migration in two.
 *
 * Everything that names the table goes with it: the CREATE, its indexes, any
 * ALTER against it, and any seed rows inserted into it.
 */
function withoutTables(sql, tables) {
  for (const table of tables) {
    sql = sql
      .replace(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'g'), '')
      .replace(new RegExp(`^CREATE INDEX IF NOT EXISTS \\w+ +ON ${table} +\\([^)]*\\);$`, 'gm'), '')
      .replace(new RegExp(`^ALTER TABLE ${table} [^;]*;$`, 'gm'), '')
      .replace(new RegExp(`^INSERT[^;\\n]*INTO ${table}\\b[\\s\\S]*?;$`, 'gm'), '');
  }
  return sql.split('\n').filter((l) => l.trim()).join('\n');
}

function build(files, out, { drop = [], extraFinal = null, append = [] } = {}) {
  const finals = extraFinal ? { ...FINAL_TABLES, ...extraFinal } : FINAL_TABLES;
  let sql = files.map(statementsOf).join('\n');
  sql = withFinalTables(sql, finals);
  for (const pattern of FOLDED_IN) sql = sql.replace(pattern, '');
  if (drop.length) sql = withoutTables(sql, drop);
  // Re-attach the index lines belonging to the rebuilt tables, which the sweep
  // above took out along with the originals.
  //
  // Two conditions, both learned the hard way. An index is only re-attached if
  // its table is actually created in this file — `FINAL_TABLES` describes the
  // bed check, and a practice seed that carried `idx_hk_checks_day` without
  // `hk_checks` fails on the first line nobody reads. And it is keyed by index
  // name rather than by the whole line, because two spaces where the original
  // had one is not a second index.
  const named = new Set([...sql.matchAll(/^CREATE INDEX IF NOT EXISTS (\w+)/gm)].map((m) => m[1]));
  const indexes = [];
  for (const line of Object.values(finals).flatMap((block) => block.split('\n'))) {
    const match = line.match(/^CREATE INDEX IF NOT EXISTS (\w+) +ON (\w+)/);
    if (!match) continue;
    const [, index, table] = match;
    if (named.has(index)) continue;
    if (drop.includes(table)) continue;
    if (!sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)) continue;
    named.add(index);
    indexes.push(line);
  }

  writeFileSync(out, `${[sql, ...indexes, ...append].join('\n')}\n`);
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
  // The accounting practice. A hostel has no correspondence register.
  '0014_correspondence.sql',
]);

// The whole database a housekeeping-only site needs.
build(all.filter((f) => upgrades(f) && !OTHER_STORES.has(f)), 'seed/housekeeping-database.sql');

/**
 * The database the correspondence site needs.
 *
 * The foundations every deployment shares — people, settings, the audit log,
 * the bell, push — plus the register itself. Nothing from the hotel and nothing
 * from the dorm: a practice that found `service_days` in its database would
 * rightly wonder what else had been left lying around.
 *
 * Two mechanisms, because the migrations mix the two kinds of table. Whole
 * files are skipped where a file is entirely one store's; individual tables are
 * dropped by name where a file carries both — 0001 defines `settings` and
 * `ingredients` side by side.
 */
const NOT_THE_PRACTICE = new Set([
  '0005_maintenance.sql',
  '0006_part_attributes.sql',
  '0007_count_approval.sql',
  '0007_housekeeping.sql',
  '0010_craft_shop.sql',
  '0011_bakery.sql',
  '0012_breakfast_count_approval.sql',
  // Its own `users` rebuild, replaced below by the finished shape. Running a
  // DROP TABLE users against a database whose co_ tables reference it is not
  // something a paste-able file should ever attempt.
  '0003_admin_credentials.sql',
]);

const HOTEL_TABLES = [
  'categories', 'ingredients', 'service_days', 'usage', 'purchases', 'stock_counts',
  'suppliers', 'day_revisions', 'period_locks',
  'mx_stocktake_schedules', 'mx_stocktake_assignees', 'mx_stocktake_tasks',
];

build(
  all.filter((f) => upgrades(f) && !NOT_THE_PRACTICE.has(f)),
  'seed/correspondence-database.sql',
  {
    drop: HOTEL_TABLES,
    extraFinal: FINAL_USERS,
    // 0003 is skipped above, so the one setting it adds has to come from here.
    // Without it a fresh practice database has no way back in if the last
    // administrator locks themselves out.
    append: ["INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_recovery_pin', '1');"],
  },
);

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
