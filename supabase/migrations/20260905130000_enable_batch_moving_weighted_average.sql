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

-- Add weighted-average update to the approved receiving RPC without changing
-- its operation-id, quantity, identity, or accounting behavior.
DO $migration$
DECLARE d text; original text;
BEGIN
  SELECT pg_get_functiondef('public.receive_purchase_invoice_item(uuid,jsonb,numeric,uuid)'::regprocedure) INTO d;
  original := d;
  d := replace(d,
    E'  v_func_unit numeric;\nBEGIN',
    E'  v_func_unit numeric;\n  v_existing_batch boolean := false;\nBEGIN');
  d := replace(d,
    E'  IF FOUND THEN\n    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN',
    E'  IF FOUND THEN\n    v_existing_batch := true;\n    IF v_batch.product_id IS DISTINCT FROM v_item.product_id THEN');
  d := replace(d,
    '  RETURN jsonb_build_object(''success'', true, ''batch_id'', v_batch_id, ''allocation_id'', v_allocation_id);',
    '  IF v_existing_batch THEN\n    PERFORM public.apply_batch_receipt_weighted_average(v_batch_id, p_received_quantity, v_func_unit);\n  END IF;\n  RETURN jsonb_build_object(''success'', true, ''batch_id'', v_batch_id, ''allocation_id'', v_allocation_id);');
  IF d = original OR position('apply_batch_receipt_weighted_average' IN d)=0 THEN
    RAISE EXCEPTION 'Unexpected receiving RPC definition; weighted-average hook not installed';
  END IF;
  EXECUTE d;
END; $migration$;

-- Container allocations are receipt-layer based.  Costs are distributed only
-- across layers received from this container, never cumulative batch quantity.
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  pool numeric := public.calculate_container_landed_cost_pool(p_container_id);
  total_qty numeric;
  l record;
  old_landed numeric;
  delta numeric;
  batch_stock numeric;
BEGIN
  SELECT COALESCE(sum(quantity),0) INTO total_qty
    FROM public.purchase_batch_cost_layers
   WHERE import_container_id=p_container_id;
  IF total_qty <= 0 THEN RETURN; END IF;
  FOR l IN SELECT * FROM public.purchase_batch_cost_layers
    WHERE import_container_id=p_container_id ORDER BY created_at,id FOR UPDATE LOOP
    old_landed := COALESCE(l.landed_cost_amount,0);
    delta := round(pool * l.quantity / total_qty,2) - old_landed;
    UPDATE public.purchase_batch_cost_layers
       SET landed_cost_amount=round(pool*l.quantity/total_qty,2),
           final_functional_unit_cost=round(l.functional_unit_cost + pool*l.quantity/total_qty/l.quantity,2)
     WHERE id=l.id;
    SELECT current_stock INTO batch_stock FROM public.batches WHERE id=l.batch_id FOR UPDATE;
    IF COALESCE(batch_stock,0) > 0 AND delta <> 0 THEN
      UPDATE public.batches
         SET cost_per_unit=round(COALESCE(landed_cost_per_unit,cost_per_unit,0)+delta/batch_stock,2),
             landed_cost_per_unit=round(COALESCE(landed_cost_per_unit,cost_per_unit,0)+delta/batch_stock,2),
             updated_at=now()
       WHERE id=l.batch_id AND COALESCE(cost_locked,false)=false;
    END IF;
  END LOOP;
END; $$;

COMMENT ON FUNCTION public.apply_batch_receipt_weighted_average(uuid,numeric,numeric)
IS 'Future physical-batch moving weighted average; receipt layers remain separately auditable.';
NOTIFY pgrst,'reload schema';
COMMIT;
