-- Ensure product duty % is kept in sync with legacy duty_a1 text field
UPDATE products
SET duty_percent = CASE
  WHEN duty_a1 ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN duty_a1::numeric
  ELSE COALESCE(duty_percent, 0)
END
WHERE duty_a1 IS NOT NULL;

-- Disable low stock notifications globally for now by setting all minimum stock levels to zero
UPDATE products
SET min_stock_level = 0
WHERE COALESCE(min_stock_level, 0) <> 0;
