-- Migration: 20261026190000_repair_trans_exis_jaya_broker_accounting.sql
-- Description: Database repair for supplier PT. TRANS EXIS JAYA:
-- 1. Create missing payment journal entry for EXP/26-26/113 bank statement line cffabeaa-2d92-4ee1-8732-7e2d996cfe42 (Rp 12,165,503.00),
--    repoint bank_statement_allocations.journal_entry_id away from recognition journal JE2602-0183 to this payment journal,
--    debiting 2110 Accounts Payable and crediting 111101 Bank BCA.
-- 2. Insert missing voucher_allocation for PV/26-26/017 (Rp 500.00) against EXP/26-26/139 (003/OR/SAPJ/V/2026)
--    and recalculate payment state so document paid_amount matches GL settlements (Rp 6,094,500.00).
--
-- Safety and Review Details:
-- - Affected Supplier: PT. TRANS EXIS JAYA (ID: 701bbcb1-3fe8-421f-acec-9d216193346d)
-- - Affected Expenses:
--   * EXP/26-26/113 (ID: 24eb8021-2b2d-4589-ad0c-280ceaffeb75): GL AP balance before: Rp 12,165,503.00 Cr -> after: Rp 0.00
--   * EXP/26-26/139 (ID: 3b56b2ee-c157-4da8-8bdc-c0bea9b3316d): Document paid_amount before: Rp 6,094,000.00 -> after: Rp 6,094,500.00
-- - Supplier Net GL 2110 Balance: before: Rp 12,165,503.00 Cr -> after: Rp 0.00 (Fully reconciled)
-- - Bank BCA 111101: before: overstated by Rp 12,165,503.00 in GL -> after: accurately reflects bank statement outflow of 2026-04-09.
--
-- Rollback Plan:
-- If needed, rollback can be performed with:
--   UPDATE public.bank_statement_allocations SET journal_entry_id = 'a7ef93a1-4a17-444b-814d-5ee939ab0c52' WHERE id = 'd847942a-f80a-473f-8d68-4101a5660cfe';
--   UPDATE public.bank_statement_lines SET matched_entry_id = 'a7ef93a1-4a17-444b-814d-5ee939ab0c52' WHERE id = 'cffabeaa-2d92-4ee1-8732-7e2d996cfe42';
--   DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM public.journal_entries WHERE reference_number = 'EXP-PAY-d847942a-f80a-473f-8d68-4101a5660cfe');
--   DELETE FROM public.journal_entries WHERE reference_number = 'EXP-PAY-d847942a-f80a-473f-8d68-4101a5660cfe';
--   DELETE FROM public.voucher_allocations WHERE payment_voucher_id = 'a387e532-3219-41ef-be03-93ab8dd01f53' AND finance_expense_id = '3b56b2ee-c157-4da8-8bdc-c0bea9b3316d';
--   PERFORM public.recalculate_expense_payment_state('3b56b2ee-c157-4da8-8bdc-c0bea9b3316d');

DO $$
DECLARE
  v_supplier_id uuid := '701bbcb1-3fe8-421f-acec-9d216193346d';
  v_expense_113_id uuid := '24eb8021-2b2d-4589-ad0c-280ceaffeb75';
  v_expense_139_id uuid := '3b56b2ee-c157-4da8-8bdc-c0bea9b3316d';
  v_bank_line_id uuid := 'cffabeaa-2d92-4ee1-8732-7e2d996cfe42';
  v_allocation_id uuid := 'd847942a-f80a-473f-8d68-4101a5660cfe';
  v_pv_017_id uuid := 'a387e532-3219-41ef-be03-93ab8dd01f53';
  v_ap_coa_id uuid;
  v_bank_coa_id uuid;
  v_period_id uuid;
  v_pay_je_id uuid;
  v_next_entry text;
  v_user_id uuid;
BEGIN
  -- Resolve COA accounts
  SELECT id INTO v_ap_coa_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
  SELECT coa_id INTO v_bank_coa_id FROM public.bank_accounts WHERE id = 'bfe79829-07d1-48ed-8965-ff9d367d758e';
  IF v_ap_coa_id IS NULL THEN RAISE EXCEPTION 'Account 2110 Accounts Payable not found'; END IF;
  IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Bank BCA COA account not found'; END IF;

  -- Resolve period for 2026-04-09
  SELECT id INTO v_period_id FROM public.accounting_periods
   WHERE start_date <= '2026-04-09'::date AND end_date >= '2026-04-09'::date
   ORDER BY start_date DESC LIMIT 1;

  -- 1. Create payment journal for EXP/26-26/113 if not already created
  SELECT id INTO v_pay_je_id
    FROM public.journal_entries
   WHERE reference_number = 'EXP-PAY-' || v_allocation_id::text
   LIMIT 1;

  IF v_pay_je_id IS NULL THEN
    v_next_entry := public.next_journal_entry_number();
    SELECT created_by INTO v_user_id FROM public.finance_expenses WHERE id = v_expense_113_id;

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id,
      reference_number, description, total_debit, total_credit, is_posted,
      posted_by, posted_at, created_by, transaction_currency, functional_currency,
      exchange_rate, amounts_are_functional
    ) VALUES (
      v_next_entry, '2026-04-09'::date, v_period_id, 'expense_payment', v_expense_113_id,
      'EXP-PAY-' || v_allocation_id::text, 'Expense bank payment: EXP/26-26/113', 12165503.00, 12165503.00, true,
      v_user_id, now(), v_user_id, 'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_pay_je_id;

    -- Debit Accounts Payable 2110
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate, supplier_id
    ) VALUES (
      v_pay_je_id, 1, v_ap_coa_id, 'Expense settlement - EXP/26-26/113', 12165503.00, 0,
      'IDR', 12165503.00, 0, 'IDR', 1.0, v_supplier_id
    );

    -- Credit Bank BCA 111101
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate, supplier_id
    ) VALUES (
      v_pay_je_id, 2, v_bank_coa_id, 'Bank payment - EXP/26-26/113', 0, 12165503.00,
      'IDR', 0, 12165503.00, 'IDR', 1.0, v_supplier_id
    );

    -- Update bank statement allocation to point to the payment journal
    UPDATE public.bank_statement_allocations
       SET journal_entry_id = v_pay_je_id
     WHERE id = v_allocation_id;

    -- Update bank statement line matched_entry_id
    UPDATE public.bank_statement_lines
       SET matched_entry_id = v_pay_je_id
     WHERE id = v_bank_line_id;
  END IF;

  -- 2. Link PV/26-26/017 to EXP/26-26/139 in voucher_allocations if missing
  IF NOT EXISTS (
    SELECT 1 FROM public.voucher_allocations
     WHERE payment_voucher_id = v_pv_017_id AND finance_expense_id = v_expense_139_id
  ) THEN
    INSERT INTO public.voucher_allocations (
      id, voucher_type, payment_voucher_id, finance_expense_id, allocated_amount, payment_kind, created_at
    ) VALUES (
      gen_random_uuid(), 'payment', v_pv_017_id, v_expense_139_id, 500.00, 'supplier', now()
    );

    -- Recalculate expense payment state
    PERFORM public.recalculate_expense_payment_state(v_expense_139_id);
  END IF;

  -- Refresh bank line allocation status & expense payment state for EXP/26-26/113
  PERFORM public.refresh_bank_statement_allocation_status(v_bank_line_id);
  PERFORM public.recalculate_expense_payment_state(v_expense_113_id);
END $$;
