/*
# Update allocate_import_costs_to_batches to use linked expenses + other_import_costs

## Purpose
Replaces the old manual cost field summation with:
  1. SUM of linked finance_expenses where include_in_landed_cost = true
  2. + container.other_import_costs

This makes the checkbox the actual control for what enters the landed-cost pool.

## Safety
- Does NOT touch existing finance expenses, batches, journals, or tax records.
- Old manual cost fields (duty_bm, freight_charges, etc.) are simply ignored.
- No columns dropped, no data deleted.
- Existing allocated/locked containers are still protected by the status check.
*/

CREATE OR REPLACE FUNCTION public.allocate_import_costs_to_batches(p_container_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_container RECORD;
  v_batch RECORD;
  v_total_invoice_value DECIMAL(18,2);
  v_total_import_cost DECIMAL(18,2);
  v_linked_expenses_total DECIMAL(18,2);
  v_allocation_percentage DECIMAL(10,6);
  v_allocated_cost DECIMAL(18,2);
  v_batches_allocated INTEGER := 0;
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
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

  -- Calculate linked expenses total (only those with include_in_landed_cost = true)
  SELECT COALESCE(SUM(amount), 0) INTO v_linked_expenses_total
  FROM finance_expenses
  WHERE import_container_id = p_container_id
    AND include_in_landed_cost = true;

  -- Total import cost = linked expenses (included) + other_import_costs
  v_total_import_cost := v_linked_expenses_total + COALESCE(v_container.other_import_costs, 0);

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
    'linked_expenses_total', v_linked_expenses_total,
    'other_import_costs', COALESCE(v_container.other_import_costs, 0),
    'note', 'PPN and PPh excluded from cost allocation'
  );
END;
$function$;
