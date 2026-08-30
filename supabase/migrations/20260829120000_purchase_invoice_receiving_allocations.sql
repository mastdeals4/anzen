-- Phase 2: explicit Purchase Invoice -> inventory receiving allocations.
-- Saving an invoice remains finance-only; this RPC is the receiving boundary.
CREATE TABLE IF NOT EXISTS public.purchase_invoice_receiving_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_invoice_id uuid NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE RESTRICT,
  purchase_invoice_item_id uuid NOT NULL REFERENCES public.purchase_invoice_items(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  received_quantity numeric NOT NULL CHECK (received_quantity > 0),
  operation_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','voided')),
  received_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES public.user_profiles(id),
  UNIQUE (purchase_invoice_item_id, batch_id, status)
);

CREATE INDEX IF NOT EXISTS idx_pi_receiving_alloc_invoice ON public.purchase_invoice_receiving_allocations(purchase_invoice_id);
CREATE INDEX IF NOT EXISTS idx_pi_receiving_alloc_item ON public.purchase_invoice_receiving_allocations(purchase_invoice_item_id);

CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(
  p_purchase_invoice_item_id uuid,
  p_payload jsonb,
  p_received_quantity numeric,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item purchase_invoice_items%ROWTYPE;
  v_invoice purchase_invoices%ROWTYPE;
  v_batch_id uuid;
  v_existing numeric;
  v_product_id uuid;
  v_allocation_id uuid;
  v_batch public.batches%ROWTYPE;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse','manager']) THEN
    RAISE EXCEPTION 'Permission denied for inventory receiving';
  END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
    RAISE EXCEPTION 'A positive quantity and operation_id are required';
  END IF;

  SELECT * INTO v_item FROM purchase_invoice_items WHERE id = p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM purchase_invoices WHERE id = v_item.purchase_invoice_id;
  v_product_id := (p_payload->>'product_id')::uuid;
  IF v_item.item_type <> 'inventory' OR v_item.product_id IS NULL OR v_product_id IS DISTINCT FROM v_item.product_id THEN
    RAISE EXCEPTION 'Receiving requires the invoice inventory product';
  END IF;

  SELECT batch_id INTO v_batch_id FROM purchase_invoice_receiving_allocations WHERE operation_id = p_operation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'idempotent_retry',true);
  END IF;

  SELECT COALESCE(SUM(received_quantity),0) INTO v_existing
    FROM purchase_invoice_receiving_allocations
   WHERE purchase_invoice_item_id = v_item.id AND status = 'received';
  IF v_existing + p_received_quantity > v_item.quantity THEN
    RAISE EXCEPTION 'Received quantity exceeds invoice line quantity';
  END IF;

  IF NULLIF(p_payload->>'batch_id','') IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches WHERE id = (p_payload->>'batch_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN RAISE EXCEPTION 'Product does not match selected batch'; END IF;
    IF v_batch.make_id IS DISTINCT FROM NULLIF(p_payload->>'make_id','')::uuid THEN RAISE EXCEPTION 'Make does not match selected batch'; END IF;
    IF NULLIF(p_payload->>'import_container_id','')::uuid IS DISTINCT FROM v_batch.import_container_id THEN
      RAISE EXCEPTION 'Import Container does not match selected batch';
    END IF;
    PERFORM public.post_inventory_movement(p_operation_id, v_batch.product_id, v_batch.id, 'adjustment', p_received_quantity,
      v_invoice.invoice_date, v_invoice.invoice_number, 'purchase_invoice_receiving', v_invoice.id,
      'Purchase Invoice receiving into existing batch ' || v_batch.batch_number, auth.uid(), v_batch.current_stock, v_batch.current_stock + p_received_quantity);
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload, '{import_quantity}', to_jsonb(p_received_quantity), true);
    p_payload := jsonb_set(p_payload, '{purchase_invoice_id}', to_jsonb(v_item.purchase_invoice_id), true);
    p_payload := jsonb_set(p_payload, '{supplier_id}', to_jsonb(v_invoice.supplier_id), true);
    SELECT (public.save_batch_inventory_v1(NULL, p_payload, p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
  END IF;
  UPDATE batches SET purchase_invoice_id = v_item.purchase_invoice_id, supplier_id = v_invoice.supplier_id WHERE id = v_batch_id;

  INSERT INTO purchase_invoice_receiving_allocations(purchase_invoice_id,purchase_invoice_item_id,batch_id,received_quantity,operation_id,received_by)
  VALUES (v_item.purchase_invoice_id,v_item.id,v_batch_id,p_received_quantity,p_operation_id,auth.uid())
  RETURNING id INTO v_allocation_id;
  RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'allocation_id',v_allocation_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) TO authenticated;
