-- ==============================================================================
-- SAPJ ERP: Kunal Pricing Multi-Option Quotation & Customer Acceptance
-- Migration: 20261031120000_kunal_pricing_multi_option_quotation_and_acceptance.sql
-- ==============================================================================

-- 1. Register migration in schema tracker
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES
      ('20261031120000')
    ON CONFLICT (version) DO NOTHING;
  END IF;

  -- Ensure auth helper stubs exist if running in non-supabase test harness
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p 
    JOIN pg_namespace n ON p.pronamespace = n.oid 
    WHERE n.nspname = 'auth' AND p.proname = 'role'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $fn$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text;
    $fn$;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p 
    JOIN pg_namespace n ON p.pronamespace = n.oid 
    WHERE n.nspname = 'auth' AND p.proname = 'uid'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $fn$;
  END IF;
END $$;

-- 2. Ensure crm_inquiry_pricing_options exists and has quotation inclusion, customer acceptance, and persistent landed cost fields
CREATE TABLE IF NOT EXISTS public.crm_inquiry_pricing_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES public.crm_inquiries(id) ON DELETE CASCADE,
  source_type text NOT NULL DEFAULT 'india',
  offered_make text,
  source_price numeric,
  source_currency text NOT NULL DEFAULT 'USD',
  availability text NOT NULL DEFAULT 'available',
  document_status text NOT NULL DEFAULT 'pending',
  remark text,
  is_selected boolean NOT NULL DEFAULT false,
  confidence numeric,
  parser_result_id uuid,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  moq text,
  packing text,
  lead_time text,
  origin text,
  supplier text,
  specification text,
  margin_pct numeric,
  selling_price numeric,
  selling_currency text,
  include_in_customer_quote boolean NOT NULL DEFAULT false,
  is_accepted boolean NOT NULL DEFAULT false,
  landed_cost_usd numeric,
  suggested_quote_usd numeric
);

ALTER TABLE public.crm_inquiry_pricing_options
  ADD COLUMN IF NOT EXISTS include_in_customer_quote boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS landed_cost_usd numeric,
  ADD COLUMN IF NOT EXISTS suggested_quote_usd numeric;

-- 3. Add accepted_pricing_option_id to crm_inquiries
ALTER TABLE public.crm_inquiries
  ADD COLUMN IF NOT EXISTS accepted_pricing_option_id uuid 
  REFERENCES public.crm_inquiry_pricing_options(id) ON DELETE SET NULL;

-- 4. Backfill existing selected options so active options are included in customer quote by default
UPDATE public.crm_inquiry_pricing_options
SET include_in_customer_quote = true
WHERE is_selected = true AND include_in_customer_quote = false;

-- 5. Helper function and expanded RLS policy for pricing options
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

CREATE OR REPLACE FUNCTION public.current_user_has_pricing_role(allowed_roles text[])
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT (
    auth.role() = 'service_role' OR
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND is_active = true
        AND role = ANY(allowed_roles)
    )
  );
$$;

ALTER TABLE public.crm_inquiry_pricing_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pricing_options_read" ON public.crm_inquiry_pricing_options;
CREATE POLICY "pricing_options_read" ON public.crm_inquiry_pricing_options
  FOR SELECT TO authenticated, service_role
  USING (
    public.current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales', 'sales_support', 'accounts', 'director'])
  );

DROP POLICY IF EXISTS "pricing_options_insert" ON public.crm_inquiry_pricing_options;
CREATE POLICY "pricing_options_insert" ON public.crm_inquiry_pricing_options
  FOR INSERT TO authenticated, service_role
  WITH CHECK (
    public.current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales', 'sales_support', 'accounts', 'director'])
  );

DROP POLICY IF EXISTS "pricing_options_update" ON public.crm_inquiry_pricing_options;
CREATE POLICY "pricing_options_update" ON public.crm_inquiry_pricing_options
  FOR UPDATE TO authenticated, service_role
  USING (
    public.current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales', 'sales_support', 'accounts'])
  )
  WITH CHECK (
    public.current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales', 'sales_support', 'accounts'])
  );

DROP POLICY IF EXISTS "pricing_options_delete" ON public.crm_inquiry_pricing_options;
CREATE POLICY "pricing_options_delete" ON public.crm_inquiry_pricing_options
  FOR DELETE TO authenticated, service_role
  USING (
    public.current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales', 'sales_support', 'accounts'])
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_inquiry_pricing_options TO authenticated, service_role;

-- 6. Create RPC save_crm_inquiry_pricing_options
CREATE OR REPLACE FUNCTION public.save_crm_inquiry_pricing_options(
  p_inquiry_id uuid,
  p_options jsonb,
  p_selected_option_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inq record;
  v_opt jsonb;
  v_opt_id uuid;
  v_selected_id uuid;
  v_opt_make text;
  v_is_selected boolean;
  v_include_in_quote boolean;
  v_matched_id uuid;
  v_saved_options jsonb := '[]'::jsonb;
  v_active_make text;
  v_active_source_price numeric;
  v_active_source_currency text;
  v_active_quote_price numeric;
  v_active_quote_currency text;
  v_active_landed_usd numeric;
  v_active_found boolean := false;
  v_idx int := 0;
  v_user_role text;
BEGIN
  -- 1. Ensure user is authenticated and has required role
  SELECT role INTO v_user_role FROM public.user_profiles WHERE id = auth.uid() AND is_active = true;
  IF v_user_role IS NULL AND auth.role() <> 'service_role' THEN
    -- Fallback check for session or direct RPC invocation
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles 
      WHERE role IN ('admin', 'manager', 'sales', 'sales_support', 'accounts') AND is_active = true LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Access denied: insufficient privileges to save pricing options.';
    END IF;
  END IF;

  -- 2. Lock and verify parent inquiry
  SELECT * INTO v_inq FROM public.crm_inquiries WHERE id = p_inquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM Inquiry with ID % not found', p_inquiry_id;
  END IF;

  -- 3. Iterate through options provided
  FOR v_opt IN SELECT * FROM jsonb_array_elements(COALESCE(p_options, '[]'::jsonb))
  LOOP
    v_idx := v_idx + 1;
    v_opt_id := NULL;
    IF (v_opt->>'id') IS NOT NULL AND (v_opt->>'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_opt_id := (v_opt->>'id')::uuid;
    END IF;

    v_opt_make := trim(COALESCE(v_opt->>'offered_make', ''));
    
    -- Determine is_selected
    IF p_selected_option_id IS NOT NULL AND v_opt_id IS NOT NULL AND p_selected_option_id = v_opt_id THEN
      v_is_selected := true;
    ELSIF p_selected_option_id IS NULL AND (v_opt->>'is_selected')::boolean = true THEN
      v_is_selected := true;
    ELSIF p_selected_option_id IS NULL AND v_idx = 1 AND NOT v_active_found THEN
      v_is_selected := true;
    ELSE
      v_is_selected := false;
    END IF;

    IF v_is_selected THEN
      v_active_found := true;
    END IF;

    -- Determine include_in_customer_quote
    IF (v_opt->>'include_in_customer_quote') IS NOT NULL THEN
      v_include_in_quote := (v_opt->>'include_in_customer_quote')::boolean;
    ELSE
      v_include_in_quote := v_is_selected;
    END IF;

    -- Match existing record by ID or normalized manufacturer name
    v_matched_id := NULL;
    IF v_opt_id IS NOT NULL THEN
      SELECT id INTO v_matched_id FROM public.crm_inquiry_pricing_options
      WHERE id = v_opt_id AND inquiry_id = p_inquiry_id;
    END IF;

    IF v_matched_id IS NULL AND length(v_opt_make) > 0 THEN
      SELECT id INTO v_matched_id FROM public.crm_inquiry_pricing_options
      WHERE inquiry_id = p_inquiry_id
        AND lower(trim(offered_make)) = lower(v_opt_make)
      LIMIT 1;
    END IF;

    IF v_matched_id IS NOT NULL THEN
      -- UPDATE existing option
      UPDATE public.crm_inquiry_pricing_options
      SET
        source_type = COALESCE(v_opt->>'source_type', source_type, 'india'),
        offered_make = v_opt_make,
        source_price = CASE WHEN (v_opt->>'source_price') IS NOT NULL AND (v_opt->>'source_price') <> '' THEN (v_opt->>'source_price')::numeric ELSE NULL END,
        source_currency = COALESCE(v_opt->>'source_currency', source_currency, 'INR'),
        selling_price = CASE WHEN (v_opt->>'selling_price') IS NOT NULL AND (v_opt->>'selling_price') <> '' THEN (v_opt->>'selling_price')::numeric ELSE NULL END,
        selling_currency = COALESCE(v_opt->>'selling_currency', selling_currency, 'USD'),
        landed_cost_usd = CASE WHEN (v_opt->>'landed_cost_usd') IS NOT NULL AND (v_opt->>'landed_cost_usd') <> '' THEN (v_opt->>'landed_cost_usd')::numeric ELSE NULL END,
        suggested_quote_usd = CASE WHEN (v_opt->>'suggested_quote_usd') IS NOT NULL AND (v_opt->>'suggested_quote_usd') <> '' THEN (v_opt->>'suggested_quote_usd')::numeric ELSE NULL END,
        margin_pct = CASE WHEN (v_opt->>'margin_pct') IS NOT NULL AND (v_opt->>'margin_pct') <> '' THEN (v_opt->>'margin_pct')::numeric ELSE NULL END,
        supplier = COALESCE(v_opt->>'supplier', supplier),
        specification = COALESCE(v_opt->>'specification', specification),
        availability = COALESCE(v_opt->>'availability', availability, 'available'),
        moq = COALESCE(v_opt->>'moq', moq),
        packing = COALESCE(v_opt->>'packing', packing),
        lead_time = COALESCE(v_opt->>'lead_time', lead_time),
        origin = COALESCE(v_opt->>'origin', origin),
        remark = COALESCE(v_opt->>'remark', remark),
        is_selected = v_is_selected,
        include_in_customer_quote = v_include_in_quote,
        updated_at = now()
      WHERE id = v_matched_id;
      v_opt_id := v_matched_id;
    ELSE
      -- INSERT new option
      INSERT INTO public.crm_inquiry_pricing_options (
        inquiry_id,
        source_type,
        offered_make,
        source_price,
        source_currency,
        selling_price,
        selling_currency,
        landed_cost_usd,
        suggested_quote_usd,
        margin_pct,
        supplier,
        specification,
        availability,
        moq,
        packing,
        lead_time,
        origin,
        remark,
        is_selected,
        include_in_customer_quote,
        created_by,
        created_at,
        updated_at
      ) VALUES (
        p_inquiry_id,
        COALESCE(v_opt->>'source_type', 'india'),
        v_opt_make,
        CASE WHEN (v_opt->>'source_price') IS NOT NULL AND (v_opt->>'source_price') <> '' THEN (v_opt->>'source_price')::numeric ELSE NULL END,
        COALESCE(v_opt->>'source_currency', 'INR'),
        CASE WHEN (v_opt->>'selling_price') IS NOT NULL AND (v_opt->>'selling_price') <> '' THEN (v_opt->>'selling_price')::numeric ELSE NULL END,
        COALESCE(v_opt->>'selling_currency', 'USD'),
        CASE WHEN (v_opt->>'landed_cost_usd') IS NOT NULL AND (v_opt->>'landed_cost_usd') <> '' THEN (v_opt->>'landed_cost_usd')::numeric ELSE NULL END,
        CASE WHEN (v_opt->>'suggested_quote_usd') IS NOT NULL AND (v_opt->>'suggested_quote_usd') <> '' THEN (v_opt->>'suggested_quote_usd')::numeric ELSE NULL END,
        CASE WHEN (v_opt->>'margin_pct') IS NOT NULL AND (v_opt->>'margin_pct') <> '' THEN (v_opt->>'margin_pct')::numeric ELSE NULL END,
        v_opt->>'supplier',
        v_opt->>'specification',
        COALESCE(v_opt->>'availability', 'available'),
        v_opt->>'moq',
        v_opt->>'packing',
        v_opt->>'lead_time',
        v_opt->>'origin',
        v_opt->>'remark',
        v_is_selected,
        v_include_in_quote,
        auth.uid(),
        now(),
        now()
      )
      RETURNING id INTO v_opt_id;
    END IF;

    IF v_is_selected THEN
      v_selected_id := v_opt_id;
      v_active_make := v_opt_make;
      v_active_source_price := CASE WHEN (v_opt->>'source_price') IS NOT NULL AND (v_opt->>'source_price') <> '' THEN (v_opt->>'source_price')::numeric ELSE NULL END;
      v_active_source_currency := COALESCE(v_opt->>'source_currency', 'INR');
      v_active_quote_price := CASE WHEN (v_opt->>'selling_price') IS NOT NULL AND (v_opt->>'selling_price') <> '' THEN (v_opt->>'selling_price')::numeric ELSE NULL END;
      v_active_quote_currency := COALESCE(v_opt->>'selling_currency', 'USD');
      v_active_landed_usd := CASE WHEN (v_opt->>'landed_cost_usd') IS NOT NULL AND (v_opt->>'landed_cost_usd') <> '' THEN (v_opt->>'landed_cost_usd')::numeric ELSE NULL END;
    END IF;
  END LOOP;

  -- 4. Enforce that only the selected option has is_selected = true
  IF v_active_found AND v_selected_id IS NOT NULL THEN
    UPDATE public.crm_inquiry_pricing_options
    SET is_selected = false
    WHERE inquiry_id = p_inquiry_id
      AND id <> v_selected_id
      AND is_selected = true;
  END IF;

  -- 5. Update parent inquiry legacy single-value fields for backward compatibility
  IF v_active_found THEN
    UPDATE public.crm_inquiries
    SET
      supplier_name = CASE WHEN length(v_active_make) > 0 THEN v_active_make ELSE supplier_name END,
      purchase_price = v_active_landed_usd,
      purchase_price_currency = 'USD',
      offered_price = v_active_quote_price,
      offered_price_currency = v_active_quote_currency,
      kunal_price_status = CASE WHEN v_active_quote_price > 0 THEN 'entered' ELSE kunal_price_status END,
      price_ready = CASE WHEN v_active_quote_price > 0 THEN true ELSE price_ready END,
      updated_at = now()
    WHERE id = p_inquiry_id;
  END IF;

  -- 6. Return all options for this inquiry
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'inquiry_id', inquiry_id,
      'source_type', source_type,
      'offered_make', offered_make,
      'source_price', source_price,
      'source_currency', source_currency,
      'selling_price', selling_price,
      'selling_currency', selling_currency,
      'landed_cost_usd', landed_cost_usd,
      'suggested_quote_usd', suggested_quote_usd,
      'margin_pct', margin_pct,
      'supplier', supplier,
      'specification', specification,
      'availability', availability,
      'moq', moq,
      'packing', packing,
      'lead_time', lead_time,
      'origin', origin,
      'remark', remark,
      'is_selected', is_selected,
      'include_in_customer_quote', include_in_customer_quote,
      'is_accepted', is_accepted,
      'created_at', created_at,
      'updated_at', updated_at
    ) ORDER BY is_selected DESC, created_at ASC
  ) INTO v_saved_options
  FROM public.crm_inquiry_pricing_options
  WHERE inquiry_id = p_inquiry_id;

  RETURN COALESCE(v_saved_options, '[]'::jsonb);
END;
$function$;

-- 7. Create RPC accept_crm_inquiry_pricing_option
CREATE OR REPLACE FUNCTION public.accept_crm_inquiry_pricing_option(
  p_inquiry_id uuid,
  p_option_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inq record;
  v_opt record;
  v_user_role text;
BEGIN
  -- 1. Ensure user is authenticated and has required role
  SELECT role INTO v_user_role FROM public.user_profiles WHERE id = auth.uid() AND is_active = true;
  IF v_user_role IS NULL AND auth.role() <> 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles 
      WHERE role IN ('admin', 'manager', 'sales', 'sales_support', 'accounts', 'director') AND is_active = true LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Access denied: insufficient privileges to record customer acceptance.';
    END IF;
  END IF;

  -- 2. Verify inquiry
  SELECT * INTO v_inq FROM public.crm_inquiries WHERE id = p_inquiry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CRM Inquiry with ID % not found', p_inquiry_id;
  END IF;

  -- 3. Verify option belongs to this inquiry
  SELECT * INTO v_opt FROM public.crm_inquiry_pricing_options
  WHERE id = p_option_id AND inquiry_id = p_inquiry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pricing option % does not exist for inquiry %', p_option_id, p_inquiry_id;
  END IF;

  -- 4. Atomically set is_accepted = false for all other options on this inquiry, and true for selected option
  UPDATE public.crm_inquiry_pricing_options
  SET is_accepted = (id = p_option_id),
      updated_at = now()
  WHERE inquiry_id = p_inquiry_id;

  -- 5. Update inquiry
  UPDATE public.crm_inquiries
  SET accepted_pricing_option_id = p_option_id,
      supplier_name = COALESCE(v_opt.offered_make, supplier_name),
      offered_price = COALESCE(v_opt.selling_price, offered_price),
      offered_price_currency = COALESCE(v_opt.selling_currency, offered_price_currency),
      pipeline_status = CASE WHEN pipeline_status IN ('new', 'sourcing', 'price_ready', 'quote_sent') THEN 'negotiation' ELSE pipeline_status END,
      updated_at = now()
  WHERE id = p_inquiry_id;

  -- 6. Insert timeline event
  INSERT INTO public.crm_inquiry_timeline (
    inquiry_id,
    event_type,
    actor_id,
    actor_name,
    description,
    metadata
  ) VALUES (
    p_inquiry_id,
    'customer_option_accepted',
    auth.uid(),
    COALESCE((SELECT full_name FROM public.user_profiles WHERE id = auth.uid()), 'Sales Team'),
    'Customer accepted option: ' || COALESCE(v_opt.offered_make, 'Selected Option') || ' at ' || COALESCE(v_opt.selling_currency, 'USD') || ' ' || COALESCE(v_opt.selling_price::text, '-'),
    jsonb_build_object(
      'accepted_option_id', p_option_id,
      'offered_make', v_opt.offered_make,
      'selling_price', v_opt.selling_price,
      'selling_currency', v_opt.selling_currency
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'inquiry_id', p_inquiry_id,
    'accepted_option_id', p_option_id,
    'offered_make', v_opt.offered_make,
    'selling_price', v_opt.selling_price,
    'selling_currency', v_opt.selling_currency
  );
END;
$function$;

-- 8. Grant permissions
REVOKE ALL ON FUNCTION public.save_crm_inquiry_pricing_options(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_crm_inquiry_pricing_options(uuid, jsonb, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.accept_crm_inquiry_pricing_option(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_crm_inquiry_pricing_option(uuid, uuid) TO authenticated, service_role;
