-- ============================================================================
-- Migration: Full Supabase Security Hardening (Zero ERP Regression)
-- ============================================================================
-- 1. Sets security_invoker = true on all 8 SECURITY DEFINER views.
-- 2. Fixes mutable search_path on all 11 flagged functions.
-- 3. Enables RLS and applies least-privilege policies to 6 public tables.
-- 4. Relocates pg_net extension to the canonical extensions schema.
-- 5. Revokes execute privileges from 'anon' across all internal and privileged
--    SECURITY DEFINER functions, preserving genuine pre-login functions.
-- 6. Revokes direct PostgREST execution on internal trigger-only functions.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. SECURITY DEFINER Views -> SECURITY INVOKER
-- ----------------------------------------------------------------------------
ALTER VIEW public.customer_receivables_view SET (security_invoker = true);
ALTER VIEW public.finance_live_verification_failures SET (security_invoker = true);
ALTER VIEW public.inventory_v1_stock_summary SET (security_invoker = true);
ALTER VIEW public.sales_invoice_item_integrity SET (security_invoker = true);
ALTER VIEW public.so_product_reservation_status SET (security_invoker = true);
ALTER VIEW public.supplier_payables_view SET (security_invoker = true);
ALTER VIEW public.vw_bank_ledger_effective SET (security_invoker = true);
ALTER VIEW public.vw_bank_ledger_monthly_reconciliation SET (security_invoker = true);

-- ----------------------------------------------------------------------------
-- 2. Mutable Function search_path Hardening (11 Functions)
-- ----------------------------------------------------------------------------
ALTER FUNCTION public.calculate_batch_authoritative_cost(public.batches) SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_crm_email_activities_dedup() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_protect_enquiry_message_content() SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_tax_period_payment_status(text, numeric, numeric, date) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_batch_authoritative_unit_cost(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.is_capitalizable_landed_cost_category(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.normalize_customer_identity(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.normalize_customer_tax_id(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_receiving_approval_on_invoice_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_receiving_approval_on_item_change() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_sales_invoice_balance_cache() SET search_path = public, pg_temp;

-- ----------------------------------------------------------------------------
-- 3. Public Tables Without RLS -> Enable RLS & Add Policies
-- ----------------------------------------------------------------------------
-- 3.1 audit_removed_duplicate_sale_inventory_transactions
ALTER TABLE public.audit_removed_duplicate_sale_inventory_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_removed_dup_sale_inv_select" ON public.audit_removed_duplicate_sale_inventory_transactions;
CREATE POLICY "audit_removed_dup_sale_inv_select" ON public.audit_removed_duplicate_sale_inventory_transactions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = ANY(ARRAY['admin'::text, 'accounts'::text, 'auditor_ca'::text])
    )
  );

-- 3.2 purchase_batch_cost_layers
ALTER TABLE public.purchase_batch_cost_layers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_batch_cost_layers_select" ON public.purchase_batch_cost_layers;
CREATE POLICY "purchase_batch_cost_layers_select" ON public.purchase_batch_cost_layers
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = ANY(ARRAY['admin'::text, 'accounts'::text, 'manager'::text])
    )
  );

-- 3.3 temp_exec_result
ALTER TABLE public.temp_exec_result ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "temp_exec_result_admin_all" ON public.temp_exec_result;
CREATE POLICY "temp_exec_result_admin_all" ON public.temp_exec_result
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = 'admin'::text
    )
  );

-- 3.4 temp_exec_trace
ALTER TABLE public.temp_exec_trace ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "temp_exec_trace_admin_all" ON public.temp_exec_trace;
CREATE POLICY "temp_exec_trace_admin_all" ON public.temp_exec_trace
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = 'admin'::text
    )
  );

-- 3.5 temp_profile_steps
ALTER TABLE public.temp_profile_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "temp_profile_steps_admin_all" ON public.temp_profile_steps;
CREATE POLICY "temp_profile_steps_admin_all" ON public.temp_profile_steps
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = 'admin'::text
    )
  );

-- 3.6 temp_profile_timings
ALTER TABLE public.temp_profile_timings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "temp_profile_timings_admin_all" ON public.temp_profile_timings;
CREATE POLICY "temp_profile_timings_admin_all" ON public.temp_profile_timings
  FOR ALL TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.is_active = true AND up.role = 'admin'::text
    )
  );

-- ----------------------------------------------------------------------------
-- 4. Relocate pg_net Extension to extensions Schema
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_net' AND n.nspname = 'public'
  ) THEN
    ALTER EXTENSION pg_net SET SCHEMA extensions;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_net schema alteration skipped: %', SQLERRM;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Revoke anon Execution Across All Privileged SECURITY DEFINER Functions
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname NOT IN ('lookup_login_email', 'is_setup_mode')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon', r.proname, r.args);
  END LOOP;
END $$;

-- Explicitly ensure pre-login functions remain available for initial login
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_setup_mode() TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. Revoke Direct PostgREST Execution on Internal Trigger / Guard Functions
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.prorettype = 'trigger'::regtype
        OR p.proname LIKE 'trg_%'
        OR p.proname LIKE 'guard_%'
        OR p.proname LIKE 'validate_%'
        OR p.proname LIKE 'auto_%'
        OR p.proname LIKE 'prevent_%'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated', r.proname, r.args);
  END LOOP;
END $$;

COMMIT;
