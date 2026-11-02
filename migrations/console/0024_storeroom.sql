ALTER TABLE ingredients ADD COLUMN kind TEXT NOT NULL DEFAULT 'food';
ALTER TABLE ingredients ADD COLUMN requestable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ingredients ADD COLUMN store_opening REAL NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN store_par REAL NOT NULL DEFAULT 0;
ALTER TABLE purchases ADD COLUMN location TEXT NOT NULL DEFAULT 'kitchen';
CREATE TABLE IF NOT EXISTS store_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  department      TEXT    NOT NULL DEFAULT 'Kitchen',
  needed          TEXT    NOT NULL DEFAULT 'now',
  note            TEXT,
  status          TEXT    NOT NULL DEFAULT 'waiting',
  follows         INTEGER REFERENCES store_requests (id) ON DELETE SET NULL,
  requested_by    TEXT    NOT NULL,
  requested_by_id INTEGER,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  issued_by       TEXT,
  issued_at       TEXT,
  day             TEXT,
  issue_note      TEXT,
  received_by     TEXT,
  received_at     TEXT,
  received_auto   INTEGER NOT NULL DEFAULT 0,
  difference      INTEGER NOT NULL DEFAULT 0,
  receipt_note    TEXT,
  closed_by       TEXT,
  closed_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_store_requests_status ON store_requests (status, created_at);
CREATE INDEX IF NOT EXISTS idx_store_requests_day ON store_requests (day);
CREATE TABLE IF NOT EXISTS store_request_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER NOT NULL REFERENCES store_requests (id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients (id),
  asked         REAL    NOT NULL,
  issued        REAL,
  received      REAL,
  unit_cost     REAL,
  short_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_store_lines_request ON store_request_lines (request_id);
CREATE INDEX IF NOT EXISTS idx_store_lines_item ON store_request_lines (ingredient_id);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('deliveries_to', 'store'),
  ('store_departments', 'Kitchen');
