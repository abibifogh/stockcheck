ALTER TABLE production ADD COLUMN destination TEXT NOT NULL DEFAULT 'breakfast';
CREATE INDEX IF NOT EXISTS idx_production_destination ON production (destination, day);
