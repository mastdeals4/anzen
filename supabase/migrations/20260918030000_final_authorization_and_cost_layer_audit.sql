-- ============================================================================
-- FINAL AUTHORIZATION, ROLE HARDENING & COST LAYER POLICY AUDIT
-- Migration: 20260918030000_final_authorization_and_cost_layer_audit.sql
-- ============================================================================

-- 1. purchase_batch_cost_layers Final RLS Policy
-- Strictly restricted to finance/auditing roles: admin, accounts, auditor_ca.
-- Disallows unauthorized visibility by sales or warehouse roles.
ALTER TABLE public.purchase_batch_cost_layers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "purchase_batch_cost_layers_select" ON public.purchase_batch_cost_layers;
DROP POLICY IF EXISTS purchase_batch_cost_layers_select ON public.purchase_batch_cost_layers;

CREATE POLICY "purchase_batch_cost_layers_select" ON public.purchase_batch_cost_layers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.is_active = true
        AND up.role = ANY (ARRAY['admin'::text, 'accounts'::text, 'auditor_ca'::text])
    )
  );

-- 2. inventory_v1_actor_allowed
-- Hardened: Checks is_active = true and uses fixed search_path = public, pg_temp.
CREATE OR REPLACE FUNCTION public.inventory_v1_actor_allowed(p_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.is_active = true
        AND up.role = ANY(p_roles)
    );
$$;

-- 3. Ensure all targeted views maintain security_invoker = true
ALTER VIEW public.customer_receivables_view SET (security_invoker = true);
ALTER VIEW public.finance_live_verification_failures SET (security_invoker = true);
ALTER VIEW public.inventory_v1_stock_summary SET (security_invoker = true);
ALTER VIEW public.sales_invoice_item_integrity SET (security_invoker = true);
ALTER VIEW public.so_product_reservation_status SET (security_invoker = true);
ALTER VIEW public.supplier_payables_view SET (security_invoker = true);
ALTER VIEW public.vw_bank_ledger_effective SET (security_invoker = true);
ALTER VIEW public.vw_bank_ledger_monthly_reconciliation SET (security_invoker = true);
