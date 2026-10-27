/*
  # Add min_stock_level to product_stock_summary view

  ## Summary
  Drops and recreates `product_stock_summary` to include `min_stock_level` so the
  Stock page can apply the "only flag as low stock when min_stock_level > 0" rule,
  consistent with the dashboard and notifications.

  ## Changes
  - Drops existing `product_stock_summary` view
  - Recreates it with `p.min_stock_level` added between `category` and `total_current_stock`
  - Restores GRANT SELECT for authenticated role

  ## No data impact — view only
*/

DROP VIEW IF EXISTS product_stock_summary;

CREATE VIEW product_stock_summary AS
SELECT
  p.id AS product_id,
  p.product_name,
  p.product_code,
  p.unit,
  p.category,
  p.min_stock_level,
  COALESCE(SUM(b.current_stock), 0) AS total_current_stock,
  COUNT(CASE WHEN b.current_stock > 0 THEN b.id END) AS active_batch_count,
  COUNT(CASE WHEN b.expiry_date IS NOT NULL AND b.expiry_date < CURRENT_DATE THEN 1 END) AS expired_batch_count,
  MIN(CASE WHEN b.expiry_date >= CURRENT_DATE OR b.expiry_date IS NULL THEN b.expiry_date END) AS nearest_expiry_date
FROM products p
LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
WHERE p.is_active = true
GROUP BY p.id, p.product_name, p.product_code, p.unit, p.category, p.min_stock_level
ORDER BY p.product_name;

GRANT SELECT ON product_stock_summary TO authenticated;
