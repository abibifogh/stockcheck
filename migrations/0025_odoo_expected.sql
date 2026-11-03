-- Stock from Odoo, on its way.
--
-- Insight reads every confirmed Odoo purchase order and offers each line to
-- this app (POST /api/link/stock). A line can be recorded as stock at once,
-- or — the usual way — be shown in Purchases as "On its way from Odoo" until
-- somebody here says it arrived. This table holds those lines.
--
-- One row per Odoo purchase.order.line, the same id purchases.odoo_line_id
-- holds, so a line is never on its way twice and never recorded twice.
--
--   expected  — on its way, nobody has received it yet.
--   received  — somebody tapped Received. `received_qty` is what they said
--               came, which may be short or nothing at all; the purchase row
--               it made is `purchase_id` (none when nothing came).
--   cancelled — the PO was cancelled in Odoo. The row stays, so Insight
--               asking about the line later hears "cancelled", not "never
--               heard of it".
--
-- Quantities and the unit cost are already in the ingredient's own unit,
-- converted by odoo_product_map's factor when the line was offered; Odoo's
-- own quantity and unit are kept beside them for the screen.
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
