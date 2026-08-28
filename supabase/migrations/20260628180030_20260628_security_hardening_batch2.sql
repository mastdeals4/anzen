-- ============================================================
-- Security Hardening Batch 2 – 2026-06-28
-- ============================================================

-- 1. Enable RLS on backup table and add deny-all policy
ALTER TABLE public.crm_contacts_bounce_backup_20260622 ENABLE ROW LEVEL SECURITY;

CREATE POLICY "no_direct_access_bounce_backup"
  ON public.crm_contacts_bounce_backup_20260622
  FOR ALL TO anon, authenticated
  USING (false);

-- 2. Explicit deny-all on import_data_type_backup_20260604
--    (RLS already enabled, but zero policies → add explicit one for linter)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'import_data_type_backup_20260604'
      AND policyname = 'no_direct_access_import_backup'
  ) THEN
    EXECUTE $pol$
      CREATE POLICY "no_direct_access_import_backup"
        ON public.import_data_type_backup_20260604
        FOR ALL TO anon, authenticated
        USING (false)
    $pol$;
  END IF;
END $$;

-- 3. Fix mutable search_path on prevent_header_account_posting
ALTER FUNCTION public.prevent_header_account_posting()
  SET search_path = public;

-- ============================================================
-- 4. Revoke EXECUTE from anon on all SECURITY DEFINER functions
-- ============================================================

REVOKE EXECUTE ON FUNCTION public.cancel_expense_posting(uuid, uuid, text)           FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_gl_posting(uuid, uuid, text, uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_payment_voucher_posting(uuid, uuid, text)   FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_petty_cash_posting(uuid, uuid, text)        FROM anon;
REVOKE EXECUTE ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text)   FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_payment_voucher_with_allocations(uuid)      FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_reporting_usd_rate()                           FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_expense_to_journal()                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid)                   FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid)                   FROM anon;
REVOKE EXECUTE ON FUNCTION public.post_sales_invoice_cogs()                          FROM anon;
REVOKE EXECUTE ON FUNCTION public.save_payment_voucher_with_allocations(uuid, text, date, uuid, text, uuid, text, numeric, numeric, uuid, text, text, numeric, numeric, numeric, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date)                            FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric)                   FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date)                      FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric)             FROM anon;

-- ============================================================
-- 5. Revoke EXECUTE from authenticated on trigger/internal-only
--    SECURITY DEFINER functions that must not be called via RPC
-- ============================================================

-- post_expense_to_journal is a trigger function (no args); revoke direct RPC access
REVOKE EXECUTE ON FUNCTION public.post_expense_to_journal()      FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.post_sales_invoice_cogs()      FROM authenticated;

-- ============================================================
-- 6. Revoke EXECUTE from anon on pg_net HTTP functions
--    (pg_net lives in the net schema; block anon from calling it)
-- ============================================================
DO $$
BEGIN
  -- http_get
  BEGIN
    REVOKE EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer) FROM anon;
  EXCEPTION WHEN undefined_function OR undefined_object THEN NULL;
  END;
  -- http_post
  BEGIN
    REVOKE EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) FROM anon;
  EXCEPTION WHEN undefined_function OR undefined_object THEN NULL;
  END;
END $$;
