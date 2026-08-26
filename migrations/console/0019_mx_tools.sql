CREATE TABLE IF NOT EXISTS mx_tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
      tag         TEXT UNIQUE,
  category_id INTEGER REFERENCES mx_categories (id),
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mx_tool_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id     INTEGER NOT NULL REFERENCES mx_tools (id),
      area_id     INTEGER REFERENCES mx_areas (id),
  issued_to   TEXT NOT NULL,
  issued_by   TEXT,
  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
      due_back_at TEXT NOT NULL,
  returned_at TEXT,
  received_by TEXT,
  note        TEXT,
  return_note TEXT,
      overdue_notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mx_tool_movements_tool ON mx_tool_movements (tool_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mx_tool_out
  ON mx_tool_movements (tool_id) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mx_tool_overdue
  ON mx_tool_movements (returned_at, due_back_at);
INSERT OR IGNORE INTO settings (key, value) VALUES
        ('mx_tool_hours', '24'),
  ('notify_tool_overdue', '1');
