-- Inventory V1 hardening: disable the pre-V1 six-argument stock adjustment
-- overload.  The overload directly updated batches and persisted ABS(quantity),
-- bypassing operation_id idempotency and the canonical movement engine.
-- The seven-argument V1 overload is the only supported adjustment API.

CREATE OR REPLACE FUNCTION public.adjust_batch_stock_atomic(
  p_batch_id uuid,
  p_quantity_change numeric,
  p_transaction_type text,
  p_reference_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS TABLE(new_stock numeric, transaction_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'Legacy adjust_batch_stock_atomic signature is disabled; use the canonical seven-argument API with operation_id';
END;
$$;

REVOKE ALL ON FUNCTION public.adjust_batch_stock_atomic(
  uuid, numeric, text, uuid, text, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.adjust_batch_stock_atomic(
  uuid, numeric, text, uuid, text, uuid
) TO service_role;

COMMENT ON FUNCTION public.adjust_batch_stock_atomic(
  uuid, numeric, text, uuid, text, uuid
) IS 'Disabled legacy overload. Use the seven-argument Inventory V1 API with operation_id.';
