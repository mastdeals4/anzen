/*
  # Add idempotency guard for inventory stock movement RPC

  1. Add operation_id to inventory_transactions for duplicate protection.
  2. Enforce uniqueness on operation_id when provided.
  3. Update adjust_batch_stock_atomic() to require p_operation_id and return
     existing transaction result when operation was already processed.

  Business logic for stock mutation remains unchanged.
*/

ALTER TABLE inventory_transactions
ADD COLUMN IF NOT EXISTS operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_transactions_operation_id_unique
ON inventory_transactions(operation_id)
WHERE operation_id IS NOT NULL;

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
DECLARE
  v_transaction_id UUID;
  v_new_stock NUMERIC;
  v_product_id UUID;
  v_existing_txn UUID;
BEGIN
  -- Idempotency guard: if operation already exists, return existing result.
  SELECT id INTO v_existing_txn
  FROM inventory_transactions
  WHERE operation_id = p_operation_id;

  IF v_existing_txn IS NOT NULL THEN
    SELECT current_stock INTO v_new_stock
    FROM batches
    WHERE id = p_batch_id;

    RETURN QUERY SELECT v_new_stock, v_existing_txn;
    RETURN;
  END IF;

  -- Get product_id for transaction record
  SELECT product_id INTO v_product_id
  FROM batches
  WHERE id = p_batch_id;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Batch not found: %', p_batch_id;
  END IF;

  -- Atomically update batch stock
  UPDATE batches
  SET current_stock = current_stock + p_quantity_change
  WHERE id = p_batch_id
  RETURNING current_stock INTO v_new_stock;

  -- Create inventory transaction record
  INSERT INTO inventory_transactions (
    product_id,
    batch_id,
    transaction_type,
    quantity,
    operation_id,
    reference_id,
    notes,
    created_by
  ) VALUES (
    v_product_id,
    p_batch_id,
    p_transaction_type,
    ABS(p_quantity_change),
    p_operation_id,
    p_reference_id,
    p_notes,
    p_created_by
  )
  RETURNING id INTO v_transaction_id;

  RETURN QUERY SELECT v_new_stock, v_transaction_id;
END;
$$;

COMMENT ON FUNCTION adjust_batch_stock_atomic IS 'Atomically adjusts batch stock with DB-side calculation and idempotency protection using operation_id.';
