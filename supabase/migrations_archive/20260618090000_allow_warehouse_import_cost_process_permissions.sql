/*
  Allow Warehouse users to execute the existing import cost allocation backend
  processes needed to complete operational import workflows.

  This is a permission-only change. The costing calculations and table schema
  are unchanged.
*/

CREATE OR REPLACE FUNCTION public.allocate_import_costs_to_batches(p_container_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_container RECORD;
  v_batch RECORD;
  v_total_invoice_value DECIMAL(18,2);
  v_total_import_cost DECIMAL(18,2);
  v_allocation_percentage DECIMAL(10,6);
  v_allocated_cost DECIMAL(18,2);
  v_batches_allocated INTEGER := 0;
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot allocate import costs', v_role;
  END IF;

  SELECT * INTO v_container
  FROM import_containers
  WHERE id = p_container_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Container not found');
  END IF;

  IF v_container.status != 'draft' THEN
    RETURN json_build_object('success', false, 'error', 'Container already allocated or locked');
  END IF;

  v_total_import_cost :=
    COALESCE(v_container.duty_bm, 0) +
    COALESCE(v_container.freight_charges, 0) +
    COALESCE(v_container.clearing_forwarding, 0) +
    COALESCE(v_container.port_charges, 0) +
    COALESCE(v_container.container_handling, 0) +
    COALESCE(v_container.transportation, 0) +
    COALESCE(v_container.other_import_costs, 0);

  IF v_total_import_cost = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No import costs to allocate');
  END IF;

  SELECT COALESCE(SUM(import_price * import_quantity), 0) INTO v_total_invoice_value
  FROM batches
  WHERE import_container_id = p_container_id;

  IF v_total_invoice_value = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No batches linked to this container');
  END IF;

  FOR v_batch IN
    SELECT id, import_price, import_quantity, (import_price * import_quantity) as batch_invoice_value
    FROM batches
    WHERE import_container_id = p_container_id
      AND COALESCE(cost_locked, false) = false
  LOOP
    v_allocation_percentage := (v_batch.batch_invoice_value / v_total_invoice_value) * 100;
    v_allocated_cost := (v_total_import_cost * v_batch.batch_invoice_value) / v_total_invoice_value;

    INSERT INTO import_container_allocations (
      container_id,
      batch_id,
      batch_invoice_value,
      allocation_percentage,
      allocated_cost,
      allocated_by
    ) VALUES (
      p_container_id,
      v_batch.id,
      v_batch.batch_invoice_value,
      v_allocation_percentage,
      v_allocated_cost,
      auth.uid()
    )
    ON CONFLICT (container_id, batch_id)
    DO UPDATE SET
      allocation_percentage = EXCLUDED.allocation_percentage,
      allocated_cost = EXCLUDED.allocated_cost;

    UPDATE batches
    SET import_cost_allocated = v_allocated_cost,
        final_landed_cost = import_price + v_allocated_cost,
        cost_locked = true
    WHERE id = v_batch.id;

    v_batches_allocated := v_batches_allocated + 1;
  END LOOP;

  UPDATE import_containers
  SET status = 'allocated',
      locked_at = now(),
      locked_by = auth.uid(),
      allocated_expenses = v_total_import_cost
  WHERE id = p_container_id;

  RETURN json_build_object(
    'success', true,
    'batches_allocated', v_batches_allocated,
    'total_cost', v_total_import_cost,
    'note', 'PPN and PPh excluded from cost allocation'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reallocate_container_costs(p_container_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_batch_record RECORD;
  v_total_quantity numeric := 0;
  v_batch_percentage numeric;
  v_total_container_costs numeric := 0;
  v_allocated_cost numeric;
  v_allocated_per_unit numeric;
  v_final_total_cost numeric;
  v_landed_cost_per_unit numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reallocate container costs', v_role;
  END IF;

  SELECT
    COALESCE(total_import_expenses, 0) -
    COALESCE(duty_bm, 0) -
    COALESCE(ppn_import, 0) -
    COALESCE(pph_import, 0)
  INTO v_total_container_costs
  FROM import_containers WHERE id = p_container_id;

  SELECT COALESCE(SUM(import_quantity), 0) INTO v_total_quantity
  FROM batches WHERE import_container_id = p_container_id;

  IF v_total_quantity = 0 THEN
    UPDATE batches
    SET
      import_cost_allocated = 0,
      final_landed_cost     = (import_price + duty_charges + freight_charges + other_charges) * import_quantity,
      landed_cost_per_unit  = import_price + duty_charges + freight_charges + other_charges
    WHERE import_container_id = p_container_id;
    RETURN;
  END IF;

  FOR v_batch_record IN
    SELECT id, import_price, import_price_per_unit, import_quantity,
           duty_charges, freight_charges, other_charges
    FROM batches WHERE import_container_id = p_container_id
  LOOP
    v_batch_percentage    := (v_batch_record.import_quantity / v_total_quantity);
    v_allocated_cost      := v_total_container_costs * v_batch_percentage;
    v_allocated_per_unit  := v_allocated_cost / NULLIF(v_batch_record.import_quantity, 0);

    v_landed_cost_per_unit :=
      v_batch_record.import_price +
      (v_batch_record.duty_charges    / NULLIF(v_batch_record.import_quantity, 0)) +
      (v_batch_record.freight_charges / NULLIF(v_batch_record.import_quantity, 0)) +
      (v_batch_record.other_charges   / NULLIF(v_batch_record.import_quantity, 0)) +
      v_allocated_per_unit;

    v_final_total_cost :=
      (v_batch_record.import_price +
       (v_batch_record.duty_charges    / NULLIF(v_batch_record.import_quantity, 0)) +
       (v_batch_record.freight_charges / NULLIF(v_batch_record.import_quantity, 0)) +
       (v_batch_record.other_charges   / NULLIF(v_batch_record.import_quantity, 0))) *
      v_batch_record.import_quantity +
      v_allocated_cost;

    UPDATE batches
    SET
      import_cost_allocated = v_allocated_cost,
      final_landed_cost     = v_final_total_cost,
      landed_cost_per_unit  = v_landed_cost_per_unit
    WHERE id = v_batch_record.id;
  END LOOP;
END;
$$;
