/*
  # Fix Dextromethorphan Hydrobromide USP Stock

  ## Problem
  - Physical stock shows 150 kg, but should be 90 kg
  - SO-2026-0001 and SO-2026-0002 are stale test orders (unit_price = Rp 78, no DCs, 
    no invoices, created in Jan 2026) but have 30 kg active reservations each = 60 kg locked
  - The actual 60 kg they represent was physically delivered without being recorded in the system
  
  ## Fix
  1. Record a stock adjustment of -60 kg for the batch (to correct physical stock from 150 to 90)
  2. Release the reservations for SO-26-0001 and SO-26-0002
  3. Cancel / close those stale SOs
  4. Sync product current_stock from batch

  ## Result
  - Physical stock: 90 kg
  - Active reservations: 20 kg (SO-26-0008 remains)
  - Available stock: 70 kg
*/

DO $$
DECLARE
  v_batch_id UUID := 'f767785c-1d74-4b03-b7be-1e6cd6b8282f';
  v_product_id UUID := 'f9ca763f-47c0-4bfa-b2a0-1905152458c6';
  v_so1_id UUID;
  v_so2_id UUID;
BEGIN
  -- Get SO IDs
  SELECT id INTO v_so1_id FROM sales_orders WHERE so_number = 'SO-2026-0001';
  SELECT id INTO v_so2_id FROM sales_orders WHERE so_number = 'SO-2026-0002';

  -- 1. Record stock adjustment of -60 kg to correct physical stock (150 -> 90)
  INSERT INTO inventory_transactions (
    product_id, batch_id, transaction_type, quantity,
    transaction_date, reference_number, reference_type,
    notes, created_by, stock_before, stock_after
  ) VALUES (
    v_product_id, v_batch_id, 'adjustment', -60,
    CURRENT_DATE, 'ADJ-DEXT-2602', 'manual_adjustment',
    'Stock correction: 60 kg delivered to ERELA via SO-2026-0001 (30 kg) and SO-2026-0002 (30 kg) without DC/invoice documentation',
    (SELECT id FROM auth.users LIMIT 1),
    150, 90
  );

  -- 2. Update batch physical stock: 150 - 60 = 90
  UPDATE batches
  SET current_stock = 90
  WHERE id = v_batch_id;

  -- 3. Release reservations for SO-26-0001
  IF v_so1_id IS NOT NULL THEN
    UPDATE stock_reservations
    SET status = 'released',
        is_released = true,
        released_at = NOW(),
        release_reason = 'SO cancelled - delivered without DC documentation'
    WHERE sales_order_id = v_so1_id AND status = 'active';

    -- Close the SO
    UPDATE sales_orders
    SET status = 'closed',
        updated_at = NOW()
    WHERE id = v_so1_id;
  END IF;

  -- 4. Release reservations for SO-26-0002
  IF v_so2_id IS NOT NULL THEN
    UPDATE stock_reservations
    SET status = 'released',
        is_released = true,
        released_at = NOW(),
        release_reason = 'SO cancelled - delivered without DC documentation'
    WHERE sales_order_id = v_so2_id AND status = 'active';

    -- Close the SO
    UPDATE sales_orders
    SET status = 'closed',
        updated_at = NOW()
    WHERE id = v_so2_id;
  END IF;

  -- 5. Update batch reserved_stock (remove the 60 kg that was reserved for closed SOs)
  UPDATE batches
  SET reserved_stock = COALESCE((
    SELECT SUM(sr.reserved_quantity)
    FROM stock_reservations sr
    WHERE sr.batch_id = v_batch_id AND sr.status = 'active'
  ), 0)
  WHERE id = v_batch_id;

  -- 6. Sync product current_stock from batch
  UPDATE products
  SET current_stock = 90
  WHERE id = v_product_id;

END $$;
