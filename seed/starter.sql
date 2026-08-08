-- Optional starter catalogue for a hotel breakfast unit.
-- Load it with `npm run db:seed`, then adjust units, par levels and costs in
-- Setup → Ingredients. Every statement is idempotent, so re-running is safe.
--
-- Costs here are placeholders. They are only used until the first delivery of
-- an item is recorded on the Purchases screen, after which the real weighted
-- average takes over.

INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Eggs & Dairy', 10);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Bakery', 20);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Meats', 30);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Cereals & Grains', 40);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Fruits & Vegetables', 50);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Beverages', 60);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Spreads & Condiments', 70);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Cooking Essentials', 80);
INSERT OR IGNORE INTO categories (name, sort_order) VALUES ('Disposables', 90);


-- Eggs & Dairy
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Eggs', 'pcs', 6, 120, 1.5, 1, 1 FROM categories WHERE name = 'Eggs & Dairy';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Fresh Milk', 'L', 1, 20, 12, 1, 2 FROM categories WHERE name = 'Eggs & Dairy';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Butter', 'kg', 0.5, 4, 65, 1, 3 FROM categories WHERE name = 'Eggs & Dairy';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Cheese Slices', 'pcs', 5, 80, 1.2, 0, 4 FROM categories WHERE name = 'Eggs & Dairy';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Yoghurt', 'L', 1, 10, 18, 1, 5 FROM categories WHERE name = 'Eggs & Dairy';

-- Bakery
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Sliced Bread', 'loaf', 1, 12, 15, 1, 1 FROM categories WHERE name = 'Bakery';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Tea Bread', 'loaf', 1, 8, 12, 1, 2 FROM categories WHERE name = 'Bakery';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Croissant', 'pcs', 5, 30, 6, 0, 3 FROM categories WHERE name = 'Bakery';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Pancake Mix', 'kg', 0.5, 5, 28, 1, 4 FROM categories WHERE name = 'Bakery';

-- Meats
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Sausages', 'kg', 0.5, 6, 55, 1, 1 FROM categories WHERE name = 'Meats';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Bacon', 'kg', 0.5, 4, 90, 1, 2 FROM categories WHERE name = 'Meats';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Chicken (breakfast)', 'kg', 0.5, 5, 45, 0, 3 FROM categories WHERE name = 'Meats';

-- Cereals & Grains
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Corn Flakes', 'kg', 0.5, 6, 40, 1, 1 FROM categories WHERE name = 'Cereals & Grains';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Oats', 'kg', 0.5, 6, 25, 1, 2 FROM categories WHERE name = 'Cereals & Grains';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Rice', 'kg', 1, 10, 14, 1, 3 FROM categories WHERE name = 'Cereals & Grains';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Tom Brown', 'kg', 0.5, 4, 22, 0, 4 FROM categories WHERE name = 'Cereals & Grains';

-- Fruits & Vegetables
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Pineapple', 'pcs', 1, 10, 10, 1, 1 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Watermelon', 'pcs', 1, 6, 18, 1, 2 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Pawpaw', 'pcs', 1, 6, 12, 1, 3 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Banana', 'pcs', 5, 40, 1, 1, 4 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Tomatoes', 'kg', 0.5, 5, 16, 1, 5 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Onions', 'kg', 0.5, 5, 14, 1, 6 FROM categories WHERE name = 'Fruits & Vegetables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Green Pepper', 'kg', 0.25, 2, 20, 0, 7 FROM categories WHERE name = 'Fruits & Vegetables';

-- Beverages
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Coffee', 'kg', 0.25, 3, 180, 1, 1 FROM categories WHERE name = 'Beverages';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Tea Bags', 'pcs', 10, 200, 0.4, 1, 2 FROM categories WHERE name = 'Beverages';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Milo', 'kg', 0.5, 4, 90, 1, 3 FROM categories WHERE name = 'Beverages';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Orange Juice', 'L', 1, 15, 16, 1, 4 FROM categories WHERE name = 'Beverages';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Sugar', 'kg', 0.5, 8, 14, 1, 5 FROM categories WHERE name = 'Beverages';

-- Spreads & Condiments
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Jam', 'kg', 0.5, 3, 45, 1, 1 FROM categories WHERE name = 'Spreads & Condiments';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Honey', 'L', 0.5, 2, 80, 0, 2 FROM categories WHERE name = 'Spreads & Condiments';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Ketchup', 'L', 0.5, 3, 30, 0, 3 FROM categories WHERE name = 'Spreads & Condiments';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Chocolate Spread', 'kg', 0.5, 2, 70, 0, 4 FROM categories WHERE name = 'Spreads & Condiments';

-- Cooking Essentials
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Cooking Oil', 'L', 1, 10, 22, 1, 1 FROM categories WHERE name = 'Cooking Essentials';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Salt', 'kg', 0.5, 4, 6, 0, 2 FROM categories WHERE name = 'Cooking Essentials';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Gas (LPG)', 'kg', 1, 15, 18, 0, 3 FROM categories WHERE name = 'Cooking Essentials';

-- Disposables
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Napkins', 'pack', 1, 10, 12, 0, 1 FROM categories WHERE name = 'Disposables';
INSERT OR IGNORE INTO ingredients (category_id, name, unit, step, par_level, default_unit_cost, is_core, sort_order)
  SELECT id, 'Takeaway Packs', 'pcs', 10, 100, 1.5, 0, 2 FROM categories WHERE name = 'Disposables';
