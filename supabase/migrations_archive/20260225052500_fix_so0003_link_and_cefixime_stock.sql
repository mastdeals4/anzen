
/*
  # Fix SO-2026-0003 linking and Cefixime USP stock

  1. Link DO-26-0003 to SO-2026-0003
  2. Link invoice SAPJ-26-003 to SO-2026-0003
  3. Update SO-2026-0003 status to closed
  4. Release the stock reservation for SO-2026-0003
  5. Fix Cefixime USP batch current_stock (500 imported - 300 sold = 200)
*/

-- 1. Link DO-26-0003 to SO-2026-0003
UPDATE delivery_challans
SET sales_order_id = 'a79af0a1-8d69-4c1e-adc5-e5dc28275c90'
WHERE challan_number = 'DO-26-0003'
  AND sales_order_id IS NULL;

-- 2. Link invoice SAPJ-26-003 to SO-2026-0003
UPDATE sales_invoices
SET sales_order_id = 'a79af0a1-8d69-4c1e-adc5-e5dc28275c90'
WHERE invoice_number = 'SAPJ-26-003'
  AND sales_order_id IS NULL;

-- 3. Release the stock reservation for SO-2026-0003
UPDATE stock_reservations
SET status = 'released',
    is_released = true,
    released_at = NOW(),
    release_reason = 'Delivered via DO-26-0003, invoiced as SAPJ-26-003'
WHERE sales_order_id = 'a79af0a1-8d69-4c1e-adc5-e5dc28275c90'
  AND status = 'active';

-- 4. Update SO-2026-0003 status to closed (delivered + invoiced)
UPDATE sales_orders
SET status = 'closed'
WHERE id = 'a79af0a1-8d69-4c1e-adc5-e5dc28275c90';

-- 5. Fix Cefixime USP batch current_stock
-- import_quantity=500, sold=300, so current_stock should be 200
UPDATE batches
SET current_stock = 200
WHERE id = 'c22d70c6-e9fd-4390-82d9-983ae35096ce'
  AND batch_number = 'XMEP250178';

-- 6. Sync product current_stock for Cefixime USP
UPDATE products
SET current_stock = (
  SELECT COALESCE(SUM(b.current_stock), 0)
  FROM batches b
  WHERE b.product_id = products.id
    AND b.is_active = true
    AND b.current_stock > 0
)
WHERE product_name ILIKE '%cefixime usp%';
