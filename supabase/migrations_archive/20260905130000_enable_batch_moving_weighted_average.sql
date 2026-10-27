/* Future multi-PI costing: physical batches use moving weighted average.
   Receipt layers remain immutable audit records; no historical rows are touched. */
BEGIN;

CREATE OR REPLACE FUNCTION public.apply_batch_receipt_weighted_average(
  p_batch_id uuid, p_received_quantity numeric, p_receipt_unit_cost numeric
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  b public.batches%ROWTYPE;
  prior_qty numeric;
  prior_cost numeric;
  new_cost numeric;
BEGIN
  SELECT * INTO b FROM public.batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR p_received_quantity <= 0 THEN RETURN; END IF;
  prior_qty := GREATEST(COALESCE(b.current_stock,0) - p_received_quantity, 0);
  prior_cost := COALESCE(NULLIF(b.landed_cost_per_unit,0), NULLIF(b.cost_per_unit,0), NULLIF(b.import_price,0), 0);
  new_cost := CASE WHEN prior_qty <= 0 THEN p_receipt_unit_cost
    ELSE ((prior_qty * prior_cost) + (p_received_quantity * p_receipt_unit_cost))
      / NULLIF(prior_qty + p_received_quantity,0) END;
  UPDATE public.batches
     SET cost_per_unit=round(new_cost,2), landed_cost_per_unit=round(new_cost,2), updated_at=now()
   WHERE id=p_batch_id AND COALESCE(cost_locked,false)=false;
END; $$;

-- Explicitly replace the receiving RPC.  This avoids brittle pg_get_functiondef
-- text replacement (which can inject escape characters and fail with 42601).
CREATE OR REPLACE FUNCTION public.receive_purchase_invoice_item(
  p_purchase_invoice_item_id uuid, p_payload jsonb,
  p_received_quantity numeric, p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item public.purchase_invoice_items%ROWTYPE;
  v_invoice public.purchase_invoices%ROWTYPE;
  v_batch public.batches%ROWTYPE;
  v_batch_id uuid;
  v_existing numeric;
  v_allocation_id uuid;
  v_make_id uuid;
  v_container_id uuid;
  v_currency text;
  v_rate numeric;
  v_tx_unit numeric;
  v_func_unit numeric;
  v_existing_batch boolean := false;
BEGIN
  IF NOT public.inventory_v1_actor_allowed(ARRAY['admin','accounts','warehouse','manager']) THEN
    RAISE EXCEPTION 'Permission denied for inventory receiving';
  END IF;
  IF p_operation_id IS NULL OR p_received_quantity IS NULL OR p_received_quantity <= 0 THEN
    RAISE EXCEPTION 'A positive quantity and operation_id are required';
  END IF;
  SELECT * INTO v_item FROM public.purchase_invoice_items WHERE id=p_purchase_invoice_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice item not found'; END IF;
  SELECT * INTO v_invoice FROM public.purchase_invoices WHERE id=v_item.purchase_invoice_id;
  IF v_item.item_type <> 'inventory' OR v_item.product_id IS NULL
     OR NULLIF(p_payload->>'product_id','')::uuid IS DISTINCT FROM v_item.product_id THEN
    RAISE EXCEPTION 'Receiving requires the invoice inventory product';
  END IF;
  SELECT batch_id,id INTO v_batch_id,v_allocation_id
    FROM public.purchase_invoice_receiving_allocations WHERE operation_id=p_operation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,
      'allocation_id',v_allocation_id,'idempotent_retry',true);
  END IF;
  SELECT COALESCE(sum(received_quantity),0) INTO v_existing
    FROM public.purchase_invoice_receiving_allocations
   WHERE purchase_invoice_item_id=v_item.id AND status='received';
  IF v_existing+p_received_quantity > v_item.quantity THEN
    RAISE EXCEPTION 'Received quantity exceeds invoice line quantity';
  END IF;
  v_make_id := NULLIF(p_payload->>'make_id','')::uuid;
  v_container_id := NULLIF(p_payload->>'import_container_id','')::uuid;
  IF v_make_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM public.product_sources WHERE id=v_make_id AND product_id=v_item.product_id) THEN
    RAISE EXCEPTION 'Selected Make / Manufacturer does not belong to the invoice product';
  END IF;
  IF NULLIF(p_payload->>'batch_id','') IS NOT NULL THEN
    SELECT * INTO v_batch FROM public.batches WHERE id=(p_payload->>'batch_id')::uuid FOR UPDATE;
  ELSE
    SELECT * INTO v_batch FROM public.batches
     WHERE product_id=v_item.product_id AND batch_number=p_payload->>'batch_number'
       AND (make_id=v_make_id OR make_id IS NULL) AND coalesce(is_active,true)
     ORDER BY (make_id IS NULL),created_at LIMIT 1 FOR UPDATE;
  END IF;
  IF FOUND THEN
    v_existing_batch := true;
    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN
      RAISE EXCEPTION 'Product does not match selected batch';
    END IF;
    IF v_batch.make_id IS NOT NULL AND v_batch.make_id IS DISTINCT FROM v_make_id THEN
      RAISE EXCEPTION 'Make does not match selected batch';
    END IF;
    IF NULLIF(p_payload->>'expiry_date','')::date IS NOT NULL
       AND v_batch.expiry_date IS NOT NULL
       AND NULLIF(p_payload->>'expiry_date','')::date IS DISTINCT FROM v_batch.expiry_date THEN
      RAISE EXCEPTION 'Expiry date conflicts with existing physical batch';
    END IF;
    PERFORM public.post_inventory_movement(p_operation_id,v_batch.product_id,v_batch.id,
      'adjustment',p_received_quantity,v_invoice.invoice_date,v_invoice.invoice_number,
      'purchase_invoice_receiving',v_invoice.id,
      'Purchase Invoice receiving into existing batch '||v_batch.batch_number,
      auth.uid(),v_batch.current_stock,v_batch.current_stock+p_received_quantity);
    UPDATE public.batches SET import_quantity=import_quantity+p_received_quantity,updated_at=now()
      WHERE id=v_batch.id;
    v_batch_id := v_batch.id;
  ELSE
    p_payload := jsonb_set(p_payload,'{import_quantity}',to_jsonb(p_received_quantity),true);
    p_payload := jsonb_set(p_payload,'{purchase_invoice_id}',to_jsonb(v_item.purchase_invoice_id),true);
    p_payload := jsonb_set(p_payload,'{supplier_id}',to_jsonb(v_invoice.supplier_id),true);
    SELECT (public.save_batch_inventory_v1(NULL,p_payload,p_operation_id)->>'batch_id')::uuid INTO v_batch_id;
  END IF;
  v_currency := upper(coalesce(v_invoice.currency,'IDR'));
  v_rate := CASE WHEN v_currency='IDR' THEN 1 ELSE coalesce(v_invoice.exchange_rate,0) END;
  IF v_rate<=0 THEN RAISE EXCEPTION 'Purchase invoice exchange rate is required'; END IF;
  v_tx_unit := coalesce(v_item.unit_price,0);
  v_func_unit := round(v_tx_unit*v_rate,2);
  INSERT INTO public.purchase_invoice_receiving_allocations(
    purchase_invoice_id,purchase_invoice_item_id,batch_id,received_quantity,
    operation_id,received_by,currency,exchange_rate,functional_unit_cost,
    functional_total_cost,import_container_id)
  VALUES(v_item.purchase_invoice_id,v_item.id,v_batch_id,p_received_quantity,
    p_operation_id,auth.uid(),v_currency,v_rate,v_func_unit,
    round(v_func_unit*p_received_quantity,2),v_container_id)
  RETURNING id INTO v_allocation_id;
  INSERT INTO public.purchase_batch_cost_layers(
    receiving_allocation_id,purchase_invoice_id,purchase_invoice_item_id,batch_id,
    import_container_id,quantity,currency,exchange_rate,transaction_unit_cost,
    functional_unit_cost,functional_total_cost,final_functional_unit_cost)
  VALUES(v_allocation_id,v_item.purchase_invoice_id,v_item.id,v_batch_id,v_container_id,
    p_received_quantity,v_currency,v_rate,v_tx_unit,v_func_unit,
    round(v_func_unit*p_received_quantity,2),v_func_unit);
  IF v_existing_batch THEN
    PERFORM public.apply_batch_receipt_weighted_average(v_batch_id,p_received_quantity,v_func_unit);
  END IF;
  RETURN jsonb_build_object('success',true,'batch_id',v_batch_id,'allocation_id',v_allocation_id);
END; $$;

-- Container allocations are receipt-layer based.  Costs are distributed only
-- across layers received from this container, never cumulative batch quantity.
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  pool numeric := public.calculate_container_landed_cost_pool(p_container_id);
  total_qty numeric;
  l record;
  v_batch_id uuid;
  batch_cost numeric;
BEGIN
  /* New receipts: allocate only across immutable receipt layers for this
     container, then recompute each physical batch's moving-average cost from
     all of its layers.  Sold quantity is deliberately never a denominator. */
  SELECT COALESCE(sum(quantity),0) INTO total_qty
    FROM public.purchase_batch_cost_layers
   WHERE import_container_id=p_container_id;
  IF total_qty > 0 THEN
    FOR l IN SELECT * FROM public.purchase_batch_cost_layers
      WHERE import_container_id=p_container_id ORDER BY created_at,id FOR UPDATE LOOP
      UPDATE public.purchase_batch_cost_layers
             SET landed_cost_amount=round(pool * l.quantity / total_qty,2),
                 final_functional_unit_cost=round(l.functional_unit_cost + pool * l.quantity / total_qty / l.quantity,2)
       WHERE id=l.id;
    END LOOP;

    FOR v_batch_id IN SELECT DISTINCT pbl.batch_id FROM public.purchase_batch_cost_layers pbl
      WHERE import_container_id=p_container_id LOOP
      SELECT COALESCE(sum(quantity * final_functional_unit_cost) / NULLIF(sum(quantity),0),0)
        INTO batch_cost
        FROM public.purchase_batch_cost_layers pbl WHERE pbl.batch_id=v_batch_id;
      UPDATE public.batches SET cost_per_unit=round(batch_cost,2), landed_cost_per_unit=round(batch_cost,2), updated_at=now()
       WHERE id=v_batch_id AND COALESCE(cost_locked,false)=false;
    END LOOP;
    RETURN;
  END IF;

  /* Historical receipts predate purchase_batch_cost_layers. Preserve the
     proven batch-level allocation path and use received/import quantity (not
     current_stock), so late freight remains correctly valued after sales. */
  SELECT COALESCE(sum(COALESCE(import_price,0)*COALESCE(import_quantity,0)),0)
    INTO total_qty FROM public.batches WHERE import_container_id=p_container_id;
  IF total_qty <= 0 THEN RETURN; END IF;
  FOR l IN SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM public.batches WHERE import_container_id=p_container_id AND COALESCE(cost_locked,false)=false LOOP
    batch_cost := pool * (COALESCE(l.import_price,0)*COALESCE(l.import_quantity,0)) / total_qty;
    UPDATE public.batches SET import_cost_allocated=round(batch_cost,2),
      final_landed_cost=round((COALESCE(l.import_price,0)+COALESCE(l.duty_charges,0))*COALESCE(l.import_quantity,0)+COALESCE(l.freight_charges,0)+COALESCE(l.other_charges,0)+batch_cost,2),
      landed_cost_per_unit=round(COALESCE(l.import_price,0)+COALESCE(l.duty_charges,0)+COALESCE(l.freight_charges,0)/NULLIF(l.import_quantity,0)+COALESCE(l.other_charges,0)/NULLIF(l.import_quantity,0)+batch_cost/NULLIF(l.import_quantity,0),2),
      cost_per_unit=round(COALESCE(l.import_price,0)+COALESCE(l.duty_charges,0)+COALESCE(l.freight_charges,0)/NULLIF(l.import_quantity,0)+COALESCE(l.other_charges,0)/NULLIF(l.import_quantity,0)+batch_cost/NULLIF(l.import_quantity,0),2), updated_at=now()
      WHERE id=l.id;
  END LOOP;
END; $$;

COMMENT ON FUNCTION public.apply_batch_receipt_weighted_average(uuid,numeric,numeric)
IS 'Future physical-batch moving weighted average; receipt layers remain separately auditable.';
NOTIFY pgrst,'reload schema';
COMMIT;
