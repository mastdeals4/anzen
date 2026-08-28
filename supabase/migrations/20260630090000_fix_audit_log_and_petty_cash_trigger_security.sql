-- ============================================================================
-- Migration: 20260630090000_fix_audit_log_and_petty_cash_trigger_security
-- Date:      2026-06-30
--
-- BUG 1 FIX: "permission denied for table users" on Petty Cash save
--
-- Root cause:
--   The security hardening batch2 migration (20260628180030, applied remotely)
--   converted several trigger functions from SECURITY DEFINER to SECURITY
--   INVOKER. This broke two functions:
--
--   1. log_audit_event()
--      - Is SECURITY INVOKER (runs as the calling user)
--      - Contains: SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id
--      - The `authenticated` role has NO SELECT permission on auth.users
--      - Trigger audit_petty_cash_transactions fires on every INSERT to
--        petty_cash_transactions (which the client does directly via PostgREST)
--      - Result: "permission denied for table users" on every Petty Cash save
--
--   2. post_petty_cash_to_journal_fixed()
--      - Is SECURITY INVOKER (was SECURITY DEFINER in migration 20260626130000)
--      - Trigger trigger_post_petty_cash_on_approval fires on UPDATE
--        (when approval_status changes to 'approved')
--      - As INVOKER it runs as authenticated user; may not have unrestricted
--        INSERT access to journal_entries / journal_entry_lines
--
-- Fix:
--   Restore both functions to SECURITY DEFINER so they run as their definer
--   (postgres), which has the necessary permissions.
--   This does NOT bypass RLS on business data — log_audit_event only writes
--   to audit_logs and reads auth.users; post_petty_cash_to_journal_fixed
--   was always designed as SECURITY DEFINER (see migration 20260626130000).
--
-- Idempotency: CREATE OR REPLACE is safe to re-run.
-- ============================================================================

-- ── FIX 1: log_audit_event() → SECURITY DEFINER ──────────────────────────────
-- Restores access to auth.users so email can be captured in audit logs.
-- The function writes to audit_logs (internal audit table) and reads auth.users
-- to capture the acting user's email — both are legitimate definer-level ops.

CREATE OR REPLACE FUNCTION public.log_audit_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      uuid;
  v_user_email   text;
  v_old_data     jsonb;
  v_new_data     jsonb;
  v_changed_fields text[];
  v_key          text;
BEGIN
  -- Get current user info (runs as definer/postgres — can access auth.users)
  v_user_id := auth.uid();
  IF v_user_id IS NOT NULL THEN
    SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  END IF;

  -- Capture old and new values based on operation
  IF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_old_data := NULL;
    v_new_data := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);
    v_changed_fields := ARRAY[]::text[];

    FOR v_key IN SELECT jsonb_object_keys(v_new_data) LOOP
      IF v_old_data->v_key IS DISTINCT FROM v_new_data->v_key THEN
        v_changed_fields := array_append(v_changed_fields, v_key);
      END IF;
    END LOOP;

    -- Skip audit if only updated_at changed
    IF v_changed_fields = ARRAY['updated_at']::text[] THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_logs (
    table_name, record_id, action_type,
    old_values, new_values, changed_fields,
    user_id, user_email, created_at
  ) VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    LOWER(TG_OP),
    v_old_data, v_new_data, v_changed_fields,
    v_user_id, v_user_email, now()
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- ── FIX 2: post_petty_cash_to_journal_fixed() → SECURITY DEFINER ─────────────
-- Restores original design from migration 20260626130000.
-- As INVOKER it ran as authenticated user who may lack unrestricted INSERT
-- on journal_entries / journal_entry_lines. As DEFINER it runs as postgres.

CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_journal_id         UUID;
  v_petty_cash_account UUID;
  v_bank_coa           UUID;
  v_expense_account    UUID;
  v_line_num           INT  := 0;
  v_je_number          TEXT;
BEGIN
  IF NEW.fund_transfer_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT id INTO v_petty_cash_account FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  IF v_petty_cash_account IS NULL THEN
    RAISE EXCEPTION 'Petty cash account 1102 not found';
  END IF;

  -- Advisory lock eliminates race condition in JE number generation
  PERFORM pg_advisory_xact_lock(
    hashtext('pc_je_number_' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD'))
  );

  SELECT 'JE-' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_je_number
    FROM journal_entries WHERE entry_date = NEW.transaction_date;

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by, posted_at
  ) VALUES (
    v_je_number, NEW.transaction_date, 'petty_cash', NEW.id, NEW.transaction_number,
    'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
    NEW.amount, NEW.amount, TRUE, NEW.created_by, NOW()
  ) RETURNING id INTO v_journal_id;

  IF NEW.transaction_type = 'withdraw' THEN
    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, NEW.amount, 0, 'Cash withdrawal');

    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_bank_coa FROM bank_accounts WHERE id = NEW.bank_account_id;
      IF v_bank_coa IS NOT NULL THEN
        v_line_num := v_line_num + 1;
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_bank_coa, 0, NEW.amount, 'Bank withdrawal for petty cash');
      END IF;
    END IF;

  ELSIF NEW.transaction_type = 'expense' THEN
    SELECT id INTO v_expense_account FROM chart_of_accounts
     WHERE account_type = 'expense' AND (
       CASE
         WHEN NEW.expense_category = 'Utilities'                    THEN code = '6300'
         WHEN NEW.expense_category = 'Office Supplies'              THEN code = '6310'
         WHEN NEW.expense_category = 'Transportation'               THEN code = '6320'
         WHEN NEW.expense_category = 'Meals & Entertainment'        THEN code = '6330'
         WHEN NEW.expense_category = 'Postage & Courier'            THEN code = '6340'
         WHEN NEW.expense_category = 'Cleaning & Maintenance'       THEN code = '6350'
         WHEN NEW.expense_category = 'Staff Salaries & Wages'       THEN code = '6360'
         WHEN NEW.expense_category = 'Staff Benefits & Allowances'  THEN code = '6370'
         WHEN NEW.expense_category = 'Printing & Stationery'        THEN code = '6380'
         WHEN NEW.expense_category = 'Telephone & Internet'         THEN code = '6390'
         WHEN NEW.expense_category = 'Bank Charges'                 THEN code = '6400'
         WHEN NEW.expense_category = 'Professional Fees'            THEN code = '6410'
         WHEN NEW.expense_category = 'Office Renovation & Shifting' THEN code = '6420'
         WHEN NEW.expense_category = 'Other Expenses'               THEN code = '6490'
         ELSE code = '5102'
       END
     ) LIMIT 1;

    IF v_expense_account IS NULL THEN
      SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code = '5102' LIMIT 1;
    END IF;

    IF v_expense_account IS NULL THEN
      RAISE EXCEPTION 'No expense account found (category: %)', NEW.expense_category;
    END IF;

    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_expense_account, NEW.amount, 0,
            COALESCE(NEW.expense_category, 'General expense'));

    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, 0, NEW.amount, 'Cash expense');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'post_petty_cash_to_journal_fixed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Bug fix 20260630090000 applied:';
  RAISE NOTICE '  log_audit_event()              → SECURITY DEFINER';
  RAISE NOTICE '  post_petty_cash_to_journal_fixed() → SECURITY DEFINER';
  RAISE NOTICE 'Petty Cash save now works correctly.';
  RAISE NOTICE '============================================================';
END $$;
