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
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Permission denied: role %s cannot hard delete batches. Warehouse users must use archive.', v_role)
    );
  END IF;

  SELECT id, batch_number, import_quantity, current_stock
  INTO   v_batch
  FROM   batches
  WHERE  id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false, 'reason', 'Batch not found');
  END IF;

  IF EXISTS (SELECT 1 FROM sales_invoice_items WHERE batch_id = p_batch_id LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s is linked to sales invoices. Delete the invoices first.', v_batch.batch_number)
    );
  END IF;

  IF EXISTS (SELECT 1 FROM delivery_challan_items WHERE batch_id = p_batch_id LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s is linked to delivery challans. Delete the challans first.', v_batch.batch_number)
    );
  END IF;

  IF EXISTS (SELECT 1 FROM stock_reservations WHERE batch_id = p_batch_id AND is_released = false LIMIT 1) THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format('Batch %s has active stock reservations. Release them first.', v_batch.batch_number)
    );
  END IF;

  IF v_batch.current_stock < v_batch.import_quantity THEN
    RETURN jsonb_build_object(
      'deleted', false,
      'reason',  format(
        'Batch %s has consumed stock (imported: %s, remaining: %s). Archive instead of deleting.',
        v_batch.batch_number, v_batch.import_quantity, v_batch.current_stock
      )
    );
  END IF;

  DELETE FROM batch_documents       WHERE batch_id = p_batch_id;
  DELETE FROM inventory_transactions WHERE batch_id = p_batch_id;
  DELETE FROM finance_expenses       WHERE batch_id = p_batch_id;
  DELETE FROM stock_reservations     WHERE batch_id = p_batch_id;

  DELETE FROM batches WHERE id = p_batch_id;

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
