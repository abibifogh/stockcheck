-- The bakery: bread produced in-house, as a stock input.
--
-- Breakfast stock has had exactly one way in until now — a delivery somebody
-- paid for. Bread made on the premises is the same event with no invoice: it
-- lands on the shelf, and the morning sheet takes it off again. Kept in its own
-- table rather than folded into purchases, because "what we spent with
-- suppliers" must not silently include flour we turned into loaves ourselves.
--
-- Safe to run more than once.

-- Which items the bakery reports on. Everything else stays out of the way: a
-- baker should open the link and see bread, not the whole storeroom.
ALTER TABLE ingredients ADD COLUMN is_produced INTEGER NOT NULL DEFAULT 0;

-- A shareable link, so the bakery can report without an account.
--
-- Only the hash of the token is kept. A link that leaks out can be revoked and
-- a new one issued; a link that was stored in plain text here could be read by
-- anybody who ever gets a look at the database.
CREATE TABLE IF NOT EXISTS bakery_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  -- The last few characters, shown in the admin list so two links can be told
  -- apart without either of them being recoverable from here.
  token_hint   TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0
);

-- One row per item per production cycle. Several cycles a day is the normal
-- case, which is why the day alone is not the key.
CREATE TABLE IF NOT EXISTS production (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT NOT NULL,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  -- "Morning", "Afternoon", "Night" — free text, because every bakery names
  -- its runs differently and a fixed list would be wrong for most of them.
  cycle         TEXT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients (id),
  qty           REAL NOT NULL,
  -- What a loaf costs to make, frozen at the moment it was reported. Taken
  -- from the item's standing cost rather than asked for: the baker knows how
  -- many came out of the oven, not what the flour cost.
  unit_cost     REAL NOT NULL DEFAULT 0,
  note          TEXT,
  produced_by   TEXT,
  link_id       INTEGER REFERENCES bakery_links (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_production_day ON production (day);
CREATE INDEX IF NOT EXISTS idx_production_item ON production (ingredient_id, day);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('notify_production', '1');

-- The starter catalogue's two bread items, if they are still named as seeded.
-- A hotel that renamed them ticks its own under Setup; nothing is guessed at
-- beyond these two exact names.
UPDATE ingredients SET is_produced = 1 WHERE name IN ('Sliced Bread', 'Tea Bread');
