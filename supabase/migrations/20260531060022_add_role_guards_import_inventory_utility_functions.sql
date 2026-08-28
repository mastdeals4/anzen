/*
  # Security Fix Part 4: Add role guards to import/inventory and remaining functions

  Correct return types used to avoid signature conflicts.
*/

-- Import container: admin/accounts only
CREATE OR REPLACE FUNCTION public.allocate_import_costs_to_batches(p_container_id uuid)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_container             RECORD;
  v_batch                 RECORD;
  v_total_invoice_value   DECIMAL(18,2);
  v_total_import_cost     DECIMAL(18,2);
  v_allocation_percentage DECIMAL(10,6);
  v_allocated_cost        DECIMAL(18,2);
  v_batches_allocated     INTEGER := 0;
  v_role                  text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot allocate import costs', v_role;
  END IF;

  SELECT * INTO v_container FROM import_containers WHERE id = p_container_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Container not found: %', p_container_id; END IF;

  SELECT COALESCE(SUM(b.invoice_value_usd * COALESCE(b.exchange_rate_idr, 1)), 0)
  INTO v_total_invoice_value
  FROM batches b WHERE b.import_container_id = p_container_id AND b.is_active = true;

  IF v_total_invoice_value = 0 THEN
    RETURN json_build_object('success', false, 'error', 'No batch invoice value found for container');
  END IF;

  SELECT COALESCE(
    COALESCE(v_container.freight_cost, 0) +
    COALESCE(v_container.insurance_cost, 0) +
    COALESCE(v_container.handling_charges, 0) +
    COALESCE(v_container.other_charges, 0), 0
  ) INTO v_total_import_cost;

  FOR v_batch IN
    SELECT b.id, b.invoice_value_usd * COALESCE(b.exchange_rate_idr, 1) as batch_value
    FROM batches b WHERE b.import_container_id = p_container_id AND b.is_active = true
  LOOP
    IF v_total_invoice_value > 0 THEN
      v_allocation_percentage := v_batch.batch_value / v_total_invoice_value;
      v_allocated_cost := ROUND(v_total_import_cost * v_allocation_percentage, 2);
      UPDATE batches SET import_cost_allocated = v_allocated_cost, updated_at = now()
      WHERE id = v_batch.id;
      v_batches_allocated := v_batches_allocated + 1;
    END IF;
  END LOOP;

  RETURN json_build_object('success', true, 'batches_allocated', v_batches_allocated,
    'total_import_cost', v_total_import_cost);
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_import_container(p_container_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot lock import containers', v_role;
  END IF;

  UPDATE import_containers
  SET status = 'locked', locked_at = now(), locked_by = p_user_id, updated_at = now()
  WHERE id = p_container_id AND status = 'allocated';
  IF NOT FOUND THEN RAISE EXCEPTION 'Container not found or already locked'; END IF;

  UPDATE batches SET cost_locked = true, cost_locked_at = now(), updated_at = now()
  WHERE import_container_id = p_container_id AND cost_locked = false;

  RETURN true;
END;
$$;

-- CRM: admin/accounts/sales
CREATE OR REPLACE FUNCTION public.mark_requirement_sent(inquiry_id uuid, requirement_type text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','sales') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot mark requirements as sent', v_role;
  END IF;

  CASE requirement_type
    WHEN 'price'         THEN UPDATE crm_inquiries SET price_sent_at = now() WHERE id = inquiry_id;
    WHEN 'coa'           THEN UPDATE crm_inquiries SET coa_sent_at = now() WHERE id = inquiry_id;
    WHEN 'sample'        THEN UPDATE crm_inquiries SET sample_sent_at = now() WHERE id = inquiry_id;
    WHEN 'agency_letter' THEN UPDATE crm_inquiries SET agency_letter_sent_at = now() WHERE id = inquiry_id;
    ELSE RAISE EXCEPTION 'Invalid requirement type: %', requirement_type;
  END CASE;
END;
$$;

-- log_export: any authenticated user (logs their own actions)
CREATE OR REPLACE FUNCTION public.log_export(
  p_export_type text, p_module_name text,
  p_filter_criteria jsonb DEFAULT NULL, p_record_count integer DEFAULT NULL,
  p_file_format text DEFAULT 'csv'
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  log_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO export_audit_log (user_id, export_type, module_name, filter_criteria, record_count, file_format)
  VALUES (auth.uid(), p_export_type, p_module_name, p_filter_criteria, p_record_count, p_file_format)
  RETURNING id INTO log_id;

  RETURN log_id;
END;
$$;

-- upsert_notification: returns boolean, any authenticated user
CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid, p_type text, p_title text, p_message text,
  p_reference_id text DEFAULT NULL, p_reference_type text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_inserted boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
EXCEPTION
  WHEN unique_violation THEN RETURN false;
END;
$$;

-- dismiss_system_task: returns boolean, admin/accounts/manager
CREATE OR REPLACE FUNCTION public.dismiss_system_task(
  p_task_id uuid, p_reason text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','manager') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot dismiss system tasks', v_role;
  END IF;

  UPDATE tasks
  SET dismissed_at = now(), dismissed_by = auth.uid(), dismissal_reason = p_reason,
      status = 'completed'::task_status
  WHERE id = p_task_id AND task_type = 'system' AND task_mode = 'advisory';
  RETURN FOUND;
END;
$$;

-- create_batch_inventory_transaction: returns void, admin/accounts/warehouse
CREATE OR REPLACE FUNCTION public.create_batch_inventory_transaction(
  p_product_id uuid, p_batch_id uuid, p_transaction_type text,
  p_quantity numeric, p_transaction_date date, p_notes text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts','warehouse') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot create inventory transactions', v_role;
  END IF;

  INSERT INTO inventory_transactions (
    product_id, batch_id, transaction_type, quantity, transaction_date, notes
  ) VALUES (
    p_product_id, p_batch_id, p_transaction_type, p_quantity, p_transaction_date, p_notes
  );
END;
$$;
