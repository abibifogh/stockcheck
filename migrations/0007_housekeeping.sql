-- Housekeeping: the daily dorm bed check.
--
-- The problem this answers is narrow and specific. Every occupied bed in a dorm
-- is supposed to carry a name tag, and every bed the roster says is free is
-- supposed to be empty. Neither holds in practice, and nobody finds out until
-- somebody walks the rooms. So a housekeeper walks them, and for each bed
-- answers one question — occupied or free — and, when it is occupied, one
-- follow-up: does it have a name tag.
--
-- Deliberately its own tables rather than borrowing the maintenance rooms. An
-- mx_area is a place parts are issued to; a dorm room is a container of beds
-- with its own roster. Sharing them would mean every housekeeping query
-- carrying a filter it must never forget, and every new dorm room appearing in
-- the technician's issue screen.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS hk_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  block      TEXT,                            -- floor, wing or building
  sort_order INTEGER NOT NULL DEFAULT 100,
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_hk_rooms_order ON hk_rooms (sort_order, name);

-- One row per bed. The label is what is painted on the frame — "Bed 3",
-- "3 Upper" — because that is what the housekeeper is looking at.
CREATE TABLE IF NOT EXISTS hk_beds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES hk_rooms (id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  -- What the front desk says this bed should be: 'occupied', 'free', or NULL
  -- for a bed nobody is tracking. This is the only thing that can turn "a bed
  -- is occupied" into "a bed that should have been empty is occupied", which is
  -- half the reason the check exists. Left NULL it costs nothing: the bed is
  -- still checked, it simply raises no expectation to break.
  expected_state TEXT,
  -- Who is meant to be in it, if anyone bothered to write it down. Shown to
  -- managers on the report, never to the housekeeper doing the round — knowing
  -- the answer in advance is how a check stops being a check.
  expected_note  TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  UNIQUE (room_id, label)
);

CREATE INDEX IF NOT EXISTS idx_hk_beds_room ON hk_beds (room_id, sort_order);

-- One round per day for the whole property. Several housekeepers can be filling
-- it in at once — each covering their own floor — and each bed carries the name
-- of whoever answered for it, so a shared round never hides who saw what.
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

-- One row per bed per round.
--
-- `day` is carried alongside the round because every report groups by day, and
-- `expected_state` is copied in rather than read back through the bed, because
-- tonight's roster is not last Tuesday's. Without the snapshot, a manager
-- updating the roster would silently rewrite which of last week's beds counted
-- as a surprise.
CREATE TABLE IF NOT EXISTS hk_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id       INTEGER NOT NULL REFERENCES hk_rounds (id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  state          TEXT NOT NULL,          -- 'occupied' or 'free'
  -- 1 yes, 0 no. NULL when the bed was free, because the question was never
  -- asked — which is not the same as "no tag" and must never be counted as one.
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

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('hk_enabled', '1'),
  -- Email the round to whoever needs it, the moment it is submitted. Kept
  -- separate from the breakfast list: the people who care that a dorm bed has
  -- no name tag are rarely the people who care what the eggs cost.
  ('hk_notify_on_submit', '1'),
  ('hk_notify_recipients', '[]');

-- ---------------------------------------------------------------------------
-- A starting point, so the check screen is usable the minute it is opened.
-- All of it is editable, and none of it is load-bearing.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO hk_rooms (name, block, sort_order) VALUES
  ('Dorm A', 'Ground floor', 10),
  ('Dorm B', 'Ground floor', 20),
  ('Dorm C', 'First floor',  30),
  ('Dorm D', 'First floor',  40);

-- Six beds in each, numbered. A manager renames or adds to them in Setup, where
-- a whole room of beds can be created in one go.
--
-- Written out one bed at a time rather than generated from a row of numbers.
-- The obvious way to write this — joining against
-- `SELECT 1 UNION SELECT 2 UNION …` — is a compound SELECT, and D1 allows far
-- fewer terms in one than SQLite does: it fails with "too many terms in
-- compound SELECT" and the beds never arrive. Six plain statements cost
-- nothing and work on both.
--
-- `OR IGNORE` against the UNIQUE (room_id, label) is what makes re-running this
-- a no-op rather than a second set of beds.
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
