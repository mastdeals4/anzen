/*
 * Separate physical-lot identity from purchase cost layers.
 * This migration is forward-only: it does not rewrite historical batches,
 * inventory movements, purchase invoices, or COGS journals.
 */

CREATE TABLE IF NOT EXISTS public.purchase_batch_cost_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiving_allocation_id uuid NOT NULL UNIQUE REFERENCES public.purchase_invoice_receiving_allocations(id) ON DELETE RESTRICT,
  purchase_invoice_id uuid NOT NULL REFERENCES public.purchase_invoices(id) ON DELETE RESTRICT,
  purchase_invoice_item_id uuid NOT NULL REFERENCES public.purchase_invoice_items(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.batches(id) ON DELETE RESTRICT,
  import_container_id uuid REFERENCES public.import_containers(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  currency text NOT NULL,
  exchange_rate numeric NOT NULL CHECK (exchange_rate > 0),
  transaction_unit_cost numeric NOT NULL,
  functional_unit_cost numeric NOT NULL,
  functional_total_cost numeric NOT NULL,
  landed_cost_amount numeric NOT NULL DEFAULT 0,
  final_functional_unit_cost numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_batch_cost_layers_batch
  ON public.purchase_batch_cost_layers(batch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_batch_cost_layers_invoice
  ON public.purchase_batch_cost_layers(purchase_invoice_id);

ALTER TABLE public.purchase_invoice_receiving_allocations
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS functional_unit_cost numeric,
  ADD COLUMN IF NOT EXISTS functional_total_cost numeric,
  ADD COLUMN IF NOT EXISTS import_container_id uuid REFERENCES public.import_containers(id);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='batches_product_batch_number_key') THEN
    ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_batch_number_key;
    ALTER TABLE public.batches ADD CONSTRAINT batches_product_batch_number_key UNIQUE (product_id,batch_number);
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(
  p_purchase_invoice_item_id uuid,
  p_payload jsonb,
  p_received_quantity numeric,
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item purchase_invoice_items%ROWTYPE;
  v_invoice purchase_invoices%ROWTYPE;
  v_batch batches%ROWTYPE;
  v_batch_id uuid;
  v_make_id uuid;
  v_existing numeric;
  v_allocation_id uuid;
  v_currency text;
  v_rate numeric;
  v_tx_unit numeric;
  v_func_unit numeric;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse','manager']) THEN
    RAISE EXCEPTION 'Permission denied for inventory receiving';
  END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
    RAISE EXCEPTION 'A positive quantity and operation_id are required';
  END IF;
  SELECT * INTO v_item FROM purchase_invoice_items WHERE id=p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM purchase_invoices WHERE id=v_item.purchase_invoice_id;
  IF v_item.item_type<>'inventory' OR v_item.product_id IS NULL
     OR (p_payload->>'product_id')::uuid IS DISTINCT FROM v_item.product_id THEN
    RAISE EXCEPTION 'Receiving requires the invoice inventory product';
  END IF;
  v_make_id:=NULLIF(p_payload->>'make_id','')::uuid;
  IF v_make_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_sources WHERE id=v_make_id AND product_id=v_item.product_id) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the invoice product';
  END IF;
  SELECT batch_id INTO v_batch_id FROM purchase_invoice_receiving_allocations WHERE operation_id=p_operation_id;
  IF FOUND THEN RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'idempotent_retry',true); END IF;
  SELECT COALESCE(SUM(received_quantity),0) INTO v_existing
    FROM purchase_invoice_receiving_allocations WHERE purchase_invoice_item_id=v_item.id AND status='received';
  IF v_existing+p_received_quantity>v_item.quantity THEN RAISE EXCEPTION 'Received quantity exceeds invoice line quantity'; END IF;

  IF NULLIF(p_payload->>'batch_id','') IS NOT NULL THEN
    v_batch_id:=(p_payload->>'batch_id')::uuid;
  ELSE
    SELECT id INTO v_batch_id FROM batches
     WHERE product_id=v_item.product_id AND batch_number=p_payload->>'batch_number'
       AND (make_id=v_make_id OR make_id IS NULL) AND COALESCE(is_active,true)
     ORDER BY (make_id IS NULL), created_at LIMIT 1;
  END IF;

  IF v_batch_id IS NOT NULL THEN
    SELECT * INTO v_batch FROM batches WHERE id=v_batch_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found'; END IF;
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN RAISE EXCEPTION 'Product does not match selected batch'; END IF;
    IF v_batch.make_id IS NOT NULL AND v_batch.make_id IS DISTINCT FROM v_make_id THEN RAISE EXCEPTION 'Make does not match selected batch'; END IF;
    IF NULLIF(p_payload->>'expiry_date','')::date IS NOT NULL AND v_batch.expiry_date IS NOT NULL
       AND NULLIF(p_payload->>'expiry_date','')::date IS DISTINCT FROM v_batch.expiry_date THEN
      RAISE EXCEPTION 'Expiry date conflicts with existing physical batch';
    END IF;
    -- A second PI adds stock to the same physical lot; its price/FX/container
    -- are preserved in a separate cost layer and never overwrite this batch.
    PERFORM public.post_inventory_movement(p_operation_id,v_batch.product_id,v_batch.id,'adjustment',p_received_quantity,
      v_invoice.invoice_date,v_invoice.invoice_number,'purchase_invoice_receiving',v_invoice.id,
      'Purchase Invoice receiving into existing batch '||v_batch.batch_number,auth.uid(),v_batch.current_stock,v_batch.current_stock+p_received_quantity);
    UPDATE batches SET import_quantity=import_quantity+p_received_quantity, updated_at=now() WHERE id=v_batch.id;
  ELSE
    p_payload:=jsonb_set(p_payload,'{import_quantity}',to_jsonb(p_received_quantity),true);
    p_payload:=jsonb_set(p_payload,'{purchase_invoice_id}',to_jsonb(v_item.purchase_invoice_id),true);
    p_payload:=jsonb_set(p_payload,'{supplier_id}',to_jsonb(v_invoice.supplier_id),true);
    SELECT (public.save_batch_inventory_v1(NULL,p_payload,p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
    SELECT * INTO v_batch FROM batches WHERE id=v_batch_id;
  END IF;

  v_currency:=upper(COALESCE(v_invoice.currency,'IDR'));
  v_rate:=CASE WHEN v_currency='IDR' THEN 1 ELSE COALESCE(v_invoice.exchange_rate,0) END;
  IF v_rate<=0 THEN RAISE EXCEPTION 'Purchase invoice exchange rate is required'; END IF;
  v_tx_unit:=COALESCE(v_item.unit_price,0);
  v_func_unit:=round(v_tx_unit*v_rate,2);
  INSERT INTO purchase_invoice_receiving_allocations(
    purchase_invoice_id,purchase_invoice_item_id,batch_id,received_quantity,operation_id,received_by,currency,exchange_rate,functional_unit_cost,functional_total_cost,import_container_id
  ) VALUES(v_item.purchase_invoice_id,v_item.id,v_batch_id,p_received_quantity,p_operation_id,auth.uid(),v_currency,v_rate,v_func_unit,round(v_func_unit*p_received_quantity,2),NULLIF(p_payload->>'import_container_id','')::uuid)
  RETURNING id INTO v_allocation_id;
  INSERT INTO purchase_batch_cost_layers(
    receiving_allocation_id,purchase_invoice_id,purchase_invoice_item_id,batch_id,import_container_id,quantity,currency,exchange_rate,transaction_unit_cost,functional_unit_cost,functional_total_cost,final_functional_unit_cost
  ) VALUES(v_allocation_id,v_item.purchase_invoice_id,v_item.id,v_batch_id,NULLIF(p_payload->>'import_container_id','')::uuid,p_received_quantity,v_currency,v_rate,v_tx_unit,v_func_unit,round(v_func_unit*p_received_quantity,2),v_func_unit);
  RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'allocation_id',v_allocation_id);
END; $$;

REVOKE ALL ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid) TO authenticated;
