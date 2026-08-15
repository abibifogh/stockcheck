-- The kitchen's physical count can now correct the book, but only once an
-- administrator has accepted it — the same rule the parts store already
-- follows, and for the same reason: recounting a store is exactly
-- the moment a shortfall could be quietly written off, so whoever counts is
-- never whoever decides.
--
-- Until this, a breakfast count was recorded and reported as a difference and
-- changed no figure at all. That is what a pending count still does.
--
-- Existing counts become 'pending' rather than 'approved' on purpose. They were
-- taken under the old rule, where a count never moved stock; marking them
-- approved would silently rewrite months of stock history the moment this runs.
-- Pending preserves today's figures and puts the decision in front of somebody.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so running this twice reports
-- "duplicate column name" — harmless, and means it is already done.
ALTER TABLE stock_counts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE stock_counts ADD COLUMN counted_by TEXT;
ALTER TABLE stock_counts ADD COLUMN reviewed_by TEXT;
ALTER TABLE stock_counts ADD COLUMN reviewed_at TEXT;
ALTER TABLE stock_counts ADD COLUMN review_note TEXT;
