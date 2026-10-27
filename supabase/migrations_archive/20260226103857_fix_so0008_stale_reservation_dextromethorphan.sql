/*
  # Fix SO-2026-0008 Stale Reservation for Dextromethorphan

  ## Problem
  DO-26-0006 delivered 20 kg of Dextromethorphan Hydrobromide USP and was invoiced
  as SAPJ-26-006. However, SO-2026-0008 (same 20 kg for PT Prima Cita Persada)
  was NOT linked to the DC/invoice, so its stock reservation was never released.

  ## Correct State
  - Physical stock: 150 kg (200 imported - 50 delivered)
  - Reserved: 60 kg (SO-0001: 30 kg + SO-0002: 30 kg — still pending)
  - Free available: 90 kg

  ## Fix
  - Release SO-2026-0008 reservation (delivery already happened via DO-26-0006)
  - Link SO-2026-0008 to the delivery challan DO-26-0006 and mark it closed
  - Update batch reserved_stock
*/

DO $$
DECLARE
  v_batch_id UUID := 'f767785c-1d74-4b03-b7be-1e6cd6b8282f';
  v_product_id UUID := 'f9ca763f-47c0-4bfa-b2a0-1905152458c6';
  v_so8_id UUID;
  v_dc_id UUID;
BEGIN
  SELECT id INTO v_so8_id FROM sales_orders WHERE so_number = 'SO-2026-0008';
  SELECT id INTO v_dc_id FROM delivery_challans WHERE challan_number = 'DO-26-0006';

  -- Release the stale reservation for SO-2026-0008
  UPDATE stock_reservations
  SET status = 'released',
      is_released = true,
      released_at = NOW(),
      release_reason = 'Delivered via DO-26-0006 / SAPJ-26-006 without SO link — reservation released post-delivery'
  WHERE sales_order_id = v_so8_id AND status = 'active';

  -- Link DC to SO and close the SO
  IF v_dc_id IS NOT NULL AND v_so8_id IS NOT NULL THEN
    UPDATE delivery_challans
    SET sales_order_id = v_so8_id
    WHERE id = v_dc_id AND sales_order_id IS NULL;
  END IF;

  UPDATE sales_orders
  SET status = 'closed', updated_at = NOW()
  WHERE id = v_so8_id;

  -- Recalculate batch reserved_stock from active reservations only
  UPDATE batches
  SET reserved_stock = COALESCE((
    SELECT SUM(sr.reserved_quantity)
    FROM stock_reservations sr
    WHERE sr.batch_id = v_batch_id AND sr.status = 'active'
  ), 0)
  WHERE id = v_batch_id;

END $$;
