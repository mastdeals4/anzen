BEGIN;
REVOKE ALL ON FUNCTION public.trg_recompute_tax_from_journal() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_recompute_tax_from_journal() TO service_role;
COMMIT;
