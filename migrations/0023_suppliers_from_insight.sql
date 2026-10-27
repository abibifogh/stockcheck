-- The supplier list comes from Insight (which takes it from Odoo): each
-- supplier it sends carries its Odoo id, whether it is a key supplier and its
-- group. Suppliers added here by hand have none and are left alone.
ALTER TABLE suppliers ADD COLUMN odoo_id INTEGER;
ALTER TABLE suppliers ADD COLUMN key_supplier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN grp TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_odoo ON suppliers (odoo_id) WHERE odoo_id IS NOT NULL;

-- A delivery's supplier: picked from the list, or typed when it is not on it.
UPDATE settings SET value = 'suggest' WHERE key = 'supplier_mode' AND value = 'select';
