-- Administrators sign in with an email address and a password; everyone else
-- keeps the PIN. SQLite cannot add a UNIQUE column in place, and pin_hash has
-- to become optional, so the table is rebuilt.

CREATE TABLE IF NOT EXISTS users_v2 (
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

INSERT INTO users_v2 (id, name, pin_hash, role, permissions, active, note, created_at, last_login_at)
  SELECT id, name, pin_hash, role, permissions, active, note, created_at, last_login_at FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);

INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_recovery_pin', '1');
