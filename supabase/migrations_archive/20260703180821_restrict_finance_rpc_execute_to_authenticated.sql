-- Security fix: these SECURITY DEFINER finance functions were EXECUTE-able by
-- the anon role (directly or via a PUBLIC grant), meaning an unauthenticated
-- caller holding the public key could invoke financial mutations/reads.
-- Restrict to authenticated users (frontend) and service_role (edge functions).
-- Trigger functions still fire normally; EXECUTE grants do not affect triggers.

REVOKE EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.diagnose_bank_line_link(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_asset_register() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_outstanding_expense_bills(date) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.recalculate_expense_payment_state(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reverse_fund_transfer(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.save_payment_voucher(date, uuid, text, uuid, text, numeric, numeric, uuid, text, uuid, jsonb) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.save_purchase_invoice(uuid, jsonb, jsonb) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.validate_broker_items(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_sync_import_requirements_on_so_edit() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_expense_payment_state_from_allocations() FROM anon, PUBLIC;
