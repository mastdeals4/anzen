/*
  Add delete_batch_safe RPC for admin / accounts hard delete.

  Problem with client-side hard delete:
  - Supabase .delete() returns error=null even when RLS silently blocks.
  - Child table deletes (batch_documents, inventory_transactions,
    finance_expenses) happen as separate round-trips — not atomic.
  - If one child delete is blocked silently, the batch row still gets
    deleted and the children are orphaned; or the batch row is left
    intact while children are already gone.

  Solution: SECURITY DEFINER function that:
  1. Enforces role check server-side (admin/accounts only; warehouse denied).
  2. Re-checks all link tables inside the transaction (race-safe).
  3. Deletes children + parent in one PL/pgSQL block.
  4. Uses `IF NOT FOUND` after the final batch DELETE to confirm the row
     was actually removed.
  5. Returns structured JSONB: {deleted: boolean, reason?: text}.

  Warehouse hard delete is never allowed — they call archive (is_active=false)
  from the frontend, which has its own re-fetch verification.
*/

CREATE OR REPLACE FUNCTION public.delete_batch_safe(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role          text;
  v_batch         record;
BEGIN
  -- Role guard: admin / accounts only
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Permission denied: role %s cannot hard delete batches. Warehouse users must use archive.', v_role)
    );
  END IF;

  -- Fetch batch (lock the row for the duration of this transaction)
  SELECT id, batch_number, import_quantity, current_stock
  INTO   v_batch
  FROM   batches
  WHERE  id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'Batch not found');
  END IF;

  -- Guard: linked to sales invoices
  IF EXISTS (SELECT 1 FROM sales_invoice_items WHERE batch_id = p_batch_id LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s is linked to sales invoices. Delete the invoices first.', v_batch.batch_number)
    );
  END IF;

  -- Guard: linked to delivery challans
  IF EXISTS (SELECT 1 FROM delivery_challan_items WHERE batch_id = p_batch_id LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s is linked to delivery challans. Delete the challans first.', v_batch.batch_number)
    );
  END IF;

  -- Guard: active stock reservations
  IF EXISTS (SELECT 1 FROM stock_reservations WHERE batch_id = p_batch_id AND is_released = false LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s has active stock reservations. Release them first.', v_batch.batch_number)
    );
  END IF;

  -- Guard: stock has been consumed
  IF v_batch.current_stock < v_batch.import_quantity THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format(
        'Batch %s has consumed stock (imported: %s, remaining: %s). Archive instead of deleting.',
        v_batch.batch_number, v_batch.import_quantity, v_batch.current_stock
      )
    );
  END IF;

  -- All checks passed — delete in dependency order inside this transaction.
  -- SECURITY DEFINER means these run as the function owner (bypasses RLS).
  DELETE FROM batch_documents       WHERE batch_id = p_batch_id;
  DELETE FROM inventory_transactions WHERE batch_id = p_batch_id;
  DELETE FROM finance_expenses       WHERE batch_id = p_batch_id;
  DELETE FROM stock_reservations     WHERE batch_id = p_batch_id;  -- released ones

  DELETE FROM batches WHERE id = p_batch_id;

  -- FOUND is false if the final DELETE matched 0 rows (should never happen
  -- given the FOR UPDATE lock, but guard against it anyway)
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  'Batch row was not deleted (unexpected). Contact your administrator.'
    );
  END IF;

  RETURN jsonb_build_object('deleted', true, 'batch_number', v_batch.batch_number);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_batch_safe(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_batch_safe(uuid) TO authenticated;
