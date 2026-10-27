/*
# Update allocate_import_costs_to_batches to include petty cash

## Purpose
Adds petty_cash_transactions to the landed-cost pool alongside
finance_expenses. Both use include_in_landed_cost = true.

## Formula
  v_total_import_cost =
    SUM(finance_expenses.amount WHERE include_in_landed_cost = true) +
    SUM(petty_cash_transactions.amount WHERE include_in_landed_cost = true) +
    container.other_import_costs

## Safety
- No data deleted or modified.
- Existing allocated/locked containers protected by status check.
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
  v_linked_petty_cash_total DECIMAL(18,2);
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

  -- Linked finance expenses
  SELECT COALESCE(SUM(amount), 0) INTO v_linked_expenses_total
  FROM finance_expenses
  WHERE import_container_id = p_container_id
    AND include_in_landed_cost = true;

  -- Linked petty cash
  SELECT COALESCE(SUM(amount), 0) INTO v_linked_petty_cash_total
  FROM petty_cash_transactions
  WHERE import_container_id = p_container_id
    AND include_in_landed_cost = true;

  v_total_import_cost := v_linked_expenses_total + v_linked_petty_cash_total + COALESCE(v_container.other_import_costs, 0);

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
    'linked_petty_cash_total', v_linked_petty_cash_total,
    'other_import_costs', COALESCE(v_container.other_import_costs, 0),
    'note', 'PPN and PPh excluded from cost allocation'
  );
END;
$function$;
