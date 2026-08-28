-- Security fix: reporting views were readable by the anon role (public key),
-- exposing inventory + tax/financial figures without login.
-- These views are intentionally SECURITY DEFINER so that read-only auditor
-- users (blocked from the base tables by is_read_only_user() RLS guards) can
-- still see cross-cutting reports. Converting to security_invoker would strip
-- auditors of report access, so instead we remove all anonymous access and
-- keep the views authenticated-only.

REVOKE SELECT ON public.product_stock_summary FROM anon, PUBLIC;
REVOKE SELECT ON public.vw_import_requirements_by_product FROM anon, PUBLIC;
REVOKE SELECT ON public.vw_pph22_advance_tax_report FROM anon, PUBLIC;
REVOKE SELECT ON public.vw_input_ppn_report FROM anon, PUBLIC;
REVOKE SELECT ON public.vw_monthly_tax_summary FROM anon, PUBLIC;
