-- Tools that come with things.
--
-- A drill arrives with a charger, a case and a set of bits, and the storeman
-- hands out all four as one act. Recording that as a note on the drill would
-- lose the only fact worth having: where the charger is when it does not come
-- back with the drill.
--
-- So an accessory is a tool. It gets a row in mx_tools like any other, with
-- parent_tool_id pointing at what it belongs to — which means it already has
-- its own journeys, its own history, and the partial unique index that stops
-- one thing being in two places. Not one query had to learn what an accessory
-- is for that to be true.
--
-- One level deep, deliberately. An accessory of an accessory is a question
-- nobody asked and a cycle waiting to happen; the handler refuses it.
ALTER TABLE mx_tools ADD COLUMN parent_tool_id INTEGER REFERENCES mx_tools (id);

-- Which trip an accessory went out on, when it went out alongside its parent.
--
-- Null means it went on its own — somebody borrowing just the charger — and
-- that is an ordinary journey, not a lesser one. The link is what lets the
-- drill coming back offer to bring its charger with it, instead of making
-- somebody tick four things they already handed over together.
ALTER TABLE mx_tool_movements ADD COLUMN with_movement_id INTEGER REFERENCES mx_tool_movements (id);

CREATE INDEX IF NOT EXISTS idx_mx_tools_parent ON mx_tools (parent_tool_id);
CREATE INDEX IF NOT EXISTS idx_mx_tool_movements_with ON mx_tool_movements (with_movement_id);
