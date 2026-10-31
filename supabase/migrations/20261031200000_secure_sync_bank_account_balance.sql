-- ==============================================================================
-- Migration: 20261031200000_secure_sync_bank_account_balance.sql
-- Description:
--   1. Secure public.sync_bank_account_balance:
--      - Revoke unrestricted execution from PUBLIC and anon.
--      - Grant execution only to authenticated and service_role.
--      - Enforce finance role check (_sec_check_finance_role) when invoked by authenticated users.
--   2. Reconcile supabase_migrations.schema_migrations table for 20261031140000 and 20261031200000.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.sync_bank_account_balance(p_bank_account_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- If invoked in an authenticated API session, enforce finance role authorization
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  UPDATE public.bank_accounts ba
  SET current_balance = COALESCE(ba.opening_balance, 0) + COALESCE((
    SELECT SUM(
      CASE 
        WHEN upper(ba.currency) = 'USD' THEN COALESCE(jel.transaction_debit, jel.debit) - COALESCE(jel.transaction_credit, jel.credit)
        ELSE jel.debit - jel.credit
      END
    )
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = ba.coa_id
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
  ), 0)
  WHERE (p_bank_account_id IS NULL OR ba.id = p_bank_account_id);
END;
$$;

-- Revoke unrestricted execution
REVOKE ALL ON FUNCTION public.sync_bank_account_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_bank_account_balance(uuid) FROM anon;

-- Grant execution to authorized roles
GRANT EXECUTE ON FUNCTION public.sync_bank_account_balance(uuid) TO authenticated, service_role;

-- Reconcile schema migrations tracking if table exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  ) THEN
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    VALUES 
      ('20261031140000', 'fix_receipt_voucher_posting_and_bank_account_gl_validation'),
      ('20261031200000', 'secure_sync_bank_account_balance')
    ON CONFLICT (version) DO NOTHING;
  END IF;
END;
$$;
