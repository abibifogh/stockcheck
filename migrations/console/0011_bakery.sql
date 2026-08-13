CREATE TABLE IF NOT EXISTS bakery_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
      token_hint   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS production (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
      cycle         TEXT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients (id),
  qty           REAL NOT NULL,
        unit_cost     REAL NOT NULL DEFAULT 0,
  note          TEXT,
  produced_by   TEXT,
  link_id       INTEGER REFERENCES bakery_links (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_production_day ON production (day);
CREATE INDEX IF NOT EXISTS idx_production_item ON production (ingredient_id, day);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notify_production', '1');
ALTER TABLE ingredients ADD COLUMN is_produced INTEGER NOT NULL DEFAULT 0;
UPDATE ingredients SET is_produced = 1 WHERE name IN ('Sliced Bread', 'Tea Bread');
