import { execFileSync } from 'node:child_process';

const sql = `
BEGIN;

SELECT set_config(
  'request.jwt.claim.sub',
  (
    SELECT id::text
      FROM public.user_profiles
     WHERE role IN ('admin', 'accounts')
       AND is_active = true
     ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, id
     LIMIT 1
  ),
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;

DO $regression$
DECLARE
  v_user uuid := auth.uid();
  v_staff uuid;
  v_bank uuid;
  v_saved jsonb;
  v_payment uuid;
  v_salary_expense uuid;
  v_salary_application jsonb;
  v_journal uuid;
  v_count bigint;
  v_debit numeric;
  v_credit numeric;
  v_paid numeric;
  v_line uuid := '2d8a6428-ab76-4086-9d4e-aa4b82e3286d';
  v_expense uuid := '973b749e-e8cc-41f9-9d7e-15a261823ab5';
  v_broker record;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Regression harness could not establish an authenticated Finance user';
  END IF;

  SELECT id INTO v_staff
    FROM public.finance_staff_master
   WHERE status = 'active'
   ORDER BY created_at, id
   LIMIT 1;
  SELECT id INTO v_bank
    FROM public.bank_accounts
   WHERE is_active = true
     AND upper(currency) = 'IDR'
     AND coa_id IS NOT NULL
   ORDER BY created_at, id
   LIMIT 1;
  IF v_staff IS NULL OR v_bank IS NULL THEN
    RAISE EXCEPTION 'Salary Advance fixtures require an active staff member and IDR bank';
  END IF;

  -- Salary Advance: create through the shared command and post through the
  -- normal Payment Voucher engine. The outer transaction rolls everything back.
  v_saved := public.save_payment_voucher_with_purpose(
    NULL,
    jsonb_build_object(
      'voucher_date', current_date,
      'staff_id', v_staff,
      'payment_method', 'bank_transfer',
      'bank_account_id', v_bank,
      'amount', 1000,
      'invoice_amount', 1000,
      'payment_amount', 1000,
      'payment_currency', 'IDR',
      'invoice_currency', 'IDR',
      'exchange_rate', 1,
      'bank_amount', 1000,
      'actual_bank_debit', 1000,
      'description', 'Finance V1 transactional Salary Advance regression',
      'created_by', v_user
    ),
    '[]'::jsonb,
    'salary_advance'
  );
  v_payment := (v_saved->>'id')::uuid;
  PERFORM public.post_payment_voucher(v_payment, v_user);

  SELECT journal_entry_id
    INTO STRICT v_journal
    FROM public.payment_vouchers
   WHERE id = v_payment
     AND is_posted = true
     AND payment_purpose = 'salary_advance'
     AND salary_advance_status = 'outstanding';
  SELECT total_debit, total_credit INTO v_debit, v_credit
    FROM public.journal_entries WHERE id = v_journal;
  IF v_journal IS NULL OR abs(COALESCE(v_debit, 0) - COALESCE(v_credit, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Salary Advance did not create a balanced journal';
  END IF;

  PERFORM 1 FROM public.get_outstanding_salary_advances(v_staff, current_date)
   WHERE advance_id = v_payment AND available_amount = 1000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary Advance outstanding ledger did not expose the posted advance';
  END IF;

  -- Salary: create and approve a normal Salary expense, then recover the
  -- advance through the canonical FIFO settlement path.
  v_salary_expense := public.save_finance_expense(
    NULL,
    jsonb_build_object(
      'expense_date', current_date,
      'expense_category', 'salary',
      'expense_type', 'admin',
      'amount', 2000,
      'staff_id', v_staff,
      'description', 'Finance V1 transactional Salary regression',
      'approval_status', 'pending_approval',
      'transaction_currency', 'IDR',
      'exchange_rate', 1,
      'created_by', v_user
    )
  );
  PERFORM public.approve_finance_expense(v_salary_expense, v_user);

  SELECT je.id, je.total_debit, je.total_credit
    INTO STRICT v_journal, v_debit, v_credit
    FROM public.journal_entries je
   WHERE je.reference_id = v_salary_expense
     AND je.source_module IN ('expense', 'expenses')
     AND je.is_posted = true
     AND COALESCE(je.is_reversed, false) = false
   ORDER BY je.created_at DESC
   LIMIT 1;
  IF abs(COALESCE(v_debit, 0) - COALESCE(v_credit, 0)) > 0.01 THEN
    RAISE EXCEPTION 'Salary expense did not create a balanced journal';
  END IF;

  v_salary_application := public.apply_salary_advances_to_expense(v_salary_expense, true);
  IF COALESCE((v_salary_application->>'total_applied')::numeric, 0) <> 1000
     OR COALESCE((v_salary_application->>'remaining_salary')::numeric, 0) <> 1000 THEN
    RAISE EXCEPTION 'Salary Advance recovery did not apply 1000 against the 2000 Salary expense';
  END IF;
  PERFORM 1
    FROM public.salary_advance_applications
   WHERE advance_payment_voucher_id = v_payment
     AND salary_expense_id = v_salary_expense
     AND applied_amount = 1000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary Advance application audit link was not created';
  END IF;
  PERFORM 1
    FROM public.payment_vouchers
   WHERE id = v_payment
     AND salary_advance_status = 'settled'
     AND salary_advance_applied_amount = 1000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary Advance status did not settle after Salary recovery';
  END IF;
  PERFORM 1
    FROM public.get_outstanding_expense_bills(current_date)
   WHERE id = v_salary_expense
     AND amount = 2000
     AND paid_amount = 1000
     AND balance_amount = 1000;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Salary payable/AP report does not show the canonical 1000 outstanding balance';
  END IF;

  -- Bank Reconciliation: unlink and relink a controlled existing Expense.
  -- This specifically verifies the payment-state trigger no longer invokes a
  -- historical journal currency rewrite.
  IF EXISTS (SELECT 1 FROM public.bank_statement_lines WHERE id = v_line) THEN
    PERFORM public.unmatch_bank_line(v_line);
    PERFORM 1
      FROM public.bank_statement_lines
     WHERE id = v_line
       AND matched_expense_id IS NULL
       AND matched_entry_id IS NULL
       AND reconciliation_status = 'unmatched'
       AND matching_status = 'none'
       AND manually_unlinked = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense bank unlink was immediately rematched or left stale reconciliation metadata';
    END IF;
    SELECT paid_amount INTO v_paid FROM public.finance_expenses WHERE id = v_expense;
    IF COALESCE(v_paid, 0) <> 0 THEN
      RAISE EXCEPTION 'Expense paid amount remained % after bank unlink', v_paid;
    END IF;

    PERFORM public.link_bank_statement_line(v_line, 'expense', v_expense, 'supplier');
    SELECT paid_amount INTO v_paid FROM public.finance_expenses WHERE id = v_expense;
    IF COALESCE(v_paid, 0) <> 5 THEN
      RAISE EXCEPTION 'Expense paid amount was % after bank relink; expected 5', v_paid;
    END IF;
  END IF;

  -- Journal and ledger integrity.
  SELECT count(*) INTO v_count
    FROM public.journal_entries je
   WHERE je.is_posted = true
     AND abs(
       COALESCE((SELECT sum(jel.debit) FROM public.journal_entry_lines jel WHERE jel.journal_entry_id = je.id), 0)
       - COALESCE((SELECT sum(jel.credit) FROM public.journal_entry_lines jel WHERE jel.journal_entry_id = je.id), 0)
     ) > 0.01;
  IF v_count <> 0 THEN RAISE EXCEPTION '% posted journals are unbalanced', v_count; END IF;

  SELECT count(*) INTO v_count FROM public.unbalanced_journal_entries;
  IF v_count <> 0 THEN RAISE EXCEPTION '% rows exist in unbalanced_journal_entries', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.journal_entry_lines jel
    LEFT JOIN public.journal_entries je ON je.id = jel.journal_entry_id
   WHERE je.id IS NULL;
  IF v_count <> 0 THEN RAISE EXCEPTION '% orphan journal lines found', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.journal_entry_lines jel
    LEFT JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
   WHERE coa.id IS NULL;
  IF v_count <> 0 THEN RAISE EXCEPTION '% General Ledger lines have no Chart of Accounts row', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
    LEFT JOIN public.receipt_vouchers rv ON rv.id = va.receipt_voucher_id
   WHERE pv.id IS NULL AND rv.id IS NULL;
  IF v_count <> 0 THEN RAISE EXCEPTION '% orphan voucher allocations found', v_count; END IF;

  -- Trial Balance, P&L and Balance Sheet use the authenticated report RPCs.
  SELECT COALESCE(sum(total_debit), 0), COALESCE(sum(total_credit), 0)
    INTO v_debit, v_credit
    FROM public.get_trial_balance('2000-01-01'::date, current_date, 1);
  IF abs(v_debit - v_credit) > 0.01 THEN
    RAISE EXCEPTION 'Trial Balance is out by %', v_debit - v_credit;
  END IF;

  PERFORM 1 FROM public.get_pnl_summary('2000-01-01'::date, current_date, 1);
  IF NOT FOUND THEN RAISE EXCEPTION 'Profit and Loss RPC returned no row'; END IF;

  PERFORM 1 FROM public.get_balance_sheet(current_date, 1);
  IF NOT FOUND THEN RAISE EXCEPTION 'Balance Sheet RPC returned no rows'; END IF;

  -- Remaining Finance report contracts. These are the same canonical sources
  -- consumed by General Ledger, party ledgers, AP/AR, aging, bank/cash books,
  -- tax reporting, and CA reports.
  PERFORM public.get_petty_cash_balance();
  PERFORM 1 FROM public.get_outstanding_expense_bills(current_date);

  SELECT count(*) INTO v_count
    FROM public.finance_expenses fe
    LEFT JOIN public.suppliers s ON s.id = fe.supplier_id
   WHERE fe.supplier_id IS NOT NULL AND s.id IS NULL;
  IF v_count <> 0 THEN RAISE EXCEPTION '% Supplier Ledger expense references are orphaned', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.sales_invoices si
    LEFT JOIN public.customers c ON c.id = si.customer_id
   WHERE c.id IS NULL;
  IF v_count <> 0 THEN RAISE EXCEPTION '% Customer Ledger invoice references are orphaned', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.sales_invoices si
   WHERE public.get_invoice_paid_amount(si.id) - COALESCE(si.total_amount, 0) > 0.01;
  IF v_count <> 0 THEN RAISE EXCEPTION '% Accounts Receivable/Aging invoices are overpaid', v_count; END IF;

  SELECT count(*) INTO v_count
    FROM public.bank_statement_lines bsl
    LEFT JOIN public.finance_expenses fe ON fe.id = bsl.matched_expense_id
    LEFT JOIN public.receipt_vouchers rv ON rv.id = bsl.matched_receipt_id
    LEFT JOIN public.payment_vouchers pv ON pv.id = bsl.matched_payment_id
    LEFT JOIN public.journal_entries je ON je.id = bsl.matched_entry_id
   WHERE (bsl.matched_expense_id IS NOT NULL AND fe.id IS NULL)
      OR (bsl.matched_receipt_id IS NOT NULL AND rv.id IS NULL)
      OR (bsl.matched_payment_id IS NOT NULL AND pv.id IS NULL)
      OR (bsl.matched_entry_id IS NOT NULL AND je.id IS NULL);
  IF v_count <> 0 THEN RAISE EXCEPTION '% Bank Ledger/Reconciliation links are orphaned', v_count; END IF;

  PERFORM 1 FROM public.vw_monthly_tax_summary;
  PERFORM 1 FROM public.vw_outstanding_tax;
  PERFORM 1 FROM public.vw_tax_period_status;

  -- Petty Cash source documents must own balanced journals and must not leave
  -- the dedicated missing-link view populated.
  SELECT count(*) INTO v_count FROM public.missing_petty_cash_links;
  IF v_count <> 0 THEN RAISE EXCEPTION '% Petty Cash records have missing links', v_count; END IF;
  SELECT count(*) INTO v_count
    FROM public.petty_cash_transactions pct
    JOIN public.journal_entries je
      ON je.source_module = 'petty_cash'
     AND je.reference_id = pct.id
     AND je.is_posted = true
     AND COALESCE(je.is_reversed, false) = false
   WHERE abs(je.total_debit - je.total_credit) > 0.01;
  IF v_count <> 0 THEN RAISE EXCEPTION '% Petty Cash journals are unbalanced', v_count; END IF;

  -- Canonical Customs Broker values.
  SELECT * INTO v_broker
    FROM public.vw_customs_broker_accounting
   WHERE voucher_number = 'EXP/26-26/113';
  IF NOT FOUND
     OR v_broker.reimbursement_total <> 9127503
     OR v_broker.expense_total <> 12227503
     OR v_broker.recoverable_input_ppn <> 457695
     OR v_broker.pph23_withheld <> 62000
     OR v_broker.final_cash_payable <> 12165503 THEN
    RAISE EXCEPTION 'Canonical Customs Broker values do not reconcile';
  END IF;

  -- SECURITY DEFINER Finance entrypoints must not be executable by anon.
  SELECT count(*) INTO v_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('anon', p.oid, 'EXECUTE')
     AND (
       p.proname ~* '(finance|expense|payment|receipt|journal|ledger|tax|ppn|pph|salary|petty|bank|trial|balance|pnl|broker)'
     );
  IF v_count <> 0 THEN
    RAISE EXCEPTION '% Finance SECURITY DEFINER functions remain executable by anon', v_count;
  END IF;
END;
$regression$;

ROLLBACK;
`;

try {
  const stdout = execFileSync(
    'supabase',
    ['db', 'query', '--linked', '--output-format', 'json', sql],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 100 * 1024 * 1024,
    },
  );
  const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
  if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
  console.log(JSON.stringify({
    status: 'passed',
    transaction: 'rolled_back',
    checks: [
      'salary_advance_create_post_outstanding',
      'salary_create_post_advance_recovery_ap_outstanding',
      'bank_reconciliation_unlink_relink',
      'journal_balance_and_orphans',
      'trial_balance_rpc',
      'profit_and_loss_rpc',
      'balance_sheet_rpc',
      'general_supplier_customer_bank_cash_ap_ar_aging_tax_ca_report_contracts',
      'petty_cash_links_and_journals',
      'customs_broker_canonical_values',
      'anonymous_security_definer_access',
    ],
  }, null, 2));
} catch (error) {
  if (error && typeof error === 'object') {
    if ('stdout' in error && error.stdout) process.stderr.write(String(error.stdout));
    if ('stderr' in error && error.stderr) process.stderr.write(String(error.stderr));
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
