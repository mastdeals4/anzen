-- Convert 4 SECURITY DEFINER views to SECURITY INVOKER (security_invoker = true)
-- to resolve Supabase Security Advisor findings without altering schema or business logic.

BEGIN;

ALTER VIEW public.vw_petty_cash_balance SET (security_invoker = true);
ALTER VIEW public.vw_petty_cash_statement SET (security_invoker = true);
ALTER VIEW public.inventory_gl_valuation_reconciliation SET (security_invoker = true);
ALTER VIEW public.ai_inventory_current SET (security_invoker = true);

-- Ensure explicit permissions: deny public/anon, grant SELECT to authenticated and service_role
REVOKE ALL ON public.vw_petty_cash_balance FROM anon, public;
REVOKE ALL ON public.vw_petty_cash_statement FROM anon, public;
REVOKE ALL ON public.inventory_gl_valuation_reconciliation FROM anon, public;
REVOKE ALL ON public.ai_inventory_current FROM anon, public;

GRANT SELECT ON public.vw_petty_cash_balance TO authenticated, service_role;
GRANT SELECT ON public.vw_petty_cash_statement TO authenticated, service_role;
GRANT SELECT ON public.inventory_gl_valuation_reconciliation TO authenticated, service_role;
GRANT SELECT ON public.ai_inventory_current TO authenticated, service_role;

COMMIT;
