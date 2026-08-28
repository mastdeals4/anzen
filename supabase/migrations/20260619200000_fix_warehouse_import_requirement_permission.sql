/*
  Fix: warehouse role cannot create import requirements (Add Batch trigger chain fails).

  ## Root cause
  Migration 20260618140000 fixed fn_reserve_stock_for_so_v2 to allow warehouse.
  fn_create_import_requirements was never updated to match, so when the trigger
  chain calls it (batch INSERT → fn_auto_rereserve_on_batch_arrival →
  fn_reserve_stock_for_so_v2 → fn_create_import_requirements), it raises:
    "Permission denied: role warehouse cannot create import requirements"

  ## What this migration changes
  1. fn_create_import_requirements — add warehouse with pg_trigger_depth() > 0 guard.
     Direct warehouse RPC calls still fail; only trigger-stack calls (Add Batch
     auto-rereservation chain) are allowed.

  2. allocate_import_costs_to_batches — remove warehouse (revert to admin/accounts only).
     This is a manual cost-allocation action that belongs to Finance.
     The UI already gates it via canSeeInventoryCosting (admin/accounts/manager only).
     The DB function had warehouse added in 20260618090000 — that was incorrect and is
     removed here to make the DB consistent with the UI intent.

  ## What this migration does NOT change
  - reallocate_container_costs: warehouse flat-allow stays. This function is called by
    DB triggers (auto_reallocate_container_costs, batch insert/update triggers) and
    warehouse must be able to complete the import batch save workflow.
  - fn_reserve_stock_for_so_v2: unchanged (warehouse flat-allow from 20260618140000).
  - create_system_task: unchanged (warehouse allowed from 20260531060708).
  - No schema changes. No inventory logic changes. No UI changes.
*/

-- ===========================================================================
-- 1. fn_create_import_requirements
--    Allow warehouse only when called from inside a trigger stack.
--    Direct calls from warehouse still raise permission denied.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_create_import_requirements(p_so_id uuid, p_shortage_items jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_shortage RECORD;
  v_customer_id uuid;
  v_delivery_date date;
  v_priority import_priority;
  v_existing_id uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF auth.uid() IS NOT NULL
     AND v_role NOT IN ('admin', 'accounts', 'manager')
     AND NOT (v_role = 'warehouse' AND pg_trigger_depth() > 0) THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create import requirements', v_role;
  END IF;

  SELECT customer_id, expected_delivery_date
  INTO v_customer_id, v_delivery_date
  FROM sales_orders WHERE id = p_so_id;

  IF v_delivery_date IS NULL THEN
    v_delivery_date := CURRENT_DATE + INTERVAL '30 days';
  END IF;

  v_priority := fn_calculate_import_priority(v_delivery_date);

  FOR v_shortage IN
    SELECT
      (item->>'product_id')::uuid   AS product_id,
      (item->>'required_qty')::numeric AS required_qty,
      (item->>'shortage_qty')::numeric AS shortage_qty
    FROM jsonb_array_elements(p_shortage_items) AS item
  LOOP
    SELECT id INTO v_existing_id
    FROM import_requirements
    WHERE sales_order_id = p_so_id
      AND product_id = v_shortage.product_id
      AND status IN ('pending', 'ordered')
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      UPDATE import_requirements
      SET
        shortage_quantity      = v_shortage.shortage_qty,
        required_quantity      = v_shortage.required_qty,
        priority               = v_priority,
        required_delivery_date = v_delivery_date,
        updated_at             = now()
      WHERE id = v_existing_id;
    ELSE
      INSERT INTO import_requirements (
        product_id, sales_order_id, customer_id, required_quantity,
        shortage_quantity, required_delivery_date, priority, status, notes
      ) VALUES (
        v_shortage.product_id, p_so_id, v_customer_id,
        v_shortage.required_qty, v_shortage.shortage_qty,
        v_delivery_date, v_priority, 'pending',
        'Auto-generated from SO shortage'
      );
    END IF;
  END LOOP;

  RETURN true;
END;
$$;

-- ===========================================================================
-- 2. allocate_import_costs_to_batches
--    Finance-only action — remove warehouse. Consistent with UI which gates this
--    button behind canSeeInventoryCosting (admin/accounts/manager only).
-- ===========================================================================
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
