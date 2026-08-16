-- Bread baked for the bistro.
--
-- The bakery bakes for two places and reports both in one go, because it is one
-- oven and one person writing the numbers down. Only what goes to breakfast
-- belongs in breakfast's stock and breakfast's costs, though: a loaf sent to the
-- bistro is worth recording — it is flour and oven time — and it is not a loaf
-- the kitchen can draw against in the morning.
--
-- Kept as a column on the same row rather than a second table. What was baked is
-- one fact with a destination attached; splitting it in two would mean joining
-- them back together every time anybody asked what came out of the oven.
--
-- Everything recorded before this was for breakfast, which is exactly what the
-- default makes it. No backfill.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so running this twice reports
-- "duplicate column name" — harmless, and means it is already done.

ALTER TABLE production ADD COLUMN destination TEXT NOT NULL DEFAULT 'breakfast';

-- The breakfast analysis reads "everything that is not the bistro's" on every
-- load, so the column it filters on is worth an index.
CREATE INDEX IF NOT EXISTS idx_production_destination ON production (destination, day);
