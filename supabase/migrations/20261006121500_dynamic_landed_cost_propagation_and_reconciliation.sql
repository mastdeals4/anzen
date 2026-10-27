-- Migration: 20261006121500_dynamic_landed_cost_propagation_and_reconciliation.sql
-- Description: Establishes single-source authoritative costing, unblocks system synchronization
--              for cost_locked batches, consolidates redundant triggers, and synchronizes batch master costs.

BEGIN;

-- 1. Overload calculate_batch_authoritative_cost for UUID input
CREATE OR REPLACE FUNCTION public.calculate_batch_authoritative_cost(p_batch_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_batch public.batches%ROWTYPE;
BEGIN
  SELECT * INTO v_batch FROM public.batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  RETURN public.calculate_batch_authoritative_cost(v_batch);
END;
$function$;

-- 2. Ensure get_batch_authoritative_unit_cost delegates to canonical calculate_batch_authoritative_cost
CREATE OR REPLACE FUNCTION public.get_batch_authoritative_unit_cost(p_batch_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN public.calculate_batch_authoritative_cost(p_batch_id);
END;
$function$;

-- 3. Update reallocate_container_costs to synchronize batch master fields even if cost_locked = true
CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  pool numeric := public.calculate_container_landed_cost_pool(p_container_id);
  total_qty numeric;
  total_val numeric;
  l record;
  v_batch_id uuid;
  batch_cost numeric;
  v_affected_batches uuid[] := ARRAY[]::uuid[];
BEGIN
  -- Branch 1: Purchase cost layers exist for this container
  SELECT COALESCE(SUM(quantity), 0) INTO total_qty
    FROM public.purchase_batch_cost_layers
   WHERE import_container_id = p_container_id;

  IF total_qty > 0 THEN
    -- Recalculate cost layers based on container pool
    FOR l IN SELECT * FROM public.purchase_batch_cost_layers
      WHERE import_container_id = p_container_id ORDER BY created_at, id FOR UPDATE LOOP
      UPDATE public.purchase_batch_cost_layers
         SET landed_cost_amount = ROUND(pool * l.quantity / total_qty, 2),
             final_functional_unit_cost = ROUND(l.functional_unit_cost + pool * l.quantity / total_qty / l.quantity, 2)
       WHERE id = l.id;
    END LOOP;

    -- Synchronize batch master fields for each affected batch
    FOR v_batch_id IN SELECT DISTINCT pbl.batch_id FROM public.purchase_batch_cost_layers pbl
      WHERE import_container_id = p_container_id LOOP
      SELECT COALESCE(SUM(quantity * final_functional_unit_cost) / NULLIF(SUM(quantity), 0), 0)
        INTO batch_cost
        FROM public.purchase_batch_cost_layers pbl WHERE pbl.batch_id = v_batch_id;

      -- Update batch master: operational edit-lock does NOT prevent system costing reconciliation
      UPDATE public.batches
         SET cost_per_unit = ROUND(batch_cost, 2),
             landed_cost_per_unit = ROUND(batch_cost, 2),
             final_landed_cost = ROUND(batch_cost * COALESCE(import_quantity, 1), 2),
             updated_at = now()
       WHERE id = v_batch_id;

      v_affected_batches := array_append(v_affected_batches, v_batch_id);
    END LOOP;

    -- Propagate cost changes to sales COGS and post balancing true-up journals
    FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_id);
    END LOOP;

    RETURN;
  END IF;

  -- Branch 2: Value-weighted allocation across linked batches (legacy containers without layers)
  SELECT COALESCE(SUM(COALESCE(import_price, 0) * COALESCE(import_quantity, 0)), 0)
    INTO total_val
    FROM public.batches
   WHERE import_container_id = p_container_id;

  IF total_val <= 0 THEN RETURN; END IF;

  FOR l IN SELECT id, import_price, import_quantity, duty_charges, freight_charges, other_charges
    FROM public.batches WHERE import_container_id = p_container_id LOOP
    batch_cost := pool * (COALESCE(l.import_price, 0) * COALESCE(l.import_quantity, 0)) / total_val;
    UPDATE public.batches
       SET import_cost_allocated = ROUND(batch_cost, 2),
           final_landed_cost = ROUND((COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0)) * COALESCE(l.import_quantity, 0) + COALESCE(l.freight_charges, 0) + COALESCE(l.other_charges, 0) + batch_cost, 2),
           landed_cost_per_unit = ROUND(COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0) + COALESCE(l.freight_charges, 0) / NULLIF(l.import_quantity, 0) + COALESCE(l.other_charges, 0) / NULLIF(l.import_quantity, 0) + batch_cost / NULLIF(l.import_quantity, 0), 2),
           cost_per_unit = ROUND(COALESCE(l.import_price, 0) + COALESCE(l.duty_charges, 0) + COALESCE(l.freight_charges, 0) / NULLIF(l.import_quantity, 0) + COALESCE(l.other_charges, 0) / NULLIF(l.import_quantity, 0) + batch_cost / NULLIF(l.import_quantity, 0), 2),
           updated_at = now()
     WHERE id = l.id;

    v_affected_batches := array_append(v_affected_batches, l.id);
  END LOOP;

  -- Propagate cost changes to sales COGS for every affected batch
  FOREACH v_batch_id IN ARRAY v_affected_batches LOOP
    PERFORM public.propagate_batch_cost_change(v_batch_id);
  END LOOP;
END;
$function$;

-- 4. Consolidate redundant triggers on import_containers and batches
-- Keep trigger_recalc_batches_on_container on import_containers (AFTER INSERT OR UPDATE)
DROP TRIGGER IF EXISTS reallocate_costs_on_container_update ON public.import_containers;
DROP TRIGGER IF EXISTS trigger_allocate_container_costs_on_change ON public.import_containers;

-- Keep auto_reallocate_on_batch_change on batches (AFTER INSERT OR UPDATE)
DROP TRIGGER IF EXISTS trigger_reallocate_on_batch_container_change ON public.batches;

-- 5. Data Repair: Synchronize master fields on all batches that currently diverge from authoritative layers
DO $$
DECLARE
  r record;
  v_authoritative_cost numeric;
BEGIN
  FOR r IN 
    SELECT b.id, b.import_quantity
    FROM public.batches b
    JOIN public.purchase_batch_cost_layers pbcl ON pbcl.batch_id = b.id
    GROUP BY b.id, b.import_quantity, b.landed_cost_per_unit
    HAVING ABS(b.landed_cost_per_unit - ROUND(SUM(pbcl.quantity * pbcl.final_functional_unit_cost) / NULLIF(SUM(pbcl.quantity), 0), 2)) > 0.05
  LOOP
    v_authoritative_cost := public.calculate_batch_authoritative_cost(r.id);
    
    UPDATE public.batches
       SET landed_cost_per_unit = ROUND(v_authoritative_cost, 2),
           cost_per_unit = ROUND(v_authoritative_cost, 2),
           final_landed_cost = ROUND(v_authoritative_cost * COALESCE(r.import_quantity, 1), 2),
           updated_at = now()
     WHERE id = r.id;

    -- Propagate to ensure sales COGS and GL 5100/1130 are completely synchronized
    PERFORM public.propagate_batch_cost_change(r.id);
  END LOOP;
END $$;

COMMIT;
