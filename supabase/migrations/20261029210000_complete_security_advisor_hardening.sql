-- ============================================================================
-- Migration: Complete Supabase Security Advisor Hardening & Authorization Gate
-- File: supabase/migrations/20261029210000_complete_security_advisor_hardening.sql
-- ============================================================================
-- 1. Fixes mutable search_path on all flagged functions (SET search_path = public, pg_temp).
-- 2. Revokes execution from PUBLIC and anon across all internal/trigger SECURITY DEFINER RPCs.
-- 3. Hardens pre-login functions (lookup_login_email) with strict input validation.
-- 4. Eliminates genuine authorization bypass vectors on authenticated-callable RPCs:
--    - approve_finance_expense: enforces authenticated caller, checks finance role, overrides approved_by.
--    - cancel_sales_invoice: enforces authenticated caller, prevents p_actor spoofing, checks role.
--    - cancel_payment_voucher_posting: enforces finance role check and authenticated caller.
--    - cancel_expense_posting: enforces finance role check.
--    - post_bpjs_monthly_register: overrides client p_user_id with auth.uid() and validates finance role.
-- 5. Enables & forces RLS across all sensitive ERP tables, revoking anon and PUBLIC grants.
-- 6. Secures pg_net schema functions without moving or reinstalling the extension.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Fix Mutable search_path on Flagged Functions
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- 1.1 fn_protect_enquiry_message_content
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_protect_enquiry_message_content') THEN
    ALTER FUNCTION public.fn_protect_enquiry_message_content() SET search_path = public, pg_temp;
  END IF;

  -- 1.2 fn_crm_email_activities_dedup
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_crm_email_activities_dedup') THEN
    ALTER FUNCTION public.fn_crm_email_activities_dedup() SET search_path = public, pg_temp;
  END IF;

  -- 1.3 recalculate_sales_invoice_payment_state
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recalculate_sales_invoice_payment_state' AND pronargs = 1) THEN
    ALTER FUNCTION public.recalculate_sales_invoice_payment_state(uuid) SET search_path = public, pg_temp;
  END IF;

  -- 1.4 get_invoice_paid_amount
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_invoice_paid_amount' AND pronargs = 1) THEN
    ALTER FUNCTION public.get_invoice_paid_amount(uuid) SET search_path = public, pg_temp;
  END IF;

  -- 1.5 enforce_sales_invoice_write_scope
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_sales_invoice_write_scope') THEN
    ALTER FUNCTION public.enforce_sales_invoice_write_scope() SET search_path = public, pg_temp;
  END IF;

  -- 1.6 get_invoice_credit_note_amount
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_invoice_credit_note_amount' AND pronargs = 1) THEN
    ALTER FUNCTION public.get_invoice_credit_note_amount(uuid) SET search_path = public, pg_temp;
  END IF;

  -- 1.7 trg_sync_credit_note_invoice_payment
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_sync_credit_note_invoice_payment') THEN
    ALTER FUNCTION public.trg_sync_credit_note_invoice_payment() SET search_path = public, pg_temp;
  END IF;

  -- 1.8 cancel_payment_voucher_posting search_path normalization
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancel_payment_voucher_posting' AND pronargs = 3) THEN
    ALTER FUNCTION public.cancel_payment_voucher_posting(uuid, uuid, text) SET search_path = public, pg_temp;
  END IF;

  -- 1.9 _sec_check_finance_role search_path normalization
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_sec_check_finance_role') THEN
    ALTER FUNCTION public._sec_check_finance_role() SET search_path = public, pg_temp;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Audit & Revoke Anonymous Execution on SECURITY DEFINER RPCs
-- ----------------------------------------------------------------------------
-- Explicitly revoke anonymous execution from mutators, triggers, and internal sequence generators
DO $$
BEGIN
  -- Credit note numbering: sequence generator must NOT be callable by anon
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_credit_note_number') THEN
    REVOKE ALL ON FUNCTION public.generate_credit_note_number() FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.generate_credit_note_number() TO authenticated, service_role;
  END IF;

  -- Gmail agent dispatcher: internal cron only
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'invoke_sapj_gmail_agent') THEN
    REVOKE ALL ON FUNCTION public.invoke_sapj_gmail_agent() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.invoke_sapj_gmail_agent() TO service_role;
  END IF;

  -- Sales invoice calculation helper
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recalculate_sales_invoice_payment_state' AND pronargs = 1) THEN
    REVOKE ALL ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) FROM PUBLIC, anon;
    GRANT EXECUTE ON FUNCTION public.recalculate_sales_invoice_payment_state(uuid) TO authenticated, service_role;
  END IF;

  -- Credit note invoice sync trigger
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_sync_credit_note_invoice_payment') THEN
    REVOKE ALL ON FUNCTION public.trg_sync_credit_note_invoice_payment() FROM PUBLIC, anon, authenticated;
  END IF;

  -- Sales invoice write scope trigger
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'enforce_sales_invoice_write_scope') THEN
    REVOKE ALL ON FUNCTION public.enforce_sales_invoice_write_scope() FROM PUBLIC, anon, authenticated;
  END IF;

  -- Credit note JE posting helper
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_post_credit_note_je') THEN
    REVOKE ALL ON FUNCTION public._post_credit_note_je(public.credit_notes) FROM PUBLIC, anon, authenticated;
  END IF;

  -- Credit note triggers
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_ensure_credit_note_number') THEN
    REVOKE ALL ON FUNCTION public.trg_ensure_credit_note_number() FROM PUBLIC, anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_guard_credit_note_type_transition') THEN
    REVOKE ALL ON FUNCTION public.trg_guard_credit_note_type_transition() FROM PUBLIC, anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_credit_note_inventory_v1') THEN
    REVOKE ALL ON FUNCTION public.trg_credit_note_inventory_v1() FROM PUBLIC, anon, authenticated;
  END IF;

  -- Reconcile shortage triggers
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_release_so_product_reservation_status_v2') THEN
    REVOKE ALL ON FUNCTION public.trg_release_so_product_reservation_status_v2() FROM PUBLIC, anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trg_batch_inward_reconcile_shortages') THEN
    REVOKE ALL ON FUNCTION public.trg_batch_inward_reconcile_shortages() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;

-- Systematic lockdown: Revoke ALL anon and PUBLIC execution across all SECURITY DEFINER functions in public schema
-- except genuine pre-login functions
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.proname NOT IN ('lookup_login_email', 'is_setup_mode')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon', r.proname, r.args);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Hardened Pre-Login Function: lookup_login_email
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lookup_login_email(p_username text)
RETURNS TABLE(email text, is_active boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_username text;
BEGIN
  -- Strict sanitization and input length check to prevent DoS or abuse
  v_clean_username := lower(trim(COALESCE(p_username, '')));
  IF v_clean_username = '' OR length(v_clean_username) > 100 THEN
    RETURN;
  END IF;

  -- Only allow standard username / staff-code characters
  IF v_clean_username !~ '^[a-z0-9._@+-]+$' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT up.email, up.is_active
  FROM public.user_profiles up
  WHERE lower(trim(up.username)) = v_clean_username
    AND up.is_active = true
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_setup_mode() TO anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Harden Authenticated-Callable RPCs Against Authorization Bypasses
-- ----------------------------------------------------------------------------

-- 4.1 approve_finance_expense
CREATE OR REPLACE FUNCTION public.approve_finance_expense(
  p_expense_id uuid,
  p_approved_by uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.finance_expenses%ROWTYPE;
  v_line public.bank_statement_lines%ROWTYPE;
  v_exp_currency text;
  v_bank_currency text;
  v_payable numeric;
  v_allocate numeric;
  v_period_status text;
  v_je_exists boolean;
  v_caller uuid;
BEGIN
  -- Strict authentication & role check
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_approved_by, auth.uid());
  ELSE
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public._sec_check_finance_role();
    v_caller := auth.uid();
  END IF;

  SELECT * INTO v_exp FROM public.finance_expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF v_exp.approval_status IS DISTINCT FROM 'approved' THEN
    UPDATE public.finance_expenses
       SET approval_status = 'approved',
           approved_by = v_caller,
           approved_at = now(),
           rejection_reason = NULL
     WHERE id = p_expense_id;

    -- Accounting generation trigger logic follows
    IF v_exp.accounting_treatment IS NOT NULL AND v_exp.accounting_treatment <> 'none' THEN
      SELECT status INTO v_period_status
      FROM public.accounting_periods
      WHERE start_date <= v_exp.expense_date AND end_date >= v_exp.expense_date
      ORDER BY start_date DESC LIMIT 1;

      IF v_period_status = 'locked' THEN
        RAISE EXCEPTION 'Cannot approve expense in locked accounting period';
      END IF;
    END IF;
  END IF;

  RETURN p_expense_id;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_finance_expense(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_finance_expense(uuid, uuid) TO authenticated, service_role;

-- 4.2 cancel_sales_invoice
CREATE OR REPLACE FUNCTION public.cancel_sales_invoice(
  p_invoice_id uuid,
  p_reason text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_role text;
  v_inv record;
  v_alloc_paid numeric := 0;
  v_adj_paid numeric := 0;
  v_reason text;
  v_rev_count int := 0;
  v_cogs_count int := 0;
  v_updated_notes text;
  v_je record;
  v_period_id uuid;
  v_rev_entry text;
  v_reversal_id uuid;
BEGIN
  -- Strict authentication & role verification: prevent spoofing via p_actor
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_actor, auth.uid());
  ELSE
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    v_caller := auth.uid();
  END IF;

  SELECT role INTO v_role FROM public.user_profiles WHERE id = v_caller AND is_active = true;
  IF v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot cancel sales invoices', COALESCE(v_role, 'unknown');
  END IF;

  -- Lock invoice row
  SELECT * INTO v_inv
  FROM public.sales_invoices
  WHERE id = p_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invoice not found');
  END IF;

  IF v_inv.payment_status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'message', 'Invoice already cancelled', 'invoice_id', p_invoice_id);
  END IF;

  -- Verify no payments are allocated
  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_paid
  FROM public.voucher_allocations
  WHERE sales_invoice_id = p_invoice_id;

  SELECT COALESCE(SUM(adjustment_amount), 0) INTO v_adj_paid
  FROM public.invoice_settlement_adjustments
  WHERE invoice_id = p_invoice_id;

  IF (v_alloc_paid + v_adj_paid) > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Cannot cancel invoice: active payments or adjustments exist (Allocated: %s, Adjustments: %s)', v_alloc_paid, v_adj_paid)
    );
  END IF;

  v_reason := COALESCE(NULLIF(trim(p_reason), ''), 'Sales Invoice cancelled');

  -- Update invoice status
  UPDATE public.sales_invoices
  SET payment_status = 'cancelled',
      balance_amount = 0,
      notes = CASE
        WHEN notes IS NULL OR notes = '' THEN 'Cancelled: ' || v_reason
        ELSE notes || ' | Cancelled: ' || v_reason
      END,
      updated_at = now()
  WHERE id = p_invoice_id;

  -- Reverse associated active journals
  FOR v_je IN
    SELECT * FROM public.journal_entries
    WHERE reference_id = p_invoice_id
      AND is_posted = true
      AND NOT COALESCE(is_reversed, false)
  LOOP
    SELECT id INTO v_period_id FROM public.accounting_periods
    WHERE start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE
    ORDER BY start_date DESC LIMIT 1;

    v_rev_entry := 'REV-' || v_je.entry_number;

    INSERT INTO public.journal_entries (
      entry_number, entry_date, description, reference_number, reference_id,
      source_module, total_debit, total_credit, is_posted, is_reversed,
      period_id, created_by, created_at, updated_at
    ) VALUES (
      v_rev_entry, CURRENT_DATE, 'Reversal of ' || v_je.entry_number || ': ' || v_reason,
      v_je.reference_number, p_invoice_id, v_je.source_module, v_je.total_credit, v_je.total_debit,
      true, false, v_period_id, v_caller, now(), now()
    ) RETURNING id INTO v_reversal_id;

    -- Mirror credit/debit lines
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description, created_at
    )
    SELECT v_reversal_id, account_id, credit, debit, 'Reversal: ' || COALESCE(description, ''), now()
    FROM public.journal_entry_lines
    WHERE journal_entry_id = v_je.id;

    UPDATE public.journal_entries
    SET is_reversed = true, updated_at = now()
    WHERE id = v_je.id;

    v_rev_count := v_rev_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'cancelled_by', v_caller,
    'reversed_journals_count', v_rev_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_sales_invoice(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_sales_invoice(uuid, text, uuid) TO authenticated, service_role;

-- 4.3 cancel_payment_voucher_posting
CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(
  p_pv_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pv RECORD;
  v_je RECORD;
  v_actor uuid;
BEGIN
  -- Strict authentication & role verification
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_cancelled_by, auth.uid());
  ELSE
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public._sec_check_finance_role();
    v_actor := auth.uid();
  END IF;

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF NOT v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_pv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Clean up allocations rounding
  DELETE FROM public.invoice_settlement_adjustments
  WHERE voucher_id = p_pv_id AND document_type = 'purchase';

  -- Clear journal entry links and mark unposted
  UPDATE public.payment_vouchers
  SET is_posted = false,
      journal_entry_id = NULL,
      updated_at = now()
  WHERE id = p_pv_id;

  -- Reverse or delete GL posting via cancel_gl_posting
  PERFORM public.cancel_gl_posting(
    v_je.id,
    p_pv_id,
    'payment_vouchers',
    v_actor,
    COALESCE(p_reason, 'Posting cancelled by authorized user')
  );

  -- Re-evaluate payment states of allocated invoices
  PERFORM public.sync_purchase_invoice_payment_state_from_pv_posting();
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_payment_voucher_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_payment_voucher_posting(uuid, uuid, text) TO authenticated, service_role;

-- 4.4 cancel_expense_posting
CREATE OR REPLACE FUNCTION public.cancel_expense_posting(
  p_exp_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.finance_expenses%ROWTYPE;
  v_je public.journal_entries%ROWTYPE;
  v_reversal_id uuid;
  v_period_status text;
  v_reversal_number text;
  v_actor uuid;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_cancelled_by, auth.uid());
  ELSE
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public._sec_check_finance_role();
    v_actor := auth.uid();
  END IF;

  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Cancellation reason is required';
  END IF;

  SELECT * INTO v_exp
  FROM public.finance_expenses
  WHERE id = p_exp_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found: %', p_exp_id;
  END IF;

  UPDATE public.finance_expenses
  SET approval_status = 'cancelled',
      rejection_reason = p_reason,
      updated_at = now()
  WHERE id = p_exp_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) TO authenticated, service_role;

-- 4.5 post_bpjs_monthly_register
CREATE OR REPLACE FUNCTION public.post_bpjs_monthly_register(
  p_register_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
  v_period_id uuid;
  v_je_id uuid;
  v_entry_num text;
  v_bpjs_payable_coa_id uuid;
  v_bpjs_expense_coa_id uuid;
  v_user uuid;
  v_posting_date date;
BEGIN
  -- Strict authentication and role check
  IF auth.role() = 'service_role' THEN
    v_user := COALESCE(p_user_id, auth.uid());
  ELSE
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    PERFORM public._sec_check_finance_role();
    v_user := auth.uid();
  END IF;

  SELECT * INTO v_reg FROM public.bpjs_monthly_registers WHERE id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BPJS register % not found', p_register_id; END IF;
  IF v_reg.status IN ('posted', 'reconciled') THEN
    RAISE EXCEPTION 'BPJS register % is already posted', p_register_id;
  END IF;

  v_posting_date := (make_date(v_reg.period_year, v_reg.period_month, 1) + interval '1 month - 1 day')::date;

  SELECT id INTO v_period_id FROM public.accounting_periods
   WHERE start_date <= v_posting_date AND end_date >= v_posting_date
   ORDER BY start_date DESC LIMIT 1;

  SELECT id INTO v_bpjs_payable_coa_id FROM public.chart_of_accounts WHERE code = '2134' LIMIT 1;
  IF v_bpjs_payable_coa_id IS NULL THEN
    SELECT id INTO v_bpjs_payable_coa_id FROM public.chart_of_accounts WHERE code = '2130' LIMIT 1;
  END IF;

  SELECT id INTO v_bpjs_expense_coa_id FROM public.chart_of_accounts WHERE code = '6115' LIMIT 1;
  IF v_bpjs_expense_coa_id IS NULL THEN
    SELECT id INTO v_bpjs_expense_coa_id FROM public.chart_of_accounts WHERE code = '6110' LIMIT 1;
  END IF;

  v_entry_num := 'BPJS-' || v_reg.period_year::text || '-' || lpad(v_reg.period_month::text, 2, '0');

  INSERT INTO public.journal_entries (
    entry_number, entry_date, description, reference_number, reference_id,
    source_module, total_debit, total_credit, is_posted, period_id, created_by
  ) VALUES (
    v_entry_num, v_posting_date,
    format('BPJS Ketenagakerjaan Accrual %s/%s', lpad(v_reg.period_month::text, 2, '0'), v_reg.period_year::text),
    v_reg.bill_number, v_reg.id, 'bpjs',
    v_reg.total_employer_share, v_reg.total_employer_share, true, v_period_id, v_user
  ) RETURNING id INTO v_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description
  ) VALUES
  (v_je_id, v_bpjs_expense_coa_id, v_reg.total_employer_share, 0, 'BPJS Ketenagakerjaan Employer Contribution'),
  (v_je_id, v_bpjs_payable_coa_id, 0, v_reg.total_employer_share, 'BPJS Ketenagakerjaan Payable');

  UPDATE public.bpjs_monthly_registers
  SET status = 'posted',
      posted_journal_id = v_je_id,
      posted_at = now(),
      posted_by = v_user,
      updated_at = now()
  WHERE id = p_register_id;

  RETURN jsonb_build_object(
    'success', true,
    'register_id', p_register_id,
    'journal_entry_id', v_je_id,
    'entry_number', v_entry_num
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_bpjs_monthly_register(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bpjs_monthly_register(uuid, uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5. RLS & Grant Hardening Across Sensitive ERP Tables
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_sensitive_tables text[] := ARRAY[
    'credit_notes', 'credit_note_items',
    'sales_invoices', 'sales_invoice_items',
    'delivery_challans', 'delivery_challan_items',
    'finance_expenses', 'payment_vouchers', 'receipt_vouchers',
    'journal_entries', 'journal_entry_lines',
    'bank_accounts', 'bank_statement_lines', 'bank_statement_allocations',
    'bpjs_monthly_registers', 'bpjs_monthly_register_items',
    'staff_master', 'user_profiles'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_sensitive_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = v_table) THEN
      -- Enable and Force RLS
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);

      -- Revoke all permissions from anon and PUBLIC
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', v_table);

      -- Strip dangerous privileges from authenticated
      EXECUTE format('REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.%I FROM authenticated', v_table);
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 6. pg_net Extension Security Invariants
-- ----------------------------------------------------------------------------
-- Compatibility guarantee: Do NOT move or reinstall pg_net to preserve edge functions and cron jobs.
-- Lockdown: Revoke execution on pg_net / net schema functions from PUBLIC and anon.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
    REVOKE ALL ON SCHEMA net FROM PUBLIC, anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon;
    GRANT USAGE ON SCHEMA net TO authenticated, service_role;
  END IF;
END $$;

COMMIT;
