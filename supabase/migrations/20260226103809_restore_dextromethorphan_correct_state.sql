/*
  # Restore Dextromethorphan Hydrobromide USP to Correct State

  ## Correct Business Logic
  - 200 kg imported
  - 50 kg sold/delivered (30 via DO-26-0003, 20 via DO-26-0006)
  - 60 kg reserved (SO-2026-0001: 30 kg, SO-2026-0002: 30 kg - legitimate active orders)
  - 90 kg free/available

  ## What was wrongly done previously
  - Incorrectly adjusted physical stock from 150 to 90
  - Incorrectly cancelled SO-2026-0001 and SO-2026-0002 (these are real pending orders)
  - Incorrectly released their reservations

  ## This fix
  1. Restore physical stock to 150 (200 imported - 50 delivered)
  2. Restore SO-2026-0001 and SO-2026-0002 to stock_reserved status
  3. Restore their reservations to active
  4. Remove the wrong adjustment transaction
*/

DO $$
DECLARE
  v_batch_id UUID := 'f767785c-1d74-4b03-b7be-1e6cd6b8282f';
  v_product_id UUID := 'f9ca763f-47c0-4bfa-b2a0-1905152458c6';
  v_so1_id UUID;
  v_so2_id UUID;
BEGIN
  SELECT id INTO v_so1_id FROM sales_orders WHERE so_number = 'SO-2026-0001';
  SELECT id INTO v_so2_id FROM sales_orders WHERE so_number = 'SO-2026-0002';

  -- 1. Restore physical batch stock to 150 (200 imported - 50 delivered via DCs)
  UPDATE batches
  SET current_stock = 150
  WHERE id = v_batch_id;

  -- 2. Restore product current_stock
  UPDATE products
  SET current_stock = 150
  WHERE id = v_product_id;

  -- 3. Restore SO-2026-0001 to active
  UPDATE sales_orders
  SET status = 'stock_reserved', updated_at = NOW()
  WHERE id = v_so1_id;

  -- 4. Restore SO-2026-0002 to active
  UPDATE sales_orders
  SET status = 'stock_reserved', updated_at = NOW()
  WHERE id = v_so2_id;

  -- 5. Restore reservations for both SOs to active
  UPDATE stock_reservations
  SET status = 'active',
      is_released = false,
      released_at = NULL,
      release_reason = NULL
  WHERE sales_order_id IN (v_so1_id, v_so2_id);

  -- 6. Restore batch reserved_stock to 60 (30+30 from the two SOs) + 20 from SO-0008 = 80
  UPDATE batches
  SET reserved_stock = COALESCE((
    SELECT SUM(sr.reserved_quantity)
    FROM stock_reservations sr
    WHERE sr.batch_id = v_batch_id AND sr.status = 'active'
  ), 0)
  WHERE id = v_batch_id;

  -- 7. Remove the wrong adjustment transaction from previous fix
  DELETE FROM inventory_transactions
  WHERE reference_number = 'ADJ-DEXT-2602'
    AND reference_type = 'manual_adjustment'
    AND batch_id = v_batch_id;

END $$;
