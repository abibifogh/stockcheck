CREATE TABLE IF NOT EXISTS hk_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  block      TEXT,                              sort_order INTEGER NOT NULL DEFAULT 100,
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_hk_rooms_order ON hk_rooms (sort_order, name);
CREATE TABLE IF NOT EXISTS hk_beds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES hk_rooms (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
            expected_state TEXT,
        expected_note  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (room_id, label)
);
CREATE INDEX IF NOT EXISTS idx_hk_beds_room ON hk_beds (room_id, sort_order);
CREATE TABLE IF NOT EXISTS hk_rounds (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          TEXT NOT NULL UNIQUE,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  submitted_by TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hk_rounds_day ON hk_rounds (day);
CREATE TABLE IF NOT EXISTS hk_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id       INTEGER NOT NULL REFERENCES hk_rounds (id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  state          TEXT NOT NULL,                name_tag       INTEGER,
  expected_state TEXT,
  note           TEXT,
  checked_by     TEXT,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (round_id, bed_id)
);
CREATE INDEX IF NOT EXISTS idx_hk_checks_day ON hk_checks (day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_bed ON hk_checks (bed_id, day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_round ON hk_checks (round_id);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('hk_enabled', '1'),
        ('hk_notify_on_submit', '1'),
  ('hk_notify_recipients', '[]');
INSERT OR IGNORE INTO hk_rooms (name, block, sort_order) VALUES
  ('Dorm A', 'Ground floor', 10),
  ('Dorm B', 'Ground floor', 20),
  ('Dorm C', 'First floor',  30),
  ('Dorm D', 'First floor',  40);
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 1', 10 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 2', 20 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 3', 30 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 4', 40 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 5', 50 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
INSERT OR IGNORE INTO hk_beds (room_id, label, sort_order)
  SELECT id, 'Bed 6', 60 FROM hk_rooms WHERE name IN ('Dorm A', 'Dorm B', 'Dorm C', 'Dorm D');
