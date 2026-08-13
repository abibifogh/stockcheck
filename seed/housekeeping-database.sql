CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ingredients (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id       INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name              TEXT    NOT NULL,
  unit              TEXT    NOT NULL DEFAULT 'kg',
  step              REAL    NOT NULL DEFAULT 0.5,
  par_level         REAL    NOT NULL DEFAULT 0,
  default_unit_cost REAL    NOT NULL DEFAULT 0,
  opening_stock     REAL    NOT NULL DEFAULT 0,
  is_core           INTEGER NOT NULL DEFAULT 1,
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (category_id, name)
);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients (category_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_active   ON ingredients (active);
CREATE TABLE IF NOT EXISTS service_days (
  day             TEXT    PRIMARY KEY,
  inhouse_guests  INTEGER NOT NULL DEFAULT 0,
  outside_guests  INTEGER NOT NULL DEFAULT 0,
  outsider_fee    REAL    NOT NULL DEFAULT 0,
  note            TEXT,
  submitted_at    TEXT,
  submitted_by    TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage (
  day           TEXT    NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           REAL    NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_usage_ingredient ON usage (ingredient_id, day);
CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty           REAL    NOT NULL,
  unit_cost     REAL    NOT NULL,
  supplier      TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_day        ON purchases (day);
CREATE INDEX IF NOT EXISTS idx_purchases_ingredient ON purchases (ingredient_id, day);
CREATE TABLE IF NOT EXISTS stock_counts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  counted_qty   REAL    NOT NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (day, ingredient_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('currency',       'GHS'),
  ('timezone',       'Africa/Accra'),
  ('property_name',  'Breakfast Unit'),
  ('default_outsider_fee', '0');
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
CREATE TABLE IF NOT EXISTS push_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  day    TEXT,
  sent   INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('push_on_submit', '1');
CREATE TABLE IF NOT EXISTS hk_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  block      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
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
  day          TEXT NOT NULL,
  slot         TEXT NOT NULL DEFAULT 'morning',
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  submitted_by TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (day, slot)
);
CREATE TABLE IF NOT EXISTS hk_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id       INTEGER NOT NULL REFERENCES hk_rounds (id) ON DELETE CASCADE,
  day            TEXT NOT NULL,
  slot           TEXT NOT NULL DEFAULT 'morning',
  bed_id         INTEGER NOT NULL REFERENCES hk_beds (id) ON DELETE CASCADE,
  state          TEXT NOT NULL,
  name_tag       INTEGER,
  expected_state TEXT,
  note           TEXT,
  checked_by     TEXT,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (round_id, bed_id)
);
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
CREATE TABLE IF NOT EXISTS app_notices (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  kind     TEXT NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info',
  title    TEXT NOT NULL,
  body     TEXT,
  link     TEXT,
  day      TEXT,
  slot     TEXT,
  actor    TEXT,
  audience TEXT
);
CREATE TABLE IF NOT EXISTS app_notice_reads (
  user_id INTEGER PRIMARY KEY,
  last_id INTEGER NOT NULL DEFAULT 0,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notices_enabled', '1');

CREATE INDEX IF NOT EXISTS idx_hk_rounds_day ON hk_rounds (day, slot);
CREATE INDEX IF NOT EXISTS idx_hk_checks_day ON hk_checks (day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_bed ON hk_checks (bed_id, day);
CREATE INDEX IF NOT EXISTS idx_hk_checks_round ON hk_checks (round_id);
CREATE INDEX IF NOT EXISTS idx_hk_checks_slot ON hk_checks (day, slot);
CREATE INDEX IF NOT EXISTS idx_app_notices_at ON app_notices (id DESC);
