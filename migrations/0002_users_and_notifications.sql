-- Per-person accounts, admin-controlled settings and email notifications.

-- Real users replace the two shared PINs. Login is still PIN-only (fast on a
-- kitchen tablet), so PINs must be unique across users — the app enforces that
-- via the UNIQUE index below.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  -- HMAC of the PIN using a pepper stored in settings. Deterministic so a
  -- login is a single indexed lookup rather than a scan of every user.
  pin_hash      TEXT    NOT NULL UNIQUE,
  role          TEXT    NOT NULL DEFAULT 'cook',
  -- JSON array of permission keys. NULL means "use the role's defaults".
  permissions   TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_active ON users (active);

-- Delivery record for notification emails, so a manager can see at a glance
-- whether the morning's mail actually went out.
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

-- Suppliers are picked from a list when recording a delivery, rather than
-- retyped each time (which produced "Makola", "makola supplies" and "Makola
-- Supplies " as three different suppliers in the reports).
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
  -- The outsider fee is now fixed by the admin rather than typed each morning.
  ('outsider_fee',       '0'),
  ('allow_fill_usual',   '1'),
  ('notify_on_submit',   '1'),
  ('notify_recipients',  '[]'),
  ('email_from',         ''),
  ('site_url',           ''),
  -- 'select' = choose from the supplier list, 'free' = type any name,
  -- 'off' = do not ask for a supplier at all.
  ('supplier_mode',      'select');

-- A re-submitted day does not overwrite the original. It is parked here until
-- somebody with authority compares the two and accepts it.
CREATE TABLE IF NOT EXISTS day_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  -- Full proposed sheet: guest counts, note and every quantity.
  payload       TEXT    NOT NULL,
  -- The live sheet as it stood when this was proposed, so the reviewer can see
  -- exactly what would change even if other edits land in between.
  previous      TEXT,
  submitted_by  TEXT,
  submitted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  review_note   TEXT
);

CREATE INDEX IF NOT EXISTS idx_revisions_status ON day_revisions (status, day);

-- Closed accounting periods. Nothing inside a locked range can be changed.
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
  -- Every everyday item must carry a figure before a day can be submitted.
  ('require_complete_entry',    '1'),
  -- A re-submission waits for approval instead of overwriting.
  ('require_resubmit_approval', '1');

-- Random per-installation pepper for PIN hashing. Generated once here so that
-- rotating the session key never invalidates everybody's PIN.
INSERT OR IGNORE INTO settings (key, value)
  VALUES ('pin_pepper', lower(hex(randomblob(32))));
