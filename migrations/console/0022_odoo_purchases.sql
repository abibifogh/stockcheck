ALTER TABLE purchases ADD COLUMN po_ref TEXT;
ALTER TABLE purchases ADD COLUMN odoo_line_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_odoo_line
  ON purchases (odoo_line_id) WHERE odoo_line_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS odoo_product_map (
  odoo_product_id INTEGER NOT NULL,
  odoo_uom_id     INTEGER NOT NULL DEFAULT 0,
  odoo_name       TEXT,
  odoo_uom        TEXT,
  ingredient_id   INTEGER REFERENCES ingredients (id) ON DELETE CASCADE,
  factor          REAL    NOT NULL DEFAULT 1,
  ignored         INTEGER NOT NULL DEFAULT 0,
  updated_by      TEXT,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (odoo_product_id, odoo_uom_id)
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('odoo_base', ''),
  ('odoo_db', '');
