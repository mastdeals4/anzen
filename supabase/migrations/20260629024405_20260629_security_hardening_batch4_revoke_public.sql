-- ============================================================
-- Security Hardening Batch 4 – Revoke PUBLIC execute on all
-- SECURITY DEFINER functions that anon should not call.
-- Supabase grants EXECUTE to PUBLIC by default on every
-- CREATE FUNCTION; the fix is REVOKE FROM PUBLIC, then
-- GRANT only to authenticated/service_role.
-- ============================================================

DO $$
DECLARE
  fn_sigs text[] := ARRAY[
    'public.cancel_expense_posting(uuid, uuid, text)',
    'public.cancel_gl_posting(uuid, uuid, text, uuid, text, jsonb)',
    'public.cancel_payment_voucher_posting(uuid, uuid, text)',
    'public.cancel_petty_cash_posting(uuid, uuid, text)',
    'public.cancel_receipt_voucher_posting(uuid, uuid, text)',
    'public.delete_payment_voucher_with_allocations(uuid)',
    'public.get_reporting_usd_rate()',
    'public.get_balance_sheet(date)',
    'public.get_balance_sheet(date, numeric)',
    'public.get_trial_balance(date, date)',
    'public.get_trial_balance(date, date, numeric)',
    'public.post_expense_to_journal()',
    'public.post_payment_voucher(uuid, uuid)',
    'public.post_receipt_voucher(uuid, uuid)',
    'public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb)'
  ];
  sig text;
BEGIN
  FOREACH sig IN ARRAY fn_sigs LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', sig);
    EXCEPTION WHEN undefined_function OR undefined_object THEN
      NULL;
    END;
    -- Re-grant only to authenticated and service_role
    BEGIN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', sig);
    EXCEPTION WHEN undefined_function OR undefined_object THEN
      NULL;
    END;
  END LOOP;
END $$;
