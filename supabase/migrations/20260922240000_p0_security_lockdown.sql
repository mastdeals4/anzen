-- Migration: P0 Security Lockdown
-- Revoke PUBLIC and anon execution on sensitive security definer functions
-- Add caller authorization guards to upsert_notification and update_sales_order_commercial_rate

-- 1. Revoke PUBLIC and anon execution on priority functions
DO $$
DECLARE
  v_sql text;
BEGIN
  -- ai_inventory_movement
  REVOKE ALL ON FUNCTION public.ai_inventory_movement(date, date) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.ai_inventory_movement(date, date) FROM anon;
  GRANT EXECUTE ON FUNCTION public.ai_inventory_movement(date, date) TO authenticated, service_role;

  -- calculate_bank_account_book_balance
  REVOKE ALL ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) FROM anon;
  GRANT EXECUTE ON FUNCTION public.calculate_bank_account_book_balance(uuid, date) TO authenticated, service_role;

  -- get_bank_account_balances
  REVOKE ALL ON FUNCTION public.get_bank_account_balances(date) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_bank_account_balances(date) FROM anon;
  GRANT EXECUTE ON FUNCTION public.get_bank_account_balances(date) TO authenticated, service_role;

  -- get_customer_product_price_history
  REVOKE ALL ON FUNCTION public.get_customer_product_price_history(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_customer_product_price_history(uuid, uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.get_customer_product_price_history(uuid, uuid) TO authenticated, service_role;

  -- get_gmail_connection_secret
  REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.get_gmail_connection_secret(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.get_gmail_connection_secret(uuid) TO authenticated, service_role;

  -- recalculate_batch_landed_cost
  REVOKE ALL ON FUNCTION public.recalculate_batch_landed_cost(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.recalculate_batch_landed_cost(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.recalculate_batch_landed_cost(uuid) TO authenticated, service_role;

  -- calculate_batch_direct_landed_cost
  REVOKE ALL ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.calculate_batch_direct_landed_cost(uuid) TO authenticated, service_role;

  -- reconcile_all_sales_cogs
  REVOKE ALL ON FUNCTION public.reconcile_all_sales_cogs(date, date) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reconcile_all_sales_cogs(date, date) FROM anon;
  GRANT EXECUTE ON FUNCTION public.reconcile_all_sales_cogs(date, date) TO authenticated, service_role;

  -- update_sales_order_commercial_rate
  REVOKE ALL ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) FROM anon;
  GRANT EXECUTE ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) TO authenticated, service_role;
END $$;

-- 2. Authorization guard in upsert_notification
CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_message text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_reference_type text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted integer := 0;
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Caller can only notify themselves unless they are admin, manager, or system
  IF v_caller != p_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles 
      WHERE id = v_caller AND role IN ('admin', 'manager')
    ) THEN
      RAISE EXCEPTION 'Unauthorized to send notifications to other users';
    END IF;
  END IF;

  INSERT INTO notifications (user_id, type, title, message, reference_id, reference_type, is_read)
  VALUES (p_user_id, p_type, p_title, p_message, p_reference_id, p_reference_type, false)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.upsert_notification(uuid, text, text, text, uuid, text) TO authenticated, service_role;

-- 3. Authorization guard in update_sales_order_commercial_rate
CREATE OR REPLACE FUNCTION public.update_sales_order_commercial_rate(
  p_so_id uuid,
  p_new_rate numeric,
  p_reason text DEFAULT 'Commercial FX rate updated'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so public.sales_orders%ROWTYPE;
  v_old_rate numeric;
  v_user_id uuid := auth.uid();
  v_user_email text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Only admin, manager, accounts, sales roles can update commercial rates
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = v_user_id AND role IN ('admin', 'manager', 'accounts', 'sales')
  ) THEN
    RAISE EXCEPTION 'Unauthorized to modify commercial rates';
  END IF;

  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  v_old_rate := v_so.commercial_usd_to_idr_rate;
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  IF p_new_rate IS NOT NULL AND p_new_rate <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Commercial exchange rate must be positive or null');
  END IF;

  UPDATE public.sales_orders
     SET commercial_usd_to_idr_rate = p_new_rate,
         updated_at = now()
   WHERE id = p_so_id;

  INSERT INTO public.audit_logs (
    table_name,
    record_id,
    action_type,
    old_values,
    new_values,
    changed_fields,
    user_id,
    user_email,
    created_at
  ) VALUES (
    'sales_orders',
    p_so_id,
    'update',
    jsonb_build_object(
      'so_number', v_so.so_number,
      'currency', v_so.currency,
      'total_amount', v_so.total_amount,
      'commercial_usd_to_idr_rate', v_old_rate
    ),
    jsonb_build_object(
      'so_number', v_so.so_number,
      'currency', v_so.currency,
      'total_amount', v_so.total_amount,
      'commercial_usd_to_idr_rate', p_new_rate,
      'reason', COALESCE(NULLIF(trim(p_reason), ''), 'Commercial FX rate update')
    ),
    ARRAY['commercial_usd_to_idr_rate'],
    v_user_id,
    v_user_email,
    now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'so_number', v_so.so_number,
    'old_rate', v_old_rate,
    'new_rate', p_new_rate,
    'reason', p_reason
  );
END;
$$;
