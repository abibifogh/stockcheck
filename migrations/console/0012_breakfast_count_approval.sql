ALTER TABLE stock_counts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE stock_counts ADD COLUMN counted_by TEXT;
ALTER TABLE stock_counts ADD COLUMN reviewed_by TEXT;
ALTER TABLE stock_counts ADD COLUMN reviewed_at TEXT;
ALTER TABLE stock_counts ADD COLUMN review_note TEXT;
