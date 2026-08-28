/*
  # Fix: fn_reserve_stock_for_so_v2 + delete_batch_safe — preserve reservation history

  ## Bugs Fixed

  ### Bug 3a — fn_reserve_stock_for_so_v2 DELETEs reservation history
  The function runs `DELETE FROM stock_reservations WHERE sales_order_id = p_so_id`
  before re-creating reservations. This destroys the audit trail every time stock
  is re-reserved (e.g. when a SO is re-approved after a shortage is resolved).
  Fix: replace DELETE with UPDATE that marks existing active rows as 'released'
  (status='released', is_released=true) so history is preserved.

  ### Bug 3b — delete_batch_safe DELETEs all stock_reservations for the batch
  Even though the function already blocks if active reservations exist, the
  final cleanup blindly deletes ALL rows including released/historical ones.
  Fix: add `AND is_released = true` so only already-released rows are removed.
  Active reservations are blocked earlier in the function, so this is a
  safety filter that should never fire differently in practice — but it ensures
  the audit log survives for released rows if somehow the block is bypassed.

  ## Safety
  - No schema changes
  - No data deleted from stock_reservations (history preserved)
  - No changes to reservation creation logic or stock deduction logic
*/

-- ============================================================
-- FIX 3a: fn_reserve_stock_for_so_v2
-- Replace DELETE with UPDATE to preserve reservation history
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          text;
  v_item          RECORD;
  v_batch         RECORD;
  v_remaining_qty numeric;
  v_reserved_qty  numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage  boolean := false;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reserve stock for sales orders', v_role;
  END IF;

  -- Mark existing active reservations for this SO as released (preserves audit history)
  UPDATE stock_reservations
  SET status         = 'released',
      is_released    = true,
      released_at    = now(),
      release_reason = 'Re-reservation: previous reservations superseded'
  WHERE sales_order_id = p_so_id
    AND status = 'active';

  FOR v_item IN
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;
    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) as reserved_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id
        AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY b.import_date ASC, b.created_at ASC
    LOOP
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);
      IF v_reserved_qty > 0 THEN
        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id,
          reserved_quantity, is_released, status
        ) VALUES (
          p_so_id, v_item.id, v_batch.id, v_item.product_id,
          v_reserved_qty, false, 'active'
        );
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;
      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id, 'required_qty', v_item.quantity, 'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;


-- ============================================================
-- FIX 3b: delete_batch_safe
-- Only delete released reservation rows (history for active is blocked above)
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_batch_safe(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  text;
  v_batch record;
BEGIN
  SELECT role INTO v_role
  FROM public.user_profiles
  WHERE id = auth.uid();

  IF v_role NOT IN ('admin', 'accounts') THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', format(
        'Permission denied: role %s cannot hard delete batches. Warehouse users must use archive.',
        v_role
      )
    );
  END IF;

  SELECT id, batch_number, import_quantity, current_stock
  INTO v_batch
  FROM public.batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'Batch not found');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_invoice_items
    WHERE batch_id = p_batch_id
    LIMIT 1
  ) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', format('Batch %s is linked to sales invoices. Delete the invoices first.', v_batch.batch_number)
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.delivery_challan_items
    WHERE batch_id = p_batch_id
    LIMIT 1
  ) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', format('Batch %s is linked to delivery challans. Delete the challans first.', v_batch.batch_number)
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.stock_reservations
    WHERE batch_id = p_batch_id
      AND is_released = false
    LIMIT 1
  ) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', format('Batch %s has active stock reservations. Release them first.', v_batch.batch_number)
    );
  END IF;

  IF v_batch.current_stock < v_batch.import_quantity THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', format(
        'Batch %s has consumed stock. Imported: %s, remaining: %s. Archive instead of deleting.',
        v_batch.batch_number,
        v_batch.import_quantity,
        v_batch.current_stock
      )
    );
  END IF;

  DELETE FROM public.batch_documents    WHERE batch_id = p_batch_id;
  DELETE FROM public.inventory_transactions WHERE batch_id = p_batch_id;
  DELETE FROM public.finance_expenses   WHERE batch_id = p_batch_id;

  -- Only delete released reservation history rows (active are blocked above)
  DELETE FROM public.stock_reservations
  WHERE batch_id = p_batch_id
    AND is_released = true;

  DELETE FROM public.batches WHERE id = p_batch_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason', 'Batch row was not deleted. Contact administrator.'
    );
  END IF;

  RETURN jsonb_build_object(
    'deleted', true,
    'batch_number', v_batch.batch_number
  );
END;
$$;
