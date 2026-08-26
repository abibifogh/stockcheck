-- Tools an artisan borrows, as opposed to parts they use up.
--
-- The parts store answers "how many are left". A tool asks a different
-- question — "where is it and who has it" — and the answer is never a
-- quantity. One drill goes out on Monday, comes back on Tuesday and goes out
-- again on Wednesday, and the thing worth keeping is that journey.
--
-- So tools do not live in mx_items. Putting them there would give a drill a
-- balance, a restock level and a place on the reorder list, none of which mean
-- anything, and would leave "who has it" with nowhere to go.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  -- What is stencilled on it. Two identical drills are two rows, and this is
  -- what tells them apart on a shelf and in a report.
  tag         TEXT UNIQUE,
  category_id INTEGER REFERENCES mx_categories (id),
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per journey: out on the left, back on the right.
--
-- Not two tables and not a status column on the tool. A status says where a
-- tool is now and forgets everything before it; these rows are the history, and
-- where it is now is simply the one that has not come back yet.
CREATE TABLE IF NOT EXISTS tool_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id     INTEGER NOT NULL REFERENCES tools (id),
  -- Where the work is. Nullable because "he took it home" is a real answer and
  -- refusing to record it would mean not recording the trip at all.
  area_id     INTEGER REFERENCES mx_areas (id),
  issued_to   TEXT NOT NULL,
  issued_by   TEXT,
  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Stored rather than worked out on the fly, so changing the grace period
  -- later cannot retroactively make last month's trips look late.
  due_back_at TEXT NOT NULL,
  returned_at TEXT,
  received_by TEXT,
  note        TEXT,
  return_note TEXT,
  -- Set when the overdue notice goes out, so an hourly sweep tells somebody
  -- once rather than every hour until the drill comes back.
  overdue_notified_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_movements_tool ON tool_movements (tool_id, id DESC);

-- A tool is in one place at a time. Issuing one that is already out is not a
-- second journey, it is somebody not knowing the first one happened — so the
-- database refuses it rather than the handler remembering to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_out
  ON tool_movements (tool_id) WHERE returned_at IS NULL;

-- What the sweep reads: still out, past due, not yet mentioned.
CREATE INDEX IF NOT EXISTS idx_tool_overdue
  ON tool_movements (returned_at, due_back_at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  -- How long a tool may be out before it is chased. Hours rather than days
  -- because a morning job that is still out at bedtime is the case worth
  -- catching.
  ('tool_hours', '24'),
  ('notify_tool_overdue', '1');
