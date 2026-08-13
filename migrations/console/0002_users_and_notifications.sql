CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
        pin_hash      TEXT    UNIQUE,
    email         TEXT    UNIQUE,
  password_hash TEXT,
  role          TEXT    NOT NULL DEFAULT 'cook',
    permissions   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  kind       TEXT NOT NULL,
  day        TEXT,
  recipients TEXT,
  status     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_log_at ON email_log (at DESC);
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  contact    TEXT,
  phone      TEXT,
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers (active);
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('outsider_fee',       '0'),
  ('allow_fill_usual',   '1'),
  ('notify_on_submit',   '1'),
  ('notify_recipients',  '[]'),
  ('email_from',         ''),
  ('site_url',           ''),
      ('supplier_mode',      'select');
CREATE TABLE IF NOT EXISTS day_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
    payload       TEXT    NOT NULL,
      previous      TEXT,
  submitted_by  TEXT,
  submitted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  review_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_revisions_status ON day_revisions (status, day);
CREATE TABLE IF NOT EXISTS period_locks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_day   TEXT NOT NULL,
  to_day     TEXT NOT NULL,
  reason     TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_locks_range ON period_locks (from_day, to_day);
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('require_complete_entry',    '1'),
    ('require_resubmit_approval', '1');
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('pin_pepper', lower(hex(randomblob(32))));
