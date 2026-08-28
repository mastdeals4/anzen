/*
  # Fix Cefixime Trihydrate SO-2026-0004: link invoice + DC, fix delivered quantity

  ## Issues Found
  - SO-2026-0004 (PT SANBE FARMA, 100kg Cefixime Trihydrate): delivered_quantity = 0 despite full delivery
  - DC DO-26-0005: linked to SO correctly, approved, 100kg from batch M1CFX10003625N
  - Invoice SAPJ-26-005 (PAID): not linked to SO-2026-0004 or DC DO-26-0005
  - Invoice has no linked_challan_ids or delivery_challan_number set

  ## Fixes
  1. Link SAPJ-26-005 → SO-2026-0004
  2. Set linked_challan_ids and delivery_challan_number on invoice
  3. Fix SO-2026-0004 item delivered_quantity = 100
  4. Sync product stock and batch reserved_stock
*/

-- Link SAPJ-26-005 to SO-2026-0004 and DC DO-26-0005
UPDATE sales_invoices
SET 
  sales_order_id = '357004ed-f993-4e6f-9716-81600696522d',
  linked_challan_ids = ARRAY['77405dd1-4502-457e-a5e8-5fc3bea4d8d1'],
  delivery_challan_number = 'DO-26-0005'
WHERE id = '182602a2-9e2f-45cf-a69c-d77d59f46054';

-- Fix SO-2026-0004 delivered_quantity
UPDATE sales_order_items
SET delivered_quantity = 100
WHERE id = 'b440f8fd-cea4-4c94-a4a5-1563d83d995d';

-- Recalculate batch reserved_stock from active SRs
UPDATE batches b
SET reserved_stock = COALESCE((
  SELECT SUM(sr.reserved_quantity)
  FROM stock_reservations sr
  WHERE sr.batch_id = b.id AND sr.status = 'active'
), 0)
WHERE b.is_active = true;

-- Sync product current_stock with batch sums
UPDATE products p
SET current_stock = COALESCE((
  SELECT SUM(b.current_stock)
  FROM batches b
  WHERE b.product_id = p.id AND b.is_active = true
), 0);
