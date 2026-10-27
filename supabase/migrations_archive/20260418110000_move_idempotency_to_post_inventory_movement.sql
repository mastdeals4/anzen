/*
  # Move inventory idempotency into post_inventory_movement

  1. Add operation_id to inventory_transactions for idempotency key storage
  2. Create post_inventory_movement() as the canonical stock movement function
  3. Require p_operation_id and move idempotency checks into post_inventory_movement()
  4. Keep adjust_batch_stock_atomic() as a compatibility wrapper that routes through post_inventory_movement()
*/

ALTER TABLE inventory_transactions
ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_transactions_operation_id
ON inventory_transactions (operation_id)
WHERE operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION post_inventory_movement(
  p_batch_id UUID,
  p_quantity_change NUMERIC,
  p_transaction_type TEXT,
  p_operation_id UUID,
  p_reference_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
)
RETURNS TABLE(
  new_stock NUMERIC,
  transaction_id UUID,
  stock_before NUMERIC,
  stock_after NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_existing_txn_id UUID;
  v_existing_stock_before NUMERIC;
  v_existing_stock_after NUMERIC;
  v_transaction_id UUID;
  v_new_stock NUMERIC;
  v_stock_before NUMERIC;
  v_product_id UUID;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'p_operation_id is required';
  END IF;

  SELECT it.id, it.stock_before, it.stock_after
  INTO v_existing_txn_id, v_existing_stock_before, v_existing_stock_after
  FROM inventory_transactions it
  WHERE it.operation_id = p_operation_id;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing_stock_after,
      v_existing_txn_id,
      v_existing_stock_before,
      v_existing_stock_after;
    RETURN;
  END IF;

  SELECT b.product_id, b.current_stock
  INTO v_product_id, v_stock_before
  FROM batches b
  WHERE b.id = p_batch_id
  FOR UPDATE;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;

  v_new_stock := v_stock_before + p_quantity_change;

  UPDATE batches
  SET current_stock = v_new_stock
  WHERE id = p_batch_id;

  INSERT INTO inventory_transactions (
    product_id,
    batch_id,
    transaction_type,
    quantity,
    reference_id,
    notes,
    created_by,
    operation_id,
    stock_before,
    stock_after
  ) VALUES (
    v_product_id,
    p_batch_id,
    p_transaction_type,
    ABS(p_quantity_change),
    p_reference_id,
    p_notes,
    p_created_by,
    p_operation_id,
    v_stock_before,
    v_new_stock
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT v_new_stock, v_transaction_id, v_stock_before, v_new_stock;
END;
$$;

COMMENT ON FUNCTION post_inventory_movement IS 'Canonical inventory stock movement function with idempotency via operation_id.';

CREATE OR REPLACE FUNCTION adjust_batch_stock_atomic(
  p_batch_id UUID,
  p_quantity_change NUMERIC,
  p_transaction_type TEXT,
  p_operation_id UUID,
  p_reference_id UUID DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_created_by UUID DEFAULT NULL
)
RETURNS TABLE(new_stock NUMERIC, transaction_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT pim.new_stock, pim.transaction_id
  FROM post_inventory_movement(
    p_batch_id => p_batch_id,
    p_quantity_change => p_quantity_change,
    p_transaction_type => p_transaction_type,
    p_operation_id => p_operation_id,
    p_reference_id => p_reference_id,
    p_notes => p_notes,
    p_created_by => p_created_by
  ) AS pim;
END;
$$;

COMMENT ON FUNCTION adjust_batch_stock_atomic IS 'Compatibility wrapper for post_inventory_movement().';
