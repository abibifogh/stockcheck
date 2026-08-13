CREATE TABLE IF NOT EXISTS app_notices (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL,
  level   TEXT NOT NULL DEFAULT 'info',
  title   TEXT NOT NULL,
  body    TEXT,
  link    TEXT,
  day     TEXT,
  slot    TEXT,
  actor   TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);
CREATE TABLE IF NOT EXISTS app_notice_reads (
  user_id INTEGER PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notices_enabled', '1');
