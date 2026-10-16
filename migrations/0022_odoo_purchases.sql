-- Purchases pulled from Odoo by PO number.
--
-- Until now every purchase here was typed in by hand from a delivery note,
-- which meant the same delivery was keyed twice: once into Odoo by whoever
-- raised the order, and once here by whoever received it. This lets somebody
-- type the PO numbers instead, and the lines come across on their own.

-- Where a purchase came from, so a line imported from Odoo can be told apart
-- from one typed in, and traced back to the order it belongs to.
ALTER TABLE purchases ADD COLUMN po_ref TEXT;

-- The Odoo purchase.order.line it was made from. This is what stops the same
-- order being imported twice: importing a PO that has already come across
-- skips the lines it already holds rather than doubling the stock. Partial,
-- so the hundreds of hand-typed rows with no Odoo line never collide.
ALTER TABLE purchases ADD COLUMN odoo_line_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_odoo_line
  ON purchases (odoo_line_id) WHERE odoo_line_id IS NOT NULL;

-- Which ingredient here an Odoo product is, and how its units convert.
--
-- Odoo does not know what "Eggs" means on the breakfast sheet; it knows
-- product 412, bought by the crate. The first time a product is seen somebody
-- says which ingredient it is, once, and every later order uses that answer —
-- which is what makes the import hands-off rather than another form to fill.
--
-- Keyed by product AND unit of measure, because the same product can be bought
-- by the crate one week and by the piece the next, and those need different
-- conversions. A different unit is simply a pair not mapped yet.
--
-- `factor` turns Odoo's quantity into this ingredient's unit: a crate of 30
-- eggs into an ingredient counted in pieces is 30. The price is divided by the
-- same factor, so a crate at 90 becomes eggs at 3 and the line total holds.
--
-- `ignored` is for products that are on the same order but are not breakfast
-- at all — washing-up liquid on the grocery PO. Saying so once stops every
-- later import asking about it again.
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

-- Where Odoo is. The API key is not here: it is a Worker secret, ODOO_API_KEY,
-- so it never sits in a database row or travels to a browser.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('odoo_base', ''),
  ('odoo_db', '');
