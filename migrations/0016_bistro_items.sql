-- Which baked items the bistro takes.
--
-- The bistro does not take everything that comes out of the oven — it is one
-- bread. Offering a Bistro box against every item made the form ask a question
-- with the same answer every time, which is the kind of question people stop
-- reading and eventually answer wrongly.
--
-- A flag rather than a name in the code: what the bistro takes is a decision
-- about this hotel, not about this software, and a hotel that starts sending it
-- rolls next month ticks the box itself under Setup → Ingredients.
--
-- Note the order. The UPDATE reads is_produced, which 0011 adds, so this file
-- belongs to the bakery and cannot run against a database that never had one.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS", so running this twice stops on
-- "duplicate column name: is_bistro" — harmless, and means it is already done.

ALTER TABLE ingredients ADD COLUMN is_bistro INTEGER NOT NULL DEFAULT 0;

-- The one item the bistro takes today. Matched loosely on the name because the
-- unit is written differently in different places — "Wheat Bread", "Wheat bread
-- (loaf)" — and narrowed to things actually baked here, so a bought-in loaf of
-- the same name is not swept up. Anything else is ticked by hand.
UPDATE ingredients
   SET is_bistro = 1
 WHERE is_produced = 1
   AND name LIKE '%wheat bread%';
