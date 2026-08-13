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
