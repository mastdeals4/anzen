-- Migration: 20260921210000_sales_order_commercial_fx_rate_edit.sql
-- Description: Provide isolated, audited update function for sales_orders.commercial_usd_to_idr_rate

CREATE OR REPLACE FUNCTION public.update_sales_order_commercial_rate(
  p_so_id uuid,
  p_new_rate numeric,
  p_reason text DEFAULT 'Commercial FX rate updated'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_so public.sales_orders%ROWTYPE;
  v_old_rate numeric;
  v_user_id uuid;
  v_user_email text;
BEGIN
  -- 1. Check SO exists
  SELECT * INTO v_so FROM public.sales_orders WHERE id = p_so_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  v_old_rate := v_so.commercial_usd_to_idr_rate;
  v_user_id := auth.uid();
  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  END IF;

  -- 2. Validate rate: NULL or positive numeric
  IF p_new_rate IS NOT NULL AND p_new_rate <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Commercial exchange rate must be positive or null');
  END IF;

  -- 3. Update ONLY commercial_usd_to_idr_rate
  UPDATE public.sales_orders
     SET commercial_usd_to_idr_rate = p_new_rate,
         updated_at = now()
   WHERE id = p_so_id;

  -- 4. Record audit entry in existing audit_logs
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

GRANT EXECUTE ON FUNCTION public.update_sales_order_commercial_rate(uuid, numeric, text) TO authenticated, service_role;
