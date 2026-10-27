/*
  Reconcile Purchase Invoice receiving against both the canonical allocation
  ledger and older inventory purchase movements.  No historical rows are
  changed and canonical movements are not counted twice when their operation
  id is already represented by a receiving allocation.
*/

CREATE OR REPLACE FUNCTION public.purchase_invoice_item_received_quantity(p_item_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.purchase_invoice_items%ROWTYPE;
  v_allocated numeric := 0;
  v_legacy numeric := 0;
BEGIN
  SELECT * INTO v_item FROM public.purchase_invoice_items WHERE id = p_item_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT COALESCE(sum(received_quantity), 0)
    INTO v_allocated
    FROM public.purchase_invoice_receiving_allocations
   WHERE purchase_invoice_item_id = p_item_id AND status = 'received';

  SELECT COALESCE(sum(abs(it.quantity)), 0)
    INTO v_legacy
    FROM public.inventory_transactions it
    JOIN public.batches b ON b.id = it.batch_id
   WHERE it.transaction_type = 'purchase'
     AND it.quantity > 0
     AND NOT EXISTS (
       SELECT 1
         FROM public.purchase_invoice_receiving_allocations a
        WHERE a.purchase_invoice_item_id = p_item_id
          AND a.status = 'received'
          AND a.operation_id = it.operation_id
     )
     AND (
       -- Explicit item/invoice references are authoritative.
       it.reference_id = p_item_id
       OR (
         it.reference_id = v_item.purchase_invoice_id
         AND b.purchase_invoice_id = v_item.purchase_invoice_id
         AND b.product_id = v_item.product_id
         AND (
           (v_item.batch_id IS NOT NULL AND b.id = v_item.batch_id)
           OR (
             NULLIF(v_item.receiving_batch_number, '') IS NOT NULL
             AND b.batch_number = v_item.receiving_batch_number
           )
         )
       )
       OR (
         -- Legacy batch ownership plus the invoice line's stored batch or
         -- batch number is accepted only when the identity is unambiguous.
         b.purchase_invoice_id = v_item.purchase_invoice_id
         AND b.product_id = v_item.product_id
         AND (
           (v_item.batch_id IS NOT NULL AND b.id = v_item.batch_id)
           OR (
             NULLIF(v_item.receiving_batch_number, '') IS NOT NULL
             AND b.batch_number = v_item.receiving_batch_number
           )
         )
       )
       OR (
       it.reference_number = v_item.receiving_batch_number
         AND NULLIF(v_item.receiving_batch_number, '') IS NOT NULL
         AND b.purchase_invoice_id = v_item.purchase_invoice_id
         AND b.product_id = v_item.product_id
       )
     );

  RETURN COALESCE(v_allocated, 0) + COALESCE(v_legacy, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.purchase_invoice_item_received_totals(p_item_ids uuid[])
RETURNS TABLE(purchase_invoice_item_id uuid, received_quantity numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, public.purchase_invoice_item_received_quantity(i.id)
    FROM public.purchase_invoice_items i
   WHERE i.id = ANY(COALESCE(p_item_ids, ARRAY[]::uuid[]));
$$;

CREATE OR REPLACE FUNCTION public.guard_purchase_invoice_item_received_quantity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_received numeric;
BEGIN
  IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    v_received := public.purchase_invoice_item_received_quantity(NEW.id);
    IF NEW.quantity < v_received - 0.01 THEN
      RAISE EXCEPTION 'Purchase Invoice quantity % is below already received quantity %; use a controlled inventory correction', NEW.quantity, v_received
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_purchase_invoice_item_received_quantity
  ON public.purchase_invoice_items;
CREATE TRIGGER trg_guard_purchase_invoice_item_received_quantity
BEFORE UPDATE OF quantity ON public.purchase_invoice_items
FOR EACH ROW EXECUTE FUNCTION public.guard_purchase_invoice_item_received_quantity();

REVOKE ALL ON FUNCTION public.purchase_invoice_item_received_quantity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_invoice_item_received_quantity(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.purchase_invoice_item_received_totals(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_invoice_item_received_totals(uuid[]) TO authenticated;

-- Apply the same true-received guard inside the receiving RPC.  This is kept
-- in the database so UI calculations and writes cannot diverge.
CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(
  p_purchase_invoice_item_id uuid, p_payload jsonb,
  p_received_quantity numeric, p_operation_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.purchase_invoice_items%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_batch_id uuid; v_existing numeric; v_product_id uuid; v_make_id uuid;
  v_allocation_id uuid; v_batch public.batches%ROWTYPE;
  v_new_batch boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse','manager']) THEN RAISE EXCEPTION 'Permission denied for inventory receiving'; END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN RAISE EXCEPTION 'A positive quantity and operation_id are required'; END IF;
  SELECT * INTO v_item FROM public.purchase_invoice_items WHERE id=p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id=v_item.purchase_invoice_id;
  v_product_id := NULLIF(p_payload->>'product_id','')::uuid;
  v_make_id := NULLIF(p_payload->>'make_id','')::uuid;
  IF v_item.item_type <> 'inventory' OR v_item.product_id IS NULL OR v_product_id IS DISTINCT FROM v_item.product_id THEN RAISE EXCEPTION 'Receiving requires the invoice inventory product'; END IF;
  IF v_make_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.product_sources WHERE id=v_make_id AND product_id=v_item.product_id) THEN RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the invoice product'; END IF;
  SELECT batch_id INTO v_batch_id FROM public.purchase_invoice_receiving_allocations WHERE operation_id=p_operation_id;
  IF FOUND THEN RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'idempotent_retry',true); END IF;
  v_existing := public.purchase_invoice_item_received_quantity(v_item.id);
  IF v_existing + p_received_quantity > v_item.quantity + 0.01 THEN RAISE EXCEPTION 'Received quantity exceeds true invoice line outstanding quantity'; END IF;
  IF NULLIF(p_payload->>'batch_id','') IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches WHERE id=(p_payload->>'batch_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN RAISE EXCEPTION 'Product does not match selected batch'; END IF;
    IF v_batch.make_id IS NOT NULL AND v_batch.make_id IS DISTINCT FROM v_make_id THEN RAISE EXCEPTION 'Make does not match selected batch'; END IF;
    IF NULLIF(p_payload->>'import_container_id','')::uuid IS DISTINCT FROM v_batch.import_container_id THEN RAISE EXCEPTION 'Import Container does not match selected batch'; END IF;
    PERFORM public.post_inventory_movement(p_operation_id,v_batch.product_id,v_batch.id,'adjustment',p_received_quantity,v_invoice.invoice_date,v_invoice.invoice_number,'purchase_invoice_receiving',v_invoice.id,'Purchase Invoice receiving into existing batch '||v_batch.batch_number,auth.uid(),v_batch.current_stock,v_batch.current_stock+p_received_quantity);
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload,'{import_quantity}',to_jsonb(p_received_quantity),true);
    p_payload := jsonb_set(p_payload,'{purchase_invoice_id}',to_jsonb(v_item.purchase_invoice_id),true);
    p_payload := jsonb_set(p_payload,'{supplier_id}',to_jsonb(v_invoice.supplier_id),true);
    SELECT (public.save_batch_inventory_v1(NULL,p_payload,p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
    v_new_batch := true;
  END IF;
  IF v_new_batch THEN UPDATE public.batches SET purchase_invoice_id=v_item.purchase_invoice_id,supplier_id=v_invoice.supplier_id WHERE id=v_batch_id; END IF;
  INSERT INTO public.purchase_invoice_receiving_allocations(purchase_invoice_id,purchase_invoice_item_id,batch_id,received_quantity,operation_id,received_by)
  VALUES(v_item.purchase_invoice_id,v_item.id,v_batch_id,p_received_quantity,p_operation_id,auth.uid()) RETURNING id INTO v_allocation_id;
  RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'allocation_id',v_allocation_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) TO authenticated;
