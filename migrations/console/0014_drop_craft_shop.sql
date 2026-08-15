DROP TABLE IF EXISTS shop_sale_lines;
DROP TABLE IF EXISTS shop_counts;
DROP TABLE IF EXISTS shop_purchases;
DROP TABLE IF EXISTS shop_sales;
DROP TABLE IF EXISTS shop_items;
DROP TABLE IF EXISTS shop_categories;
DELETE FROM settings WHERE key IN ('shop_name', 'shop_low_cover_days');
UPDATE users
   SET role = 'cook', permissions = '[]'
 WHERE role IN ('shop_assistant', 'shop_manager');
