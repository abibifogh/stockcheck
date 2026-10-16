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
DELETE FROM settings WHERE key IN (
  'mx_enabled', 'mx_low_cover_days', 'mx_tool_hours', 'notify_tool_overdue'
);
UPDATE users
   SET role = 'cook', permissions = '[]'
 WHERE role IN ('technician', 'maintenance_manager');
