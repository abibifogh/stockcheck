-- The storeroom, and the kitchen asking it for things.
--
-- Until now a delivery went straight onto the kitchen's shelf. In practice it
-- goes into the storeroom, and the kitchen asks for milk, tissue and soap when
-- it needs them. This records both halves: deliveries land in the storeroom,
-- and what the storekeeper issues is what reaches the kitchen.

-- What an item is.
--
--   food   — a breakfast ingredient. On the morning sheet, in the kitchen's
--            stock and in the cost per guest, exactly as before.
--   supply — tissue, soap, serviettes. Bought, kept in the storeroom and
--            issued, but never on the breakfast sheet: what is issued is used.
ALTER TABLE ingredients ADD COLUMN kind TEXT NOT NULL DEFAULT 'food';

-- Whether it is offered on the request screen. An item the storeroom never
-- holds (bread delivered fresh to the kitchen door) can be switched off.
ALTER TABLE ingredients ADD COLUMN requestable INTEGER NOT NULL DEFAULT 1;

-- What was on the storeroom's shelf when it started being tracked, and the
-- level below which it should be reordered.
ALTER TABLE ingredients ADD COLUMN store_opening REAL NOT NULL DEFAULT 0;
ALTER TABLE ingredients ADD COLUMN store_par REAL NOT NULL DEFAULT 0;

-- Where a delivery went. Every delivery recorded before today went to the
-- kitchen, which is what the default says.
ALTER TABLE purchases ADD COLUMN location TEXT NOT NULL DEFAULT 'kitchen';

-- One request from a department, and what became of it.
--
--   waiting   — sent, nobody has issued it yet.
--   issued    — the storekeeper has issued it (perhaps not all of it).
--   received  — the department confirmed it, or 24 hours passed and it was
--               taken as received (received_auto).
--   declined  — the storekeeper issued nothing, and said why.
--   cancelled — withdrawn before it was issued.
--
-- An issue that falls short does not leave the request half-open: what was
-- not issued becomes a new waiting request, `follows` pointing back, so the
-- storeroom's list is always simply "what is still owed".
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

-- The lines. `issued` and `unit_cost` are fixed when the storekeeper issues:
-- the cost is what was last paid for the item that day, so a later delivery
-- at a new price does not change what last Tuesday's milk cost the kitchen.
-- `received` is set only when the department reports a difference.
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

-- Where deliveries land from now on, and who can ask. The first department is
-- the breakfast kitchen: what it receives is breakfast stock. Anything issued
-- to the others leaves the building's books here as used.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('deliveries_to', 'store'),
  ('store_departments', 'Kitchen');
