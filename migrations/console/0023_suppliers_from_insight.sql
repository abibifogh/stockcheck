ALTER TABLE suppliers ADD COLUMN odoo_id INTEGER;
ALTER TABLE suppliers ADD COLUMN key_supplier INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN grp TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_odoo ON suppliers (odoo_id) WHERE odoo_id IS NOT NULL;
UPDATE settings SET value = 'suggest' WHERE key = 'supplier_mode' AND value = 'select';
