/*
  # Add Role Guards to Remaining SECURITY DEFINER Functions (Final Batch)

  This migration adds caller-identity checks to the last 22 SECURITY DEFINER
  functions that were still callable by any authenticated user without role
  restrictions.

  Functions covered and their allowed roles:
    - apply_import_costs_to_batches    → admin, accounts
    - auto_create_followup             → admin, accounts, sales, manager
    - check_inquiry_requirements_fulfilled → admin, accounts, sales, manager
    - complete_import_cost_posting     → admin, accounts
    - create_staff_account             → admin only
    - edit_delivery_challan            → admin, accounts, warehouse, sales, manager
    - fn_create_import_requirements    → admin, accounts, manager (also called internally)
    - fn_release_partial_reservation   → admin, accounts, warehouse, sales, manager
    - fn_release_stock_reservations (2 overloads) → admin, accounts, warehouse, sales, manager
    - fn_reserve_stock_for_so          → admin, accounts, manager
    - fn_reserve_stock_for_so_v2       → admin, accounts, manager
    - log_timeline_event               → admin, accounts, sales, manager
    - manually_post_pending_fund_transfers → admin, accounts
    - post_import_cost_journal         → admin, accounts
    - preview_bank_statement_delete    → admin, accounts
    - reallocate_container_costs       → admin, accounts
    - update_sales_invoice_atomic (2 overloads) → admin, accounts, sales, manager
    - update_so_delivered_quantity_atomic → admin, accounts, warehouse, manager

  All functions keep SECURITY DEFINER (they need elevated privileges to bypass
  RLS on internal tables). The role check is added as the first statement.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- apply_import_costs_to_batches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_import_costs_to_batches(p_header_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_item RECORD;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot apply import costs', v_role;
  END IF;

  FOR v_item IN
    SELECT * FROM import_cost_items WHERE cost_header_id = p_header_id AND batch_id IS NOT NULL
  LOOP
    UPDATE batches
    SET
      cost_per_unit = v_item.final_landed_cost_per_unit,
      updated_at = NOW()
    WHERE id = v_item.batch_id;

    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity, transaction_date,
      reference_number, reference_type, reference_id, notes, created_by,
      stock_before, stock_after
    )
    SELECT
      v_item.product_id,
      v_item.batch_id,
      'cost_adjustment',
      0,
      CURRENT_DATE,
      (SELECT cost_sheet_number FROM import_cost_headers WHERE id = p_header_id),
      'import_cost',
      p_header_id,
      'Import cost allocation: Duty=' || v_item.allocated_duty ||
        ', PPN=' || v_item.allocated_ppn ||
        ', Freight=' || v_item.allocated_freight,
      (SELECT created_by FROM import_cost_headers WHERE id = p_header_id),
      (SELECT current_stock FROM batches WHERE id = v_item.batch_id),
      (SELECT current_stock FROM batches WHERE id = v_item.batch_id);
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- auto_create_followup
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_create_followup(p_inquiry_id uuid, p_action_type text, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  rule_record RECORD;
  new_reminder_id uuid;
  due_date timestamptz;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create follow-ups', v_role;
  END IF;

  SELECT * INTO rule_record
  FROM crm_automation_rules
  WHERE is_active = true
    AND trigger_on = 'action_performed'
    AND trigger_action = p_action_type
    AND auto_create_followup = true
  ORDER BY priority DESC
  LIMIT 1;

  IF rule_record IS NOT NULL THEN
    due_date := now() + (rule_record.followup_days_offset || ' days')::interval;

    INSERT INTO crm_reminders (
      inquiry_id, reminder_type, title, due_date, assigned_to, created_by
    ) VALUES (
      p_inquiry_id, rule_record.followup_type, rule_record.followup_title,
      due_date, p_user_id, p_user_id
    ) RETURNING id INTO new_reminder_id;

    RETURN new_reminder_id;
  END IF;

  RETURN NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- check_inquiry_requirements_fulfilled
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_inquiry_requirements_fulfilled(inquiry_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  inquiry_record RECORD;
  all_fulfilled boolean;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot check inquiry requirements', v_role;
  END IF;

  SELECT * INTO inquiry_record FROM crm_inquiries WHERE id = inquiry_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  all_fulfilled := (
    (NOT inquiry_record.price_required OR inquiry_record.price_sent_at IS NOT NULL) AND
    (NOT inquiry_record.coa_required OR inquiry_record.coa_sent_at IS NOT NULL) AND
    (NOT inquiry_record.sample_required OR inquiry_record.sample_sent_at IS NOT NULL) AND
    (NOT inquiry_record.agency_letter_required OR inquiry_record.agency_letter_sent_at IS NOT NULL)
  );

  RETURN all_fulfilled;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_import_cost_posting
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_import_cost_posting(p_header_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_je_id UUID;
  v_result JSONB;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot post import costs', v_role;
  END IF;

  PERFORM calculate_import_cost_allocation(p_header_id);
  PERFORM apply_import_costs_to_batches(p_header_id);
  v_je_id := post_import_cost_journal(p_header_id);

  UPDATE import_cost_headers
  SET
    status = 'posted',
    journal_entry_id = v_je_id,
    posted_by = auth.uid(),
    posted_at = NOW()
  WHERE id = p_header_id;

  v_result := jsonb_build_object(
    'success', true,
    'message', 'Import costs calculated, allocated, and posted successfully',
    'journal_entry_id', v_je_id,
    'header_id', p_header_id
  );

  RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- create_staff_account
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_staff_account(p_staff_name text, p_employee_id text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_coa_id UUID;
  v_staff_id UUID;
  v_next_code TEXT;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin') THEN
    RAISE EXCEPTION 'Permission denied: only admin can create staff accounts';
  END IF;

  SELECT coa_account_id INTO v_coa_id
  FROM staff_members
  WHERE LOWER(staff_name) = LOWER(p_staff_name);

  IF v_coa_id IS NOT NULL THEN
    RETURN v_coa_id;
  END IF;

  SELECT '116' || LPAD((COUNT(*) + 1)::TEXT, 1, '0')
  INTO v_next_code
  FROM chart_of_accounts
  WHERE code LIKE '116%' AND code != '1160';

  INSERT INTO chart_of_accounts (code, name, account_type, is_active, description)
  VALUES (
    v_next_code,
    p_staff_name || ' - Staff Advance',
    'asset',
    true,
    'Staff advance account for ' || p_staff_name
  )
  RETURNING id INTO v_coa_id;

  INSERT INTO staff_members (staff_name, coa_account_id, employee_id)
  VALUES (p_staff_name, v_coa_id, p_employee_id)
  RETURNING id INTO v_staff_id;

  RETURN v_coa_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- edit_delivery_challan
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.edit_delivery_challan(p_challan_id uuid, p_new_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_challan record;
  v_item jsonb;
  v_count integer;
  v_old_items record;
  v_old_qty numeric;
  v_new_qty numeric;
  v_difference numeric;
  v_product_id uuid;
  v_batch_id uuid;
  v_current_stock numeric;
  v_reserved_stock numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot edit delivery challans', v_role;
  END IF;

  SELECT * INTO v_challan FROM delivery_challans WHERE id = p_challan_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Delivery challan not found');
  END IF;

  IF v_challan.approved_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot edit approved delivery challan');
  END IF;

  SELECT count(*) INTO v_count FROM jsonb_array_elements(p_new_items);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot save DC with no items');
  END IF;

  PERFORM set_config('app.skip_dc_item_trigger', 'true', true);

  FOR v_old_items IN
    SELECT dci.*, b.batch_number, b.current_stock
    FROM delivery_challan_items dci
    JOIN batches b ON dci.batch_id = b.id
    WHERE dci.challan_id = p_challan_id
      AND dci.batch_id NOT IN (
        SELECT (item->>'batch_id')::uuid
        FROM jsonb_array_elements(p_new_items) item
      )
  LOOP
    UPDATE batches
    SET reserved_stock = GREATEST(0, COALESCE(reserved_stock, 0) - v_old_items.quantity)
    WHERE id = v_old_items.batch_id;

    DELETE FROM delivery_challan_items WHERE id = v_old_items.id;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_new_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_batch_id   := (v_item->>'batch_id')::uuid;
    v_new_qty    := (v_item->>'quantity')::numeric;

    SELECT quantity INTO v_old_qty
    FROM delivery_challan_items
    WHERE challan_id = p_challan_id AND batch_id = v_batch_id;

    IF FOUND THEN
      v_difference := v_new_qty - v_old_qty;

      IF v_difference != 0 THEN
        SELECT current_stock, reserved_stock INTO v_current_stock, v_reserved_stock
        FROM batches WHERE id = v_batch_id;

        IF (COALESCE(v_reserved_stock, 0) + v_difference) > v_current_stock THEN
          RAISE EXCEPTION 'Insufficient stock: Batch has %kg available, currently reserved %kg, trying to add %kg more',
            v_current_stock, COALESCE(v_reserved_stock, 0), v_difference;
        END IF;

        UPDATE batches
        SET reserved_stock = COALESCE(reserved_stock, 0) + v_difference
        WHERE id = v_batch_id;

        UPDATE delivery_challan_items
        SET
          quantity        = v_new_qty,
          pack_size       = (v_item->>'pack_size')::numeric,
          pack_type       = v_item->>'pack_type',
          number_of_packs = (v_item->>'number_of_packs')::integer
        WHERE challan_id = p_challan_id AND batch_id = v_batch_id;
      END IF;

    ELSE
      SELECT current_stock, reserved_stock INTO v_current_stock, v_reserved_stock
      FROM batches WHERE id = v_batch_id;

      IF (COALESCE(v_reserved_stock, 0) + v_new_qty) > v_current_stock THEN
        RAISE EXCEPTION 'Insufficient stock: Batch has %kg available, %kg already reserved, cannot reserve additional %kg',
          v_current_stock, COALESCE(v_reserved_stock, 0), v_new_qty;
      END IF;

      UPDATE batches
      SET reserved_stock = COALESCE(reserved_stock, 0) + v_new_qty
      WHERE id = v_batch_id;

      INSERT INTO delivery_challan_items (
        challan_id, product_id, batch_id, quantity,
        pack_size, pack_type, number_of_packs
      ) VALUES (
        p_challan_id, v_product_id, v_batch_id, v_new_qty,
        (v_item->>'pack_size')::numeric,
        v_item->>'pack_type',
        (v_item->>'number_of_packs')::integer
      );
    END IF;
  END LOOP;

  PERFORM set_config('app.skip_dc_item_trigger', 'false', true);

  RETURN jsonb_build_object('success', true, 'message', 'Delivery challan updated successfully');

EXCEPTION
  WHEN foreign_key_violation THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', 'Invalid product or batch selection');
  WHEN OTHERS THEN
    PERFORM set_config('app.skip_dc_item_trigger', 'false', true);
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_create_import_requirements
-- ─────────────────────────────────────────────────────────────────────────────
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
  -- Allow internal calls from other SECURITY DEFINER functions (no session user)
  -- and role-authenticated calls from the frontend.
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF auth.uid() IS NOT NULL AND v_role NOT IN ('admin', 'accounts', 'manager') THEN
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

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_release_partial_reservation
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_release_partial_reservation(p_so_id uuid, p_product_id uuid, p_qty numeric, p_released_by uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_reservation RECORD;
  v_remaining_qty numeric := p_qty;
  v_release_qty numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot release stock reservations', v_role;
  END IF;

  FOR v_reservation IN
    SELECT id, reserved_quantity FROM stock_reservations
    WHERE sales_order_id = p_so_id
      AND product_id = p_product_id
      AND (status = 'active' OR (status IS NULL AND is_released = false))
    ORDER BY created_at ASC
  LOOP
    EXIT WHEN v_remaining_qty <= 0;
    v_release_qty := LEAST(v_remaining_qty, v_reservation.reserved_quantity);
    IF v_release_qty >= v_reservation.reserved_quantity THEN
      UPDATE stock_reservations
      SET status = 'released', is_released = true,
          released_at = now(), released_by = p_released_by
      WHERE id = v_reservation.id;
    ELSE
      UPDATE stock_reservations
      SET reserved_quantity = reserved_quantity - v_release_qty
      WHERE id = v_reservation.id;
    END IF;
    v_remaining_qty := v_remaining_qty - v_release_qty;
  END LOOP;
  RETURN true;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_release_stock_reservations (2-arg overload)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_release_stock_reservations(p_so_id uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_reservation RECORD;
  v_so_number text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot release stock reservations', v_role;
  END IF;

  SELECT so_number INTO v_so_number FROM sales_orders WHERE id = p_so_id;

  FOR v_reservation IN
    SELECT * FROM stock_reservations
    WHERE sales_order_id = p_so_id AND status = 'active'
  LOOP
    INSERT INTO inventory_transactions (
      product_id, batch_id, transaction_type, quantity, transaction_date,
      reference_number, notes, created_by
    ) VALUES (
      v_reservation.product_id, v_reservation.batch_id, 'release_reservation',
      v_reservation.reserved_quantity, CURRENT_DATE,
      v_so_number, 'Reservation released: ' || p_reason, auth.uid()
    );
  END LOOP;

  UPDATE stock_reservations
  SET
    status         = 'released',
    released_at    = now(),
    released_by    = auth.uid(),
    release_reason = p_reason
  WHERE sales_order_id = p_so_id AND status = 'active';

  RETURN true;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_release_stock_reservations (3-arg overload with p_user_id)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_release_stock_reservations(p_so_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot release stock reservations', v_role;
  END IF;

  UPDATE stock_reservations
  SET
    status         = 'released',
    released_at    = now(),
    released_by    = p_user_id,
    release_reason = p_reason
  WHERE sales_order_id = p_so_id AND status = 'active';

  RETURN true;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_reserve_stock_for_so
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_reserve_stock_for_so(p_so_id uuid)
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
  v_reserve_qty numeric;
  v_user_id uuid;
  v_so_number text;
  v_customer_id uuid;
  v_so_date timestamptz;
  v_shortage_list jsonb := '[]'::jsonb;
  v_has_shortage boolean := false;
  v_already_delivered numeric;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot reserve stock for sales orders', v_role;
  END IF;

  SELECT created_by, so_number, customer_id, created_at
  INTO v_user_id, v_so_number, v_customer_id, v_so_date
  FROM sales_orders WHERE id = p_so_id;

  FOR v_item IN
    SELECT * FROM sales_order_items WHERE sales_order_id = p_so_id ORDER BY created_at
  LOOP
    SELECT COALESCE(SUM(dci.quantity), 0)
    INTO v_already_delivered
    FROM delivery_challan_items dci
    JOIN delivery_challans dc ON dc.id = dci.challan_id
    WHERE dci.product_id = v_item.product_id
      AND dc.customer_id = v_customer_id
      AND dc.approval_status = 'approved'
      AND dc.approved_at >= v_so_date
      AND dc.approved_at <= now()
      AND (dc.sales_order_id IS NULL OR dc.sales_order_id = p_so_id);

    v_remaining_qty := v_item.quantity - v_already_delivered;

    IF v_remaining_qty <= 0 THEN
      UPDATE sales_order_items SET delivered_quantity = v_item.quantity WHERE id = v_item.id;
      CONTINUE;
    END IF;

    FOR v_batch IN
      SELECT b.id, b.batch_number, fn_get_free_stock(b.id) as free_stock
      FROM batches b
      WHERE b.product_id = v_item.product_id AND b.current_stock > 0
      ORDER BY b.expiry_date ASC, b.created_at ASC
    LOOP
      EXIT WHEN v_remaining_qty <= 0;
      IF v_batch.free_stock > 0 THEN
        v_reserve_qty := LEAST(v_remaining_qty, v_batch.free_stock);

        INSERT INTO stock_reservations (
          sales_order_id, sales_order_item_id, batch_id, product_id,
          reserved_quantity, reserved_by, status
        ) VALUES (
          p_so_id, v_item.id, v_batch.id, v_item.product_id,
          v_reserve_qty, v_user_id, 'active'
        );

        INSERT INTO inventory_transactions (
          product_id, batch_id, transaction_type, quantity,
          transaction_date, reference_number, notes, created_by
        ) VALUES (
          v_item.product_id, v_batch.id, 'reservation', v_reserve_qty,
          CURRENT_DATE, v_so_number, 'Stock reserved for SO: ' || v_so_number, v_user_id
        );

        v_remaining_qty := v_remaining_qty - v_reserve_qty;
      END IF;
    END LOOP;

    IF v_remaining_qty > 0 THEN
      v_has_shortage := true;
      v_shortage_list := v_shortage_list || jsonb_build_object(
        'product_id', v_item.product_id,
        'required_qty', v_item.quantity,
        'shortage_qty', v_remaining_qty
      );
    END IF;
  END LOOP;

  IF v_has_shortage THEN
    UPDATE sales_orders SET status = 'shortage', updated_at = now() WHERE id = p_so_id;
    PERFORM fn_create_import_requirements(p_so_id, v_shortage_list);
    RETURN QUERY SELECT false, 'Partial stock reserved - shortage detected. Import requirements created.', v_shortage_list;
  ELSE
    IF EXISTS (
      SELECT 1 FROM sales_order_items
      WHERE sales_order_id = p_so_id AND delivered_quantity >= quantity
    ) AND NOT EXISTS (
      SELECT 1 FROM sales_order_items
      WHERE sales_order_id = p_so_id AND delivered_quantity < quantity
    ) THEN
      UPDATE sales_orders SET status = 'delivered', updated_at = now() WHERE id = p_so_id;
    ELSE
      UPDATE sales_orders SET status = 'stock_reserved', updated_at = now() WHERE id = p_so_id;
    END IF;
    RETURN QUERY SELECT true, 'Stock reserved successfully', '[]'::jsonb;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- fn_reserve_stock_for_so_v2
-- ─────────────────────────────────────────────────────────────────────────────
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
  IF v_role NOT IN ('admin', 'accounts', 'manager') THEN
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

-- ─────────────────────────────────────────────────────────────────────────────
-- log_timeline_event
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_timeline_event(
  p_inquiry_id uuid,
  p_event_type text,
  p_event_title text,
  p_event_description text DEFAULT NULL::text,
  p_old_value text DEFAULT NULL::text,
  p_new_value text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  new_timeline_id uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot log timeline events', v_role;
  END IF;

  INSERT INTO crm_inquiry_timeline (
    inquiry_id, event_type, event_title, event_description,
    old_value, new_value, performed_by
  ) VALUES (
    p_inquiry_id, p_event_type, p_event_title, p_event_description,
    p_old_value, p_new_value,
    COALESCE(p_performed_by, auth.uid())
  ) RETURNING id INTO new_timeline_id;

  RETURN new_timeline_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- manually_post_pending_fund_transfers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.manually_post_pending_fund_transfers()
RETURNS TABLE(transfer_num text, post_status text, post_message text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_transfer RECORD;
  v_from_account_id UUID;
  v_to_account_id UUID;
  v_from_currency TEXT;
  v_to_currency TEXT;
  v_journal_id UUID;
  v_entry_number TEXT;
  v_description TEXT;
  v_from_amount NUMERIC;
  v_to_amount NUMERIC;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot manually post fund transfers', v_role;
  END IF;

  FOR v_transfer IN
    SELECT * FROM fund_transfers WHERE fund_transfers.status = 'pending' ORDER BY fund_transfers.created_at ASC
  LOOP
    BEGIN
      SELECT generate_journal_entry_number() INTO v_entry_number;

      IF v_transfer.from_account_type = 'petty_cash' THEN
        SELECT id, 'IDR' INTO v_from_account_id, v_from_currency FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
      ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
        SELECT id, 'IDR' INTO v_from_account_id, v_from_currency FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
      ELSIF v_transfer.from_account_type = 'bank' THEN
        SELECT coa_id, currency INTO v_from_account_id, v_from_currency FROM bank_accounts WHERE id = v_transfer.from_bank_account_id;
      END IF;

      IF v_transfer.to_account_type = 'petty_cash' THEN
        SELECT id, 'IDR' INTO v_to_account_id, v_to_currency FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
      ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
        SELECT id, 'IDR' INTO v_to_account_id, v_to_currency FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
      ELSIF v_transfer.to_account_type = 'bank' THEN
        SELECT coa_id, currency INTO v_to_account_id, v_to_currency FROM bank_accounts WHERE id = v_transfer.to_bank_account_id;
      END IF;

      IF v_from_account_id IS NULL OR v_to_account_id IS NULL THEN
        transfer_num  := v_transfer.transfer_number;
        post_status   := 'ERROR';
        post_message  := 'Cannot determine chart of accounts';
        RETURN NEXT;
        CONTINUE;
      END IF;

      v_from_amount := v_transfer.from_amount;
      v_to_amount   := v_transfer.to_amount;

      v_description := 'Fund Transfer ' || v_transfer.transfer_number;
      IF v_from_currency != v_to_currency THEN
        v_description := v_description || ' (FX: ' || v_from_currency || ' → ' || v_to_currency || ')';
      END IF;
      IF v_transfer.description IS NOT NULL THEN
        v_description := v_description || ' - ' || v_transfer.description;
      END IF;

      INSERT INTO journal_entries (
        entry_number, entry_date, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, created_by
      ) VALUES (
        v_entry_number, v_transfer.transfer_date, 'fund_transfers', v_transfer.id, v_transfer.transfer_number,
        v_description, v_from_amount, v_from_amount, true, v_transfer.created_by
      ) RETURNING id INTO v_journal_id;

      IF v_from_currency = v_to_currency THEN
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES
          (v_journal_id, 1, v_to_account_id,   v_from_amount, 0,             'Transfer In: '  || v_transfer.transfer_number),
          (v_journal_id, 2, v_from_account_id, 0,             v_from_amount, 'Transfer Out: ' || v_transfer.transfer_number);
      ELSE
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES
          (v_journal_id, 1, v_to_account_id,   v_from_amount, 0,
           'Transfer In: '  || v_transfer.transfer_number || ' (' || v_to_currency   || ' ' || v_to_amount::TEXT   || ')'),
          (v_journal_id, 2, v_from_account_id, 0,             v_from_amount,
           'Transfer Out: ' || v_transfer.transfer_number || ' (' || v_from_currency || ' ' || v_from_amount::TEXT || ')');
      END IF;

      UPDATE fund_transfers
      SET journal_entry_id = v_journal_id, status = 'posted', posted_at = now(), posted_by = v_transfer.created_by
      WHERE id = v_transfer.id;

      transfer_num := v_transfer.transfer_number;
      post_status  := 'POSTED';
      post_message := 'Successfully posted';
      RETURN NEXT;

    EXCEPTION WHEN OTHERS THEN
      transfer_num := v_transfer.transfer_number;
      post_status  := 'ERROR';
      post_message := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- post_import_cost_journal
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_import_cost_journal(p_header_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_header RECORD;
  v_je_id UUID;
  v_je_number TEXT;
  v_inventory_account_id UUID;
  v_clearing_account_id UUID;
  v_total_cost DECIMAL(18,2);
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot post import cost journals', v_role;
  END IF;

  SELECT * INTO v_header FROM import_cost_headers WHERE id = p_header_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import cost header not found';
  END IF;

  SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
  SELECT id INTO v_clearing_account_id  FROM chart_of_accounts WHERE code = '2140' LIMIT 1;

  IF v_inventory_account_id IS NULL OR v_clearing_account_id IS NULL THEN
    RAISE EXCEPTION 'Required accounts not found (1130 Inventory or 2140 Customer Deposits)';
  END IF;

  v_total_cost := v_header.duty_amount + v_header.ppn_import_amount + v_header.pph22_amount +
                  v_header.freight_amount + v_header.insurance_amount + v_header.clearing_amount +
                  v_header.port_charges + v_header.other_charges;

  IF v_total_cost <= 0 THEN
    RAISE EXCEPTION 'Total allocated cost must be greater than zero';
  END IF;

  v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
    SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
  )::TEXT, 4, '0');

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by
  ) VALUES (
    v_je_number, v_header.import_date, 'import_cost', p_header_id, v_header.cost_sheet_number,
    'Import Cost Allocation: ' || v_header.cost_sheet_number,
    v_total_cost, v_total_cost, true, v_header.created_by
  ) RETURNING id INTO v_je_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
  VALUES
    (v_je_id, 1, v_inventory_account_id, 'Import Costs - '    || v_header.cost_sheet_number, v_total_cost, 0,            v_header.supplier_id),
    (v_je_id, 2, v_clearing_account_id,  'Import Clearing - ' || v_header.cost_sheet_number, 0,            v_total_cost, v_header.supplier_id);

  RETURN v_je_id;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- preview_bank_statement_delete
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.preview_bank_statement_delete(p_bank_account_id uuid, p_start_date date, p_end_date date)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_bank_info JSON;
  v_total_count INTEGER;
  v_reconciled_count INTEGER;
  v_unmatched_count INTEGER;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot preview bank statement deletions', v_role;
  END IF;

  SELECT json_build_object(
    'account_name',   account_name,
    'bank_name',      bank_name,
    'account_number', account_number,
    'currency',       currency
  ) INTO v_bank_info
  FROM bank_accounts WHERE id = p_bank_account_id;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE reconciliation_status IN ('matched', 'recorded', 'suggested')),
    COUNT(*) FILTER (WHERE reconciliation_status = 'unmatched')
  INTO v_total_count, v_reconciled_count, v_unmatched_count
  FROM bank_statement_lines
  WHERE bank_account_id = p_bank_account_id
    AND transaction_date >= p_start_date
    AND transaction_date <= p_end_date;

  RETURN json_build_object(
    'bank_info',        v_bank_info,
    'start_date',       p_start_date,
    'end_date',         p_end_date,
    'total_count',      v_total_count,
    'reconciled_count', v_reconciled_count,
    'unmatched_count',  v_unmatched_count,
    'can_delete',       v_reconciled_count = 0 AND v_total_count > 0,
    'warning', CASE
      WHEN v_reconciled_count > 0 THEN 'Cannot delete: Contains ' || v_reconciled_count || ' reconciled transaction(s). Please unreconcile first.'
      WHEN v_total_count = 0      THEN 'No transactions found in this date range'
      ELSE NULL
    END
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- reallocate_container_costs
-- ─────────────────────────────────────────────────────────────────────────────
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
  IF v_role NOT IN ('admin', 'accounts') THEN
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

-- ─────────────────────────────────────────────────────────────────────────────
-- update_sales_invoice_atomic (4-arg overload: jsonb items)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_items jsonb,
  p_user_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_invoice RECORD;
  v_old_je_id UUID;
  v_item JSONB;
  v_batch_id UUID;
  v_result JSONB;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  SELECT * INTO v_invoice FROM sales_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  v_old_je_id := v_invoice.journal_entry_id;

  IF v_old_je_id IS NOT NULL THEN
    DELETE FROM journal_entry_lines WHERE journal_entry_id = v_old_je_id;
    DELETE FROM journal_entries WHERE id = v_old_je_id;
  END IF;

  UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = p_invoice_id;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date     = COALESCE((p_invoice_updates->>'invoice_date')::DATE, invoice_date),
    due_date         = COALESCE((p_invoice_updates->>'due_date')::DATE, due_date),
    customer_id      = COALESCE((p_invoice_updates->>'customer_id')::UUID, customer_id),
    subtotal         = COALESCE((p_invoice_updates->>'subtotal')::NUMERIC, subtotal),
    tax_amount       = COALESCE((p_invoice_updates->>'tax_amount')::NUMERIC, tax_amount),
    total_amount     = COALESCE((p_invoice_updates->>'total_amount')::NUMERIC, total_amount),
    discount_amount  = COALESCE((p_invoice_updates->>'discount_amount')::NUMERIC, discount_amount),
    notes            = COALESCE(p_invoice_updates->>'notes', notes),
    currency         = COALESCE(p_invoice_updates->>'currency', currency),
    exchange_rate    = COALESCE((p_invoice_updates->>'exchange_rate')::NUMERIC, exchange_rate),
    linked_challan_ids = CASE
      WHEN p_invoice_updates ? 'linked_challan_ids'
      THEN (SELECT ARRAY(SELECT jsonb_array_elements_text(p_invoice_updates->'linked_challan_ids'))::UUID[])
      ELSE linked_challan_ids
    END,
    updated_at = now()
  WHERE id = p_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_batch_id := NULLIF((v_item->>'batch_id')::TEXT, '')::UUID;

    INSERT INTO sales_invoice_items (
      invoice_id, product_id, batch_id, quantity, unit_price, discount_percent,
      line_total, dc_item_id, unit_type
    ) VALUES (
      p_invoice_id,
      (v_item->>'product_id')::UUID,
      v_batch_id,
      (v_item->>'quantity')::NUMERIC,
      (v_item->>'unit_price')::NUMERIC,
      COALESCE((v_item->>'discount_percent')::NUMERIC, 0),
      (v_item->>'line_total')::NUMERIC,
      NULLIF((v_item->>'dc_item_id')::TEXT, '')::UUID,
      COALESCE(v_item->>'unit_type', 'pcs')
    );
  END LOOP;

  UPDATE sales_invoices
  SET status = status
  WHERE id = p_invoice_id AND journal_entry_id IS NULL;

  SELECT journal_entry_id INTO v_invoice.journal_entry_id FROM sales_invoices WHERE id = p_invoice_id;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'journal_reversed', v_old_je_id IS NOT NULL,
    'journal_entry_id', v_invoice.journal_entry_id
  );

EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Failed to update invoice: %', SQLERRM;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- update_sales_invoice_atomic (3-arg overload: jsonb[] items)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_sales_invoice_atomic(
  p_invoice_id uuid,
  p_invoice_updates jsonb,
  p_new_items jsonb[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
  v_result UUID;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'sales', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update sales invoices', v_role;
  END IF;

  DELETE FROM sales_invoice_items WHERE invoice_id = p_invoice_id;

  UPDATE sales_invoices
  SET
    invoice_date        = COALESCE((p_invoice_updates->>'invoice_date')::date, invoice_date),
    due_date            = COALESCE((p_invoice_updates->>'due_date')::date, due_date),
    customer_id         = COALESCE((p_invoice_updates->>'customer_id')::uuid, customer_id),
    subtotal            = COALESCE((p_invoice_updates->>'subtotal')::numeric, subtotal),
    tax_amount          = COALESCE((p_invoice_updates->>'tax_amount')::numeric, tax_amount),
    total_amount        = COALESCE((p_invoice_updates->>'total_amount')::numeric, total_amount),
    discount_amount     = COALESCE((p_invoice_updates->>'discount_amount')::numeric, discount_amount),
    po_number           = COALESCE(p_invoice_updates->>'po_number', po_number),
    payment_terms_days  = COALESCE((p_invoice_updates->>'payment_terms_days')::integer, payment_terms_days),
    notes               = COALESCE(p_invoice_updates->>'notes', notes),
    updated_at          = NOW()
  WHERE id = p_invoice_id
  RETURNING id INTO v_result;

  INSERT INTO sales_invoice_items (
    invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, delivery_challan_item_id
  )
  SELECT
    p_invoice_id,
    (item->>'product_id')::uuid,
    (item->>'batch_id')::uuid,
    (item->>'quantity')::numeric,
    (item->>'unit_price')::numeric,
    (item->>'tax_rate')::numeric,
    NULLIF(item->>'delivery_challan_item_id', '')::uuid
  FROM unnest(p_new_items) AS item;

  RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- update_so_delivered_quantity_atomic
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_so_delivered_quantity_atomic(p_sales_order_id uuid, p_dc_items jsonb[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin', 'accounts', 'warehouse', 'manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot update delivered quantities', v_role;
  END IF;

  UPDATE sales_order_items soi
  SET delivered_quantity = COALESCE(soi.delivered_quantity, 0) + COALESCE(
    (
      SELECT SUM((item->>'quantity')::numeric)
      FROM unnest(p_dc_items) AS item
      WHERE (item->>'product_id')::uuid = soi.product_id
    ), 0
  )
  WHERE soi.sales_order_id = p_sales_order_id;

  UPDATE sales_orders
  SET status = CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM sales_order_items
      WHERE sales_order_id = p_sales_order_id
        AND COALESCE(delivered_quantity, 0) < quantity
    ) THEN 'delivered'::sales_order_status
    ELSE 'partially_delivered'::sales_order_status
  END
  WHERE id = p_sales_order_id;
END;
$$;
