-- Parts that come in variants: sizes, colours, ratings, lengths.
--
-- Two 40W bulbs, one white and one warm, are not one part with a note about
-- colour. They sit in different boxes, run out on different days and get
-- counted separately — so each is its own part, and always was. What was
-- missing is anything saying the two belong together, which left a technician
-- scrolling a flat list of near-identical names to find the right one.
--
-- So a *product* is added above the parts rather than underneath them. It holds
-- the name everybody uses — "LED bulb" — and the parts hanging off it hold what
-- tells them apart.
--
-- The important consequence is that nothing about stock changes. Every ledger
-- here keys on mx_items.id: issues, purchases, counts, the reorder list. A
-- variant is an item, so it already has its own balance, its own count line and
-- its own restock alert, and not one query had to learn about products to make
-- that true.
--
-- Which is also why this is a grouping table rather than a parent_id on
-- mx_items. A row that was both a heading and a stockable part would raise a
-- question nothing else can answer — what the heading's own balance means —
-- and an existing part joining a product would have to have its history moved
-- to a new row. Here it keeps its id and everything recorded against it.
--
-- Parts with no product carry on exactly as they are. Nothing is backfilled.
--
-- Safe to run more than once? The table is. The two ALTERs are not: a second
-- run stops on "duplicate column name", which is harmless and means it is
-- already done.

CREATE TABLE IF NOT EXISTS mx_products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES mx_categories (id),
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which product a part belongs to, and what tells it apart from its siblings.
--
-- `variant` is the short label — "40W warm", "15mm" — not the full name. The
-- full name stays on the part, unique as it always was, so every screen that
-- shows a part today still shows something a person recognises.
ALTER TABLE mx_items ADD COLUMN product_id INTEGER REFERENCES mx_products (id);
ALTER TABLE mx_items ADD COLUMN variant TEXT;

CREATE INDEX IF NOT EXISTS idx_mx_items_product ON mx_items (product_id);
