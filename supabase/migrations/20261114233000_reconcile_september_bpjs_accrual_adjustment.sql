-- ==============================================================================
-- MIGRATION: 20261114233000_reconcile_september_bpjs_accrual_adjustment.sql
-- Description:
--   Final September 2026 BPJS Accounting Closure:
--   1. Validates September 2026 register totals (Rp 767,520).
--   2. Validates existing payment journal JE2610-0181 (debit 2134 Rp 767,520).
--   3. Posts balanced adjusting accrual journal BPJS-2026-09-ADJ:
--      - Debit 6115 BPJS Expense (Employer portion): Rp 521,520.00
--      - Debit 6110 Employee Benefits (Company-borne employee portion): Rp 246,000.00
--      - Credit 2134 BPJS Payable: Rp 767,520.00
--   4. Links September register's journal_entry_id to this adjustment journal.
--   5. Leaves bank payment, bank reconciliation, salary payments, and filed PPh unchanged.
-- ==============================================================================

BEGIN;

DO $reconcile$
DECLARE
  v_reg public.bpjs_monthly_registers%ROWTYPE;
  v_pay_je public.journal_entries%ROWTYPE;
  v_period_id uuid;
  v_bpjs_payable_coa uuid;
  v_bpjs_exp_coa uuid;
  v_benefits_coa uuid;
  v_existing_je_id uuid;
  v_entry_num text;
  v_adj_je_id uuid;
BEGIN
  -- 1. Validate September register
  SELECT * INTO v_reg
    FROM public.bpjs_monthly_registers
   WHERE period_year = 2026 AND period_month = 9
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'September 2026 BPJS register not found';
  END IF;

  IF v_reg.total_contribution_payable <> 767520.00
     OR v_reg.total_employee_deductions <> 246000.00
     OR v_reg.total_employer_expenses <> 521520.00 THEN
    RAISE EXCEPTION 'September register totals mismatch: payable=%, emp=%, er=%',
      v_reg.total_contribution_payable, v_reg.total_employee_deductions, v_reg.total_employer_expenses;
  END IF;

  -- 2. Validate existing payment journal JE2610-0181
  SELECT * INTO v_pay_je
    FROM public.journal_entries
   WHERE id = 'b7c563eb-257a-4182-b8ad-6e2241bf5967'
     AND entry_number = 'JE2610-0181'
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment journal JE2610-0181 is missing, unposted, or reversed';
  END IF;

  IF v_pay_je.total_debit <> 767520.00 THEN
    RAISE EXCEPTION 'Payment journal JE2610-0181 total debit is not 767,520';
  END IF;

  -- 3. Validate active COA accounts
  SELECT id INTO v_bpjs_payable_coa FROM public.chart_of_accounts WHERE code = '2134' AND is_active = true;
  IF v_bpjs_payable_coa IS NULL THEN RAISE EXCEPTION 'Account 2134 BPJS Payable not found or inactive'; END IF;

  SELECT id INTO v_bpjs_exp_coa FROM public.chart_of_accounts WHERE code = '6115' AND is_active = true;
  IF v_bpjs_exp_coa IS NULL THEN RAISE EXCEPTION 'Account 6115 BPJS Expense not found or inactive'; END IF;

  SELECT id INTO v_benefits_coa FROM public.chart_of_accounts WHERE code = '6110' AND is_active = true;
  IF v_benefits_coa IS NULL THEN RAISE EXCEPTION 'Account 6110 Employee Benefits not found or inactive'; END IF;

  -- 4. Determine accounting period (September 2026 is open)
  SELECT id INTO v_period_id
    FROM public.accounting_periods
   WHERE start_date <= '2026-09-30'::date AND end_date >= '2026-09-30'::date
     AND status = 'open'
   ORDER BY start_date DESC LIMIT 1;

  IF v_period_id IS NULL THEN
    -- Fallback to current open period if September is closed
    SELECT id INTO v_period_id
      FROM public.accounting_periods
     WHERE status = 'open'
     ORDER BY start_date DESC LIMIT 1;
  END IF;

  IF v_period_id IS NULL THEN
    RAISE EXCEPTION 'No open accounting period found for adjustment';
  END IF;

  -- 5. Check if adjustment journal already exists (idempotency)
  SELECT id INTO v_existing_je_id
    FROM public.journal_entries
   WHERE reference_number = 'BPJS-2026-09-ADJ'
      OR (source_module = 'bpjs_register' AND reference_id = v_reg.id AND total_debit = 767520.00);

  IF v_existing_je_id IS NOT NULL THEN
    v_adj_je_id := v_existing_je_id;
  ELSE
    -- Generate next entry number
    v_entry_num := public.next_journal_entry_number();

    INSERT INTO public.journal_entries (
      entry_number, entry_date, period_id, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by, posted_at, created_by,
      transaction_currency, functional_currency, exchange_rate, amounts_are_functional
    ) VALUES (
      v_entry_num, '2026-09-30', v_period_id, 'bpjs_register', v_reg.id,
      'BPJS-2026-09-ADJ',
      'BPJS Ketenagakerjaan Accrual Adjustment - Sep 2026 (Employer Contribution & Company-Borne Employee Share)',
      767520.00, 767520.00, true, v_reg.created_by, now(), v_reg.created_by,
      'IDR', 'IDR', 1.0, true
    ) RETURNING id INTO v_adj_je_id;

    -- Line 1: Debit 6115 BPJS Employer Expense: Rp 521,520
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
    ) VALUES (
      v_adj_je_id, 1, v_bpjs_exp_coa, 521520.00, 0,
      'Employer BPJS Contribution (JHT, JKK, JKM) - Sep 2026', 'IDR', 521520.00, 0, 'IDR', 1.0
    );

    -- Line 2: Debit 6110 Employee Benefits — Company-Borne BPJS: Rp 246,000
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
    ) VALUES (
      v_adj_je_id, 2, v_benefits_coa, 246000.00, 0,
      'Employee BPJS Contribution Borne by Company (Payroll Paid in Full Without Withholding) - Sep 2026',
      'IDR', 246000.00, 0, 'IDR', 1.0
    );

    -- Line 3: Credit 2134 BPJS Payable: Rp 767,520
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description,
      transaction_currency, transaction_debit, transaction_credit, functional_currency, exchange_rate
    ) VALUES (
      v_adj_je_id, 3, v_bpjs_payable_coa, 0, 767520.00,
      'BPJS Ketenagakerjaan Total Payable Accrual - Sep 2026', 'IDR', 0, 767520.00, 'IDR', 1.0
    );
  END IF;

  -- 6. Link September BPJS register's journal_entry_id
  UPDATE public.bpjs_monthly_registers
     SET journal_entry_id = v_adj_je_id,
         posted_at = COALESCE(posted_at, now()),
         posted_by = COALESCE(posted_by, v_reg.created_by),
         updated_at = now()
   WHERE id = v_reg.id;

END;
$reconcile$;

COMMIT;
