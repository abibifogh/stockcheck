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
INSERT OR IGNORE INTO hk_checks_stage
  (id, round_id, day, slot, bed_id, state, name_tag, expected_state, note, checked_by, at)
  SELECT id, round_id, day, 'morning', bed_id, state, name_tag, expected_state, note, checked_by, at
    FROM hk_checks;
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
