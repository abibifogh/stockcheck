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
};

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
  // Re-attach the index lines that belong to the rebuilt tables.
  const indexes = Object.values(FINAL_TABLES)
    .flatMap((block) => block.split('\n').filter((l) => l.startsWith('CREATE INDEX')))
    .filter((line) => !sql.includes(line));
  writeFileSync(out, `${[sql, ...indexes].join('\n')}\n`);
}

const all = readdirSync('migrations').sort();
const upgrades = (f) => !f.startsWith('0008');

// The whole database a housekeeping-only site needs. 0005 and 0006 build the
// maintenance parts store, which that site does not serve at all.
build(all.filter((f) => upgrades(f) && !f.startsWith('0005') && !f.startsWith('0006')),
  'seed/housekeeping-database.sql');

// Just the bed check's own tables, for adding them to a database that already
// has the rest.
build(all.filter((f) => upgrades(f) && f.startsWith('0007')), 'seed/housekeeping-tables.sql');

console.log('wrote seed/housekeeping-database.sql and seed/housekeeping-tables.sql');
