-- A physical count can now correct the book, but only once an administrator
-- has accepted it. Until then it is recorded and reported as a difference,
-- exactly as before, and changes no figure.
--
-- Existing counts become 'pending' rather than 'approved' on purpose: they were
-- taken under the old rule, where a count never moved stock. Marking them
-- approved would silently rewrite months of stock history the moment this runs.
-- Pending preserves today's figures and puts the decision in front of somebody.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so running this twice reports
-- "duplicate column name" — harmless, and means it is already done.
ALTER TABLE mx_counts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE mx_counts ADD COLUMN counted_by TEXT;
ALTER TABLE mx_counts ADD COLUMN reviewed_by TEXT;
ALTER TABLE mx_counts ADD COLUMN reviewed_at TEXT;
ALTER TABLE mx_counts ADD COLUMN review_note TEXT;
