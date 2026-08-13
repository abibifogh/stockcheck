CREATE TABLE IF NOT EXISTS hk_roster (
  day            TEXT NOT NULL,
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  expected_state TEXT,
  expected_note  TEXT,
  set_by         TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at   TEXT,
  confirmed_by   TEXT,
  PRIMARY KEY (day, bed_id)
);
CREATE INDEX IF NOT EXISTS idx_hk_roster_day ON hk_roster (day);
INSERT OR IGNORE INTO hk_roster (day, bed_id, expected_state, expected_note, set_by)
SELECT date('now', '-1 day'), id, expected_state, expected_note, 'carried over'
FROM hk_beds WHERE expected_state IS NOT NULL;
INSERT OR IGNORE INTO hk_roster (day, bed_id, expected_state, expected_note, set_by)
SELECT date('now'), id, expected_state, expected_note, 'carried over'
FROM hk_beds WHERE expected_state IS NOT NULL;
