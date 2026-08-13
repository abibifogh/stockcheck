-- Scheduled stock counts.
--
-- The in-app inbox this file originally also created is gone: the bell that
-- ships with the housekeeping work already does that job, and two bells in one
-- header is one too many. Its tables are left alone rather than dropped —
-- anybody who ran the earlier version of this file has them, and an empty table
-- costs nothing while a DROP on a live database is a decision.
--
-- Safe to run more than once.

-- ----------------------------------------------------------- stocktakes --
CREATE TABLE IF NOT EXISTS mx_stocktake_schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  -- How often, in days. 7, 30, 90 cover weekly, monthly and quarterly without
  -- a calendar library and without arguing about what "monthly" means in
  -- February.
  every_days   INTEGER NOT NULL DEFAULT 30,
  next_due     TEXT NOT NULL,
  last_done    TEXT,
  note         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mx_stocktake_assignees (
  schedule_id INTEGER NOT NULL REFERENCES mx_stocktake_schedules (id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, user_id)
);

-- One row per time a schedule comes round. Kept separately from the schedule
-- so "who was asked, when, and did they do it" survives the schedule being
-- edited or switched off later.
CREATE TABLE IF NOT EXISTS mx_stocktake_tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id  INTEGER REFERENCES mx_stocktake_schedules (id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  due_day      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',   -- open | done | cancelled
  opened_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  completed_by TEXT,
  items_counted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (schedule_id, due_day)
);

CREATE INDEX IF NOT EXISTS idx_stocktake_tasks_open ON mx_stocktake_tasks (status, due_day);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- Master switches, so a hotel that finds any of this noisy can turn it off
  -- without anybody editing code.
  ('notify_in_app', '1'),
  ('notify_count_pending', '1'),
  ('notify_stocktake_due', '1');
