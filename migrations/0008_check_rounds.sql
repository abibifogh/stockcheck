-- Three checks a day rather than one.
--
-- The property walks its dorms three times: reception opens up and checks at
-- eight, housekeeping checks again during the room round, and reception checks
-- once more before closing. Each is its own report, submitted and emailed on its
-- own, by different people with different reasons for looking.
--
-- That turns a round from "the day" into "the day and which check", which is
-- more than a label. It is what lets the system say a bed was found untagged at
-- eight and still untagged at ten at night — nobody dealt with it — as against
-- found and fixed, which is the system working.
--
-- SQLite cannot drop the old UNIQUE (day) constraint in place, so hk_rounds is
-- rebuilt. Rounds already recorded become the morning round, which is what a
-- single daily check has always been in practice.
--
-- The checks are parked in a table with no foreign keys for the duration.
-- Dropping hk_rounds while foreign keys are enforced performs an implicit
-- delete, and hk_checks cascades from it — so a rebuild that looks careful
-- quietly takes every recorded check with it.
--
-- Applied exactly once, by the migration runner. There is no conditional column
-- add in SQLite, so re-running it stops at "duplicate column name" or rewrites
-- slots that are already correct. A database being set up by hand should use
-- seed/housekeeping-database.sql instead, which builds this shape directly and
-- can be run as often as you like.

CREATE TABLE IF NOT EXISTS hk_checks_stage (
  id             INTEGER PRIMARY KEY,
  round_id       INTEGER NOT NULL,
  day            TEXT NOT NULL,
  slot           TEXT NOT NULL DEFAULT 'morning',
  bed_id         INTEGER NOT NULL,
  state          TEXT NOT NULL,
  name_tag       INTEGER,
  expected_state TEXT,
  note           TEXT,
  checked_by     TEXT,
  at             TEXT
);

-- 'morning' as a literal rather than read from the round: before this migration
-- there was one round a day and no column to read.
INSERT OR IGNORE INTO hk_checks_stage
  (id, round_id, day, slot, bed_id, state, name_tag, expected_state, note, checked_by, at)
  SELECT id, round_id, day, 'morning', bed_id, state, name_tag, expected_state, note, checked_by, at
    FROM hk_checks;

-- ------------------------------------------------------------- the rounds --

CREATE TABLE IF NOT EXISTS hk_rounds_new (
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

INSERT OR IGNORE INTO hk_rounds_new
  (id, day, slot, started_at, submitted_at, submitted_by, note, updated_at)
  SELECT id, day, 'morning', started_at, submitted_at, submitted_by, note, updated_at FROM hk_rounds;

DROP TABLE IF EXISTS hk_rounds;
ALTER TABLE hk_rounds_new RENAME TO hk_rounds;

CREATE INDEX IF NOT EXISTS idx_hk_rounds_day ON hk_rounds (day, slot);

-- ------------------------------------------------------------- the checks --

CREATE TABLE IF NOT EXISTS hk_checks_new (
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

INSERT OR IGNORE INTO hk_checks_new
  (id, round_id, day, slot, bed_id, state, name_tag, expected_state, note, checked_by, at)
  SELECT id, round_id, day, slot, bed_id, state, name_tag, expected_state, note, checked_by,
         COALESCE(at, datetime('now'))
    FROM hk_checks_stage;

DROP TABLE IF EXISTS hk_checks;
ALTER TABLE hk_checks_new RENAME TO hk_checks;
DROP TABLE IF EXISTS hk_checks_stage;

CREATE INDEX IF NOT EXISTS idx_hk_checks_day ON hk_checks (day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_bed ON hk_checks (bed_id, day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_round ON hk_checks (round_id);
CREATE INDEX IF NOT EXISTS idx_hk_checks_slot ON hk_checks (day, slot);
