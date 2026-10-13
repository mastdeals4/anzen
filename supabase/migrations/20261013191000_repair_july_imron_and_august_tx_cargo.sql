-- Migration: 20261013191000_repair_july_imron_and_august_tx_cargo.sql
-- Description: Verified Historical Data Repair for July 2026 (Imron Salary Duplicate)
--              and August 2026 (TX CARGO Missing Payment Journal).
--              Explicitly excludes September 2026 transactions.

BEGIN;

DO $repair$
DECLARE
  v_july_stmt_id uuid := '13e87d59-9f44-41e2-b356-3f77a0fdc0c6';
  v_july_alloc_id uuid := '24994e6b-9e8c-48c6-ade0-17df4790a8e0';
  v_july_correct_je_id uuid := '3622d019-2187-44b6-9738-ff470c61bd97'; -- JE2608-0111
  v_july_dup_je_id uuid := 'cd88dc74-7c56-41b9-86f8-e7cb3a43d4d1';     -- JE2610-0078

  v_aug_stmt_id uuid := '7fffe13b-4418-49eb-a9ae-b62846159dc2';
  v_aug_alloc_id uuid := '1ce4b068-97f9-4a47-8ac7-8e087acf8836';
  v_aug_exp_id uuid := '82d239fe-1d49-486d-9126-a20a9107b412';        -- EXP/26/202
  v_aug_supplier_id uuid := '701bbcb1-3fe8-421f-acec-9d216193346d';
  v_aug_stmt_line public.bank_statement_lines%rowtype;
  v_aug_payment_je_id uuid;
  v_entry text;
  v_period_id uuid;
  v_ap_id uuid;
  v_bca_id uuid;
  v_amount numeric := 28861549.00;
BEGIN
  SELECT id INTO v_ap_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT coa_id INTO v_bca_id FROM public.bank_accounts WHERE id = 'bfe79829-07d1-48ed-8965-ff9d367d758e';

  IF v_ap_id IS NULL OR v_bca_id IS NULL THEN
    RAISE EXCEPTION 'Required COA accounts 2110 or Bank BCA not found';
  END IF;

  -- ==========================================================================
  -- 1. JULY IMRON SALARY REPAIR
  -- ==========================================================================
  -- Void the duplicate payment journal JE2610-0078
  UPDATE public.journal_entries
     SET is_reversed = true,
         description = description || ' [VOIDED: duplicate bank payment of JE2608-0111]'
   WHERE id = v_july_dup_je_id
     AND is_reversed = false;

  -- Relink allocation to the genuine restatement journal JE2608-0111
  UPDATE public.bank_statement_allocations
     SET journal_entry_id = v_july_correct_je_id
   WHERE id = v_july_alloc_id
     AND journal_entry_id = v_july_dup_je_id;

  -- Refresh July statement line status
  PERFORM public.refresh_bank_statement_allocation_status(v_july_stmt_id);

  -- ==========================================================================
  -- 2. AUGUST TX CARGO (EXP/26/202) REPAIR
  -- ==========================================================================
  -- Trace actual statement line transaction date from the database
  SELECT * INTO v_aug_stmt_line
    FROM public.bank_statement_lines
   WHERE id = v_aug_stmt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'August bank statement line % not found', v_aug_stmt_id;
  END IF;

  -- Check if payment journal already exists (idempotency)
  SELECT id INTO v_aug_payment_je_id
    FROM public.journal_entries
   WHERE reference_id = v_aug_exp_id
     AND source_module = 'expense_payment'
     AND total_debit = v_amount
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false)
   LIMIT 1;

  IF v_aug_payment_je_id IS NULL THEN
    SELECT id INTO v_period_id
      FROM public.accounting_periods
     WHERE start_date <= v_aug_stmt_line.transaction_date::date
       AND end_date >= v_aug_stmt_line.transaction_date::date
     ORDER BY start_date DESC
     LIMIT 1;

    v_entry := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit, is_posted,
      posted_at, created_at, transaction_currency, functional_currency,
      exchange_rate, amounts_are_functional
    ) VALUES (
      v_entry, v_aug_stmt_line.transaction_date::date, v_period_id, 'expense_payment', v_aug_exp_id,
      'EXP-PAY-' || v_aug_alloc_id::text, 'Expense bank payment: EXP/26/202',
      v_amount, v_amount, true, now(), now(),
      'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_aug_payment_je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit,
      functional_currency, exchange_rate, supplier_id
    ) VALUES
      (v_aug_payment_je_id, 1, v_ap_id, 'Expense settlement - EXP/26/202', v_amount, 0,
       'IDR', v_amount, 0, 'IDR', 1.0, v_aug_supplier_id),
      (v_aug_payment_je_id, 2, v_bca_id, 'Bank payment - EXP/26/202', 0, v_amount,
       'IDR', 0, v_amount, 'IDR', 1.0, v_aug_supplier_id);
  END IF;

  -- Relink allocation to the canonical payment journal
  UPDATE public.bank_statement_allocations
     SET journal_entry_id = v_aug_payment_je_id
   WHERE id = v_aug_alloc_id;

  -- Refresh August statement line status
  PERFORM public.refresh_bank_statement_allocation_status(v_aug_stmt_id);

  -- Recalculate expense payment state
  PERFORM public.recalculate_expense_payment_state(v_aug_exp_id);

END;
$repair$;

COMMIT;
