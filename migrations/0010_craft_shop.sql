-- The craft shop: a till, and the stock behind it.
--
-- The third store, and the first one that takes money. Breakfast and
-- maintenance both ask "what did this cost us"; the shop also asks "what did
-- we get for it", so every item carries a selling price as well as a cost, and
-- every sale carries the price that was actually charged rather than looking it
-- up later. A price rise next month must not rewrite last month's takings.
--
-- Safe to run more than once.

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
  -- What the customer pays. The one number the person on the till needs.
  sell_price        REAL NOT NULL DEFAULT 0,
  -- What it cost you. Kept apart from the selling price so margin is a fact
  -- rather than a guess, and never shown on the till screen.
  default_unit_cost REAL NOT NULL DEFAULT 0,
  opening_stock     REAL NOT NULL DEFAULT 0,
  par_level         REAL NOT NULL DEFAULT 0,
  -- Details that tell two similar pieces apart: size, colour, artist, material.
  attributes        TEXT,
  -- On the till's front page without searching.
  is_common         INTEGER NOT NULL DEFAULT 1,
  active            INTEGER NOT NULL DEFAULT 1,
  note              TEXT
);

CREATE INDEX IF NOT EXISTS idx_shop_items_category ON shop_items (category_id);

-- One row per completed sale. A sale is never edited or deleted — a wrong one
-- is voided, which leaves it visible with a reason. A till that lets somebody
-- quietly remove a sale is a till that gets robbed.
CREATE TABLE IF NOT EXISTS shop_sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL,
  at             TEXT NOT NULL DEFAULT (datetime('now')),
  payment_method TEXT NOT NULL DEFAULT 'cash',   -- cash | card
  total          REAL NOT NULL DEFAULT 0,
  -- Cash only: what the customer handed over, and what went back. Kept because
  -- "the drawer is short" is answerable only if the change was recorded.
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

-- The price is copied onto the line, not read from the item. What somebody was
-- charged is a fact about that afternoon, not about the price list today.
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

-- Physical counts, approved before they move the book — the same rule as the
-- parts store, and for the same reason: whoever counts is never whoever
-- decides.
CREATE TABLE IF NOT EXISTS shop_counts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES shop_items (id),
  counted_qty REAL NOT NULL,
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  counted_by  TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (day, item_id)
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('shop_name', 'Craft Shop'),
  -- Days of cover below which the shop is told to reorder. Craft stock turns
  -- over slowly, so this is longer than the kitchen's fortnight.
  ('shop_low_cover_days', '21');

INSERT OR IGNORE INTO shop_categories (name, sort_order) VALUES
  ('Textiles', 10),
  ('Carvings', 20),
  ('Beads & Jewellery', 30),
  ('Baskets', 40),
  ('Art & Prints', 50),
  ('Souvenirs', 60);
