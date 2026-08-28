/*
  Fix Warehouse Add Batch trigger permissions end-to-end.

  Scope:
  - Warehouse may create/edit operational import batches.
  - Existing batch triggers may perform their automatic backend work while
    running under a Warehouse session.
  - Warehouse is NOT granted general/manual costing, reservation, approval, or
    financial actions.

  The Warehouse allowances below are intentionally trigger-scoped using
  pg_trigger_depth() > 0. Direct Warehouse RPC calls to these functions still
  fail. Calculations, formulas, reservation ordering, statuses, and business
  logic are unchanged.
*/

-- ---------------------------------------------------------------------------
-- Container cost reallocation
-- Called by batch/import_container triggers after a batch is linked to a
-- container or quantity/container costs change. Direct Warehouse calls remain
-- denied because this is a costing backend process.
-- ---------------------------------------------------------------------------
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
  IF v_role NOT IN ('admin', 'accounts')
     AND NOT (v_role = 'warehouse' AND pg_trigger_depth() > 0) THEN
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

-- ---------------------------------------------------------------------------
-- Automatic shortage re-reservation
-- Called by fn_auto_rereserve_on_batch_arrival() after a new batch arrives.
-- Direct Warehouse calls remain denied; only trigger-stack calls are allowed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so_v2(p_so_id uuid)
RETURNS TABLE(success boolean, message text, shortage_items jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_item RECORD;
  v_batch RECORD;
  v_remaining_qty numeric;
  v_reserved_qty numeric;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager')
     AND NOT (v_role = 'warehouse' AND pg_trigger_depth() > 0) THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reserve stock for sales orders', v_role;
  END IF;

  DELETE FROM stock_reservations WHERE sales_order_id = p_so_id;

  FOR v_item IN
    SELECT soi.id, soi.product_id, soi.quantity
    FROM sales_order_items soi WHERE soi.sales_order_id = p_so_id
  LOOP
    v_remaining_qty := v_item.quantity;
    FOR v_batch IN
      SELECT b.id, b.current_stock, COALESCE(b.reserved_stock, 0) as reserved_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id
        AND b.is_active = true
        AND b.current_stock > COALESCE(b.reserved_stock, 0)
        AND (b.expiry_date IS NULL OR b.expiry_date > CURRENT_DATE)
      ORDER BY b.import_date ASC, b.created_at ASC
    LOOP
      v_reserved_qty := LEAST(v_remaining_qty, v_batch.current_stock - v_batch.reserved_stock);
      IF v_reserved_qty > 0 THEN
        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id, reserved_quantity, is_released
        ) VALUES (p_so_id, v_item.id, v_batch.id, v_item.product_id, v_reserved_qty, false);
        v_remaining_qty := v_remaining_qty - v_reserved_qty;
      END IF;
      EXIT WHEN v_remaining_qty <= 0;
    END LOOP;
    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id, 'required_qty', v_item.quantity, 'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage exists.'::text, v_shortage_list;
  ELSE
    UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    RETURN QUERY SELECT true, 'Stock fully reserved'::text, '[]'::jsonb;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Automatic import requirement maintenance
-- Called by reservation functions when shortage remains. Direct Warehouse calls
-- remain denied; trigger-stack calls from Add Batch are allowed.
-- ---------------------------------------------------------------------------
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
      (item->>'product_id')::uuid  AS product_id,
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

-- ---------------------------------------------------------------------------
-- Automatic system task creation
-- Import requirement creation fires trigger_import_requirement_task_creation,
-- which calls create_system_task(). Allow Warehouse only when the task is
-- created inside trigger-driven workflow automation. Direct Warehouse calls
-- remain denied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_system_task(
  p_title text,
  p_description text,
  p_deadline timestamp with time zone,
  p_origin text,
  p_reference_type text,
  p_reference_id uuid,
  p_assigned_role text,
  p_priority text DEFAULT NULL::text,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_product_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_task_id uuid;
  v_assigned_users uuid[];
  v_auto_priority text;
  v_creator_id uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager')
     AND NOT (v_role = 'warehouse' AND pg_trigger_depth() > 0) THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create system tasks', v_role;
  END IF;

  v_assigned_users := get_users_by_role(p_assigned_role);
  v_auto_priority  := COALESCE(p_priority, calculate_task_priority(p_deadline));

  SELECT id INTO v_creator_id FROM user_profiles WHERE role = 'admin' AND is_active = true LIMIT 1;
  IF v_creator_id IS NULL THEN
    SELECT id INTO v_creator_id FROM user_profiles WHERE is_active = true LIMIT 1;
  END IF;

  INSERT INTO tasks (
    title, description, deadline, priority, auto_priority, status,
    task_type, task_mode, task_origin, reference_type, reference_id,
    auto_assigned_role, assigned_users, customer_id, product_id, created_by, proof_required
  ) VALUES (
    p_title, p_description, p_deadline, v_auto_priority::task_priority, v_auto_priority, 'to_do'::task_status,
    'system', 'advisory', p_origin, p_reference_type, p_reference_id,
    p_assigned_role, v_assigned_users, p_customer_id, p_product_id, v_creator_id, false
  )
  RETURNING id INTO v_task_id;

  IF array_length(v_assigned_users, 1) > 0 THEN
    INSERT INTO task_assignments (task_id, assigned_user_id, assigned_by)
    SELECT v_task_id, unnest(v_assigned_users), v_creator_id;
  END IF;

  RETURN v_task_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_system_task(
  p_title text,
  p_description text,
  p_deadline timestamp with time zone,
  p_priority task_priority,
  p_assigned_users uuid[],
  p_task_origin task_origin_enum,
  p_sales_order_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_product_id uuid DEFAULT NULL::uuid,
  p_tags text[] DEFAULT ARRAY[]::text[],
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_task_id uuid;
  v_system_user uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager')
     AND NOT (v_role = 'warehouse' AND pg_trigger_depth() > 0) THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create system tasks', v_role;
  END IF;

  SELECT id INTO v_system_user FROM user_profiles WHERE role = 'admin' LIMIT 1;
  IF v_system_user IS NULL THEN
    v_system_user := auth.uid();
  END IF;

  INSERT INTO tasks (
    title, description, deadline, priority, status, created_by, assigned_users,
    task_type, task_mode, task_origin, sales_order_id, customer_id, product_id,
    tags, auto_priority, system_metadata
  ) VALUES (
    p_title, p_description, p_deadline, p_priority, 'to_do', v_system_user, p_assigned_users,
    'system', 'advisory', p_task_origin, p_sales_order_id, p_customer_id, p_product_id,
    array_append(p_tags, 'system-generated'), true, p_metadata
  )
  RETURNING id INTO v_task_id;

  RETURN v_task_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Keep manual container cost allocation Admin/Accounts-only.
-- This is a costing decision, not part of Warehouse Add Batch automation.
-- ---------------------------------------------------------------------------
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
  IF v_role NOT IN ('admin','accounts') THEN
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
