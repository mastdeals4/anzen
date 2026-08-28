-- The renamed implementation is an internal helper used only by the secured
-- public.compute_period_ppn wrapper. It must never be callable by anon.
BEGIN;
REVOKE ALL ON FUNCTION public.compute_period_ppn_pre_posted_register(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_period_ppn_pre_posted_register(uuid) TO service_role;
COMMIT;
