-- Remove the craft shop.
--
-- The shop was built and deployed, so these tables exist on any database that
-- has run 0010. That migration has been deleted, which stops a fresh database
-- ever creating them; this one clears the databases that already did.
--
-- Written as a drop rather than by rewriting history because 0010 has already
-- been applied in production: the file going away leaves the tables behind, and
-- tables nothing reads are exactly the ones that rot.
--
-- Safe to run more than once, and safe on a database that never had the shop.

-- Children before parents: the lines reference the sale, and the sale, the
-- purchase and the count all reference the item.
DROP TABLE IF EXISTS shop_sale_lines;
DROP TABLE IF EXISTS shop_counts;
DROP TABLE IF EXISTS shop_purchases;
DROP TABLE IF EXISTS shop_sales;
DROP TABLE IF EXISTS shop_items;
DROP TABLE IF EXISTS shop_categories;

-- The two settings 0010 seeded. Left behind they would be two rows nobody can
-- reach and nobody can explain.
DELETE FROM settings WHERE key IN ('shop_name', 'shop_low_cover_days');

-- Anybody hired for the shop and nothing else.
--
-- Their role no longer exists, and an unknown role falls back to the kitchen's
-- daily entry — so leaving these rows alone would hand a shop assistant the
-- breakfast sheet. They keep their account and their sign-in; what they can
-- reach becomes nothing, for an administrator to set deliberately.
UPDATE users
   SET role = 'cook', permissions = '[]'
 WHERE role IN ('shop_assistant', 'shop_manager');

-- Shop keys held by anybody else are left where they are: the permission list
-- is filtered against the keys the code knows on every read, so a stale
-- 'shop_stock' in a stored list already grants nothing.
