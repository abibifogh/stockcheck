CREATE TABLE IF NOT EXISTS mx_products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES mx_categories (id),
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE mx_items ADD COLUMN product_id INTEGER REFERENCES mx_products (id);
ALTER TABLE mx_items ADD COLUMN variant TEXT;
CREATE INDEX IF NOT EXISTS idx_mx_items_product ON mx_items (product_id);
