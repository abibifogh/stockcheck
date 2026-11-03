CREATE TABLE IF NOT EXISTS odoo_expected (
  odoo_line_id  INTEGER PRIMARY KEY,
  po            TEXT    NOT NULL,
  po_id         INTEGER,
  supplier      TEXT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients (id) ON DELETE CASCADE,
  qty           REAL    NOT NULL,
  unit_cost     REAL    NOT NULL,
  odoo_product  TEXT,
  odoo_qty      REAL,
  odoo_uom      TEXT,
  confirmed_on  TEXT,
  state         TEXT    NOT NULL DEFAULT 'expected',
  received_qty  REAL,
  received_by   TEXT,
  received_at   TEXT,
  purchase_id   INTEGER REFERENCES purchases (id) ON DELETE SET NULL,
  offered_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_odoo_expected_state ON odoo_expected (state, po);
