-- Direction-aware commercial FX reference for Sales Orders.
-- Keep commercial_usd_to_idr_rate as the normalized USD/IDR basis used by
-- the FX Business Dashboard. IDR-denominated Sales Orders also store the
-- reciprocal IDR/USD rate shown to the user.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS commercial_idr_to_usd_rate numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sales_orders'::regclass
      AND conname = 'sales_orders_commercial_idr_to_usd_rate_positive'
  ) THEN
    ALTER TABLE public.sales_orders
      ADD CONSTRAINT sales_orders_commercial_idr_to_usd_rate_positive
      CHECK (commercial_idr_to_usd_rate IS NULL OR commercial_idr_to_usd_rate > 0)
      NOT VALID;
  END IF;
END $$;

ALTER TABLE public.sales_orders
  VALIDATE CONSTRAINT sales_orders_commercial_idr_to_usd_rate_positive;

CREATE OR REPLACE FUNCTION public.update_sales_order_commercial_fx_rate(
  p_so_id uuid,
  p_new_rate numeric,
  p_reason text DEFAULT 'Historical commercial FX rate backfill'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_so public.sales_orders%ROWTYPE;
  v_user_id uuid := auth.uid();
  v_user_email text;
  v_old_usd_to_idr numeric;
  v_old_idr_to_usd numeric;
  v_new_usd_to_idr numeric;
  v_new_idr_to_usd numeric;
  v_currency text;
  v_direction text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = v_user_id AND role IN ('admin', 'manager', 'accounts', 'sales')
  ) THEN
    RAISE EXCEPTION 'Unauthorized to modify commercial rates';
  END IF;

  SELECT * INTO v_so
    FROM public.sales_orders
   WHERE id = p_so_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sales order not found');
  END IF;

  IF p_new_rate IS NULL OR p_new_rate <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Commercial exchange rate must be positive');
  END IF;

  v_currency := upper(COALESCE(v_so.currency, 'IDR'));
  v_old_usd_to_idr := v_so.commercial_usd_to_idr_rate;
  v_old_idr_to_usd := v_so.commercial_idr_to_usd_rate;

  IF v_currency = 'IDR' THEN
    IF p_new_rate >= 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'IDR Sales Orders require an IDR→USD rate below 1, for example 0.000058'
      );
    END IF;
    v_direction := 'IDR_TO_USD';
    v_new_idr_to_usd := p_new_rate;
    -- The normalized USD→IDR market reference remains available for downstream FX reporting.
    v_new_usd_to_idr := round(1 / p_new_rate, 6);
  ELSE
    IF p_new_rate < 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'USD Sales Orders require a USD→IDR rate, for example 17850'
      );
    END IF;
    v_direction := 'USD_TO_IDR';
    v_new_usd_to_idr := p_new_rate;
    v_new_idr_to_usd := NULL;
  END IF;

  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;

  UPDATE public.sales_orders
     SET commercial_usd_to_idr_rate = v_new_usd_to_idr,
         commercial_idr_to_usd_rate = v_new_idr_to_usd,
         updated_at = now()
   WHERE id = p_so_id;

  INSERT INTO public.audit_logs (
    table_name, record_id, action_type, old_values, new_values,
    changed_fields, user_id, user_email, created_at
  ) VALUES (
    'sales_orders',
    p_so_id,
    'update',
    jsonb_build_object(
      'so_number', v_so.so_number,
      'currency', v_currency,
      'total_amount', v_so.total_amount,
      'commercial_usd_to_idr_rate', v_old_usd_to_idr,
      'commercial_idr_to_usd_rate', v_old_idr_to_usd
    ),
    jsonb_build_object(
      'so_number', v_so.so_number,
      'currency', v_currency,
      'total_amount', v_so.total_amount,
      'commercial_usd_to_idr_rate', v_new_usd_to_idr,
      'commercial_idr_to_usd_rate', v_new_idr_to_usd,
      'rate_direction', v_direction,
      'reason', COALESCE(NULLIF(trim(p_reason), ''), 'Commercial FX rate update')
    ),
    ARRAY['commercial_usd_to_idr_rate','commercial_idr_to_usd_rate'],
    v_user_id,
    v_user_email,
    now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'so_id', p_so_id,
    'so_number', v_so.so_number,
    'currency', v_currency,
    'rate_direction', v_direction,
    'usd_to_idr_rate', v_new_usd_to_idr,
    'idr_to_usd_rate', v_new_idr_to_usd,
    'reason', p_reason
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_sales_order_commercial_fx_rate(uuid, numeric, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_sales_order_commercial_fx_rate(uuid, numeric, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_sales_order_commercial_fx_rate(uuid, numeric, text) TO authenticated, service_role;
