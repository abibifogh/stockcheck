-- In-app notifications, and scheduled stock counts.
--
-- Safe to run more than once.

-- ---------------------------------------------------------------- inbox --
-- One row per event, not one per recipient. A day sheet going to five managers
-- is one notification with an audience, which keeps the table the size of what
-- happened rather than the size of who was told.
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,           -- day_submitted | count_pending | stocktake_due
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,                    -- where in the app to go
  -- Exactly one of these decides who sees it: a single person, or everyone
  -- holding a permission.
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  audience   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_new ON notifications (created_at DESC);

-- Read state per person. Absent means unread, which makes "mark all read" a
-- write of only what somebody has actually seen.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL,
  read_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notification_id, user_id)
);

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
