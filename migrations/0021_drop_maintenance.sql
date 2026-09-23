-- Remove the maintenance store.
--
-- The parts store, the tool store and the room-by-room analysis were built,
-- deployed and used, so these tables exist and hold real rows on any database
-- that has run 0005 onwards. This site goes back to being the breakfast unit
-- and the bakery, and nothing left in the code reads any of it.
--
-- Written as a drop rather than by rewriting history, for the same reason the
-- craft shop was: those migrations have already been applied in production, so
-- deleting the files would leave the tables behind — and tables nothing reads
-- are exactly the ones that rot.
--
-- This destroys every part, issue, delivery, count, adjustment, tool and tool
-- journey ever recorded. That is deliberate and was asked for; there is no
-- undo. Anybody who wants that history should take the CSV exports off Setup
-- and the Parts screen BEFORE running this.
--
-- Safe to run more than once, and safe on a database that never had the store.

-- Children before parents. Movements reference tools, adjustments and counts
-- reference items, issues reference both items and areas, and the stocktake
-- tasks reference their schedule.
DROP TABLE IF EXISTS mx_tool_movements;
DROP TABLE IF EXISTS mx_tools;
DROP TABLE IF EXISTS mx_stocktake_tasks;
DROP TABLE IF EXISTS mx_stocktake_assignees;
DROP TABLE IF EXISTS mx_stocktake_schedules;
DROP TABLE IF EXISTS mx_adjustments;
DROP TABLE IF EXISTS mx_counts;
DROP TABLE IF EXISTS mx_purchases;
DROP TABLE IF EXISTS mx_issues;
DROP TABLE IF EXISTS mx_items;
DROP TABLE IF EXISTS mx_products;
DROP TABLE IF EXISTS mx_areas;
DROP TABLE IF EXISTS mx_categories;

-- The settings those migrations seeded. Left behind they would be rows nobody
-- can reach and nobody can explain.
DELETE FROM settings WHERE key IN (
  'mx_enabled', 'mx_low_cover_days', 'mx_tool_hours', 'notify_tool_overdue'
);

-- Anybody hired for the parts store and nothing else.
--
-- Their role no longer exists, and an unknown role falls back to the kitchen's
-- daily entry — so leaving these rows alone would quietly hand a technician the
-- breakfast sheet, which is the one outcome this must not have. They keep their
-- account and their sign-in; what they can reach becomes nothing, for an
-- administrator to set deliberately.
UPDATE users
   SET role = 'cook', permissions = '[]'
 WHERE role IN ('technician', 'maintenance_manager');

-- Maintenance keys held by anybody else are left where they are: a stored
-- permission list is filtered against the keys the code knows on every read, so
-- a stale 'mx_stock' already grants nothing.

-- Bell entries whose links point at screens that no longer exist, so each one
-- is a dead end in somebody's inbox.
--
-- Matched on kind and on the link, never on kind alone: 'count_pending' is
-- raised by the kitchen's stock count as well as the parts store's, and the
-- kitchen's are still live. The link is what tells them apart.
DELETE FROM app_notices
 WHERE kind IN ('mx_adjustment', 'tool_overdue')
    OR (kind = 'count_pending' AND link LIKE '#/mx-%')
    OR audience IN ('mx_issue', 'mx_reports', 'mx_stock', 'mx_purchases', 'mx_setup');
