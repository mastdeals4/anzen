-- Trigger entrypoints are internal implementation details.  PostgreSQL grants
-- EXECUTE to PUBLIC by default, so explicitly remove that privilege.
REVOKE ALL ON FUNCTION public.trg_recompute_from_expense() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_recompute_from_payment_voucher() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_recompute_pph_from_voucher_allocation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trg_recompute_pph_from_bank_line() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
