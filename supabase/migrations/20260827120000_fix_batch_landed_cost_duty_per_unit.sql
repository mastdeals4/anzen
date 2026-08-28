-- Preserve batch-specific duty and treat batch cost fields consistently as
-- per-unit IDR values, matching save_batch_inventory_v1 and the Batches UI.
-- This changes only the canonical recalculation function; it does not mutate
-- existing batch data.
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch_record record;
  v_total_quantity numeric := 0;
  v_batch_percentage numeric;
  v_total_container_costs numeric := 0;
  v_allocated_cost numeric;
  v_allocated_per_unit numeric;
  v_landed_cost_per_unit numeric;
  v_final_total_cost numeric;
BEGIN
  SELECT COALESCE(total_import_expenses, 0)
       - COALESCE(duty_bm, 0)
       - COALESCE(ppn_import, 0)
       - COALESCE(pph_import, 0)
    INTO v_total_container_costs
    FROM public.import_containers
   WHERE id = p_container_id;

  SELECT COALESCE(SUM(import_quantity), 0)
    INTO v_total_quantity
    FROM public.batches
   WHERE import_container_id = p_container_id;

  FOR v_batch_record IN
    SELECT id, import_price, import_quantity, duty_charges,
           freight_charges, other_charges
      FROM public.batches
     WHERE import_container_id = p_container_id
  LOOP
    v_batch_percentage := CASE WHEN v_total_quantity > 0
      THEN v_batch_record.import_quantity / v_total_quantity ELSE 0 END;
    v_allocated_cost := v_total_container_costs * v_batch_percentage;
    v_allocated_per_unit := CASE WHEN v_batch_record.import_quantity > 0
      THEN v_allocated_cost / v_batch_record.import_quantity ELSE 0 END;

    -- Batch cost fields are per-unit values. Duty therefore flows directly
    -- into landed cost and is never divided by quantity a second time.
    v_landed_cost_per_unit := COALESCE(v_batch_record.import_price, 0)
      + COALESCE(v_batch_record.duty_charges, 0)
      + COALESCE(v_batch_record.freight_charges, 0)
      + COALESCE(v_batch_record.other_charges, 0)
      + v_allocated_per_unit;
    v_final_total_cost := v_landed_cost_per_unit * COALESCE(v_batch_record.import_quantity, 0);

    UPDATE public.batches
       SET import_cost_allocated = v_allocated_cost,
           final_landed_cost = v_final_total_cost,
           landed_cost_per_unit = v_landed_cost_per_unit
     WHERE id = v_batch_record.id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reallocate_container_costs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reallocate_container_costs(uuid) TO authenticated;
