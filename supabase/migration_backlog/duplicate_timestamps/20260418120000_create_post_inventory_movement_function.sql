/*
  # Create post_inventory_movement RPC

  Adds a single atomic function to:
  1) Lock the batch row with FOR UPDATE
  2) Compute and persist new stock
  3) Record inventory transaction metadata
*/

CREATE OR REPLACE FUNCTION post_inventory_movement(
  p_product_id uuid,
  p_batch_id uuid,
  p_quantity numeric,
  p_movement_type text,
  p_reference_type text,
  p_reference_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  transaction_id uuid,
  stock_before numeric,
  stock_after numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_current_stock numeric;
  v_new_stock numeric;
  v_batch_product_id uuid;
  v_transaction_id uuid;
BEGIN
  -- Validate quantity explicitly to avoid accidental null arithmetic.
  IF p_quantity IS NULL THEN
    RAISE EXCEPTION 'Quantity cannot be null';
  END IF;

  -- Requirement #1: lock the target batch row.
  SELECT b.current_stock, b.product_id
  INTO v_current_stock, v_batch_product_id
  FROM batches b
  WHERE b.id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;

  IF v_batch_product_id IS DISTINCT FROM p_product_id THEN
    RAISE EXCEPTION 'Batch % does not belong to product %', p_batch_id, p_product_id;
  END IF;

  -- Requirement #2: new_stock = current_stock + p_quantity
  -- (negative p_quantity means stock out).
  v_new_stock := v_current_stock + p_quantity;

  UPDATE batches
  SET current_stock = v_new_stock,
      updated_at = now()
  WHERE id = p_batch_id;

  INSERT INTO inventory_transactions (
    product_id,
    batch_id,
    transaction_type,
    quantity,
    reference_type,
    reference_id,
    created_by,
    transaction_date
  ) VALUES (
    p_product_id,
    p_batch_id,
    p_movement_type,
    p_quantity,
    p_reference_type,
    p_reference_id,
    p_user_id,
    CURRENT_DATE
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY
  SELECT v_transaction_id, v_current_stock, v_new_stock;
END;
$$;

COMMENT ON FUNCTION post_inventory_movement(uuid, uuid, numeric, text, text, uuid, uuid)
IS 'Atomically posts inventory movement by row-locking batch stock, applying signed quantity, and logging the movement.';
