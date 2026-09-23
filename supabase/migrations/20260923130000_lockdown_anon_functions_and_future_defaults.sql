-- ==============================================================================
-- Migration: Prevent Anon/Public Execution on Security Definer Functions
-- ==============================================================================
-- 1. Ensure future functions created in schema public do NOT grant EXECUTE to PUBLIC/anon
-- 2. Revoke PUBLIC and anon EXECUTE on recently recreated functions and trigger helpers
-- 3. Retain authenticated/service_role execute privileges
-- ==============================================================================

-- 1. Tighten default function privileges for schema public
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon;

-- 2. Revoke execute from PUBLIC and anon on sensitive mutators and helpers
DO $$
BEGIN
  -- Mutators
  REVOKE ALL ON FUNCTION public.save_payment_voucher_command(uuid, jsonb, jsonb, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.save_payment_voucher_command(uuid, jsonb, jsonb, text) TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb, uuid, text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb, uuid, text) TO authenticated, service_role;

  -- Return COGS helper
  REVOKE ALL ON FUNCTION public.get_credit_note_item_fifo_cogs(uuid) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.get_credit_note_item_fifo_cogs(uuid) TO authenticated, service_role;

  -- Trigger helpers
  REVOKE ALL ON FUNCTION public.enforce_inventory_transaction_operation_id() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.enforce_inventory_transaction_operation_id() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.prevent_cash_on_hand_fund_transfer() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.prevent_cash_on_hand_fund_transfer() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.prevent_expense_payment_overallocation() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.prevent_expense_payment_overallocation() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.prevent_gl1101_posting() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.prevent_gl1101_posting() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.sync_credit_note_material_return() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.sync_credit_note_material_return() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.sync_si_state_on_rv_posting_change() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.sync_si_state_on_rv_posting_change() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.trg_salary_advance_application_recalc() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.trg_salary_advance_application_recalc() TO authenticated, service_role;

  REVOKE ALL ON FUNCTION public.validate_material_return_item() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.validate_material_return_item() TO authenticated, service_role;
END $$;
