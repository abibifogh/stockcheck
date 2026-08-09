-- Phone and desktop alerts when a day sheet is submitted.
--
-- Safe to run more than once: every statement guards itself.

-- One row per browser that has been given permission, not one per person: the
-- same manager may want the alert on a phone and on the office computer, and
-- each has its own endpoint and its own keys.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users (id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

-- Why a morning's alert did or did not arrive. Sending is fire-and-forget, so
-- without this there would be nothing to look at when somebody says they were
-- never told.
CREATE TABLE IF NOT EXISTS push_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT,
  sent   INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- On by default: somebody who has gone to the trouble of allowing
-- notifications in their browser meant to be notified.
INSERT OR IGNORE INTO settings (key, value) VALUES ('push_on_submit', '1');
