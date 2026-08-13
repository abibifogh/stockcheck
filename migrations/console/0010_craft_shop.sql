CREATE TABLE IF NOT EXISTS shop_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS shop_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id       INTEGER REFERENCES shop_categories (id),
  name              TEXT NOT NULL UNIQUE,
  sku               TEXT,
  unit              TEXT NOT NULL DEFAULT 'pcs',
    sell_price        REAL NOT NULL DEFAULT 0,
      default_unit_cost REAL NOT NULL DEFAULT 0,
  opening_stock     REAL NOT NULL DEFAULT 0,
  par_level         REAL NOT NULL DEFAULT 0,
    attributes        TEXT,
    is_common         INTEGER NOT NULL DEFAULT 1,
  active            INTEGER NOT NULL DEFAULT 1,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items (category_id);
CREATE TABLE IF NOT EXISTS shop_sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  payment_method TEXT NOT NULL DEFAULT 'cash',     total          REAL NOT NULL DEFAULT 0,
      tendered       REAL,
  change_due     REAL,
  sold_by        TEXT,
  note           TEXT,
  voided         INTEGER NOT NULL DEFAULT 0,
  voided_by      TEXT,
  voided_at      TEXT,
  void_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_shop_sales_day ON shop_sales (day, id);
CREATE TABLE IF NOT EXISTS shop_sale_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES shop_sales (id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES shop_items (id),
  qty        REAL NOT NULL,
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shop_sale_lines_sale ON shop_sale_lines (sale_id);
CREATE INDEX IF NOT EXISTS idx_shop_sale_lines_item ON shop_sale_lines (item_id);
CREATE TABLE IF NOT EXISTS shop_purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,
  item_id    INTEGER NOT NULL REFERENCES shop_items (id),
  qty        REAL NOT NULL,
  unit_cost  REAL NOT NULL,
  supplier   TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_day ON shop_purchases (day);
CREATE INDEX IF NOT EXISTS idx_shop_purchases_item ON shop_purchases (item_id, day);
CREATE TABLE IF NOT EXISTS shop_counts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES shop_items (id),
  counted_qty REAL NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',     counted_by  TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (day, item_id)
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shop_name', 'Craft Shop'),
      ('shop_low_cover_days', '21');
INSERT OR IGNORE INTO shop_categories (name, sort_order) VALUES
  ('Textiles', 10),
  ('Carvings', 20),
  ('Beads & Jewellery', 30),
  ('Baskets', 40),
  ('Art & Prints', 50),
  ('Souvenirs', 60);
