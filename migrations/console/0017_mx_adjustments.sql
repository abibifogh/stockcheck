CREATE TABLE IF NOT EXISTS mx_adjustments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    action       TEXT NOT NULL,
  target_id    INTEGER NOT NULL,
      payload      TEXT,
        previous     TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  review_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mx_adjustments_status ON mx_adjustments (status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mx_adjustments_open
  ON mx_adjustments (kind, target_id) WHERE status = 'pending';
