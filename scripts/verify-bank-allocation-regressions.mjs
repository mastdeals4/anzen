import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('Testing 1 bank line to 5 expenses AND multiple bank lines to 1 expense...');

const testSql = `
BEGIN;

DO $test$
DECLARE
  v_bank_acc_id uuid;
  v_bank_coa uuid;
  v_bsl_id uuid;
  v_upload_id uuid;
  v_bsl_a uuid;
  v_bsl_b uuid;
  v_bsl_c uuid;
  v_exp1 uuid;
  v_exp2 uuid;
  v_exp3 uuid;
  v_exp4 uuid;
  v_exp5 uuid;
  v_exp_multi uuid;
  v_allocated numeric;
  v_user_id uuid;
  v_exp_status text;
  v_line_status text;
BEGIN
  SELECT id INTO v_user_id FROM public.user_profiles WHERE is_active=true AND role = 'admin' LIMIT 1;
  IF v_user_id IS NULL THEN
    SELECT id INTO v_user_id FROM public.user_profiles WHERE is_active=true LIMIT 1;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('app.expense_atomic_bank_link', 'on', true);

  SELECT id, coa_id INTO v_bank_acc_id, v_bank_coa FROM public.bank_accounts WHERE is_active = true AND currency = 'IDR' LIMIT 1;
  SELECT id INTO v_upload_id FROM public.bank_statement_uploads WHERE bank_account_id = v_bank_acc_id LIMIT 1;
  IF v_upload_id IS NULL THEN
    INSERT INTO public.bank_statement_uploads (bank_account_id, statement_month, file_name, file_url, uploaded_by)
    VALUES (v_bank_acc_id, '2026-07-01', 'test_stmt.csv', 'test_url', v_user_id)
    RETURNING id INTO v_upload_id;
  END IF;

  -- =========================================================================
  -- SCENARIO 1: 1 Bank Transaction -> 5 Expenses (Aggregate Allocation)
  -- Bank = Rp 1,000,000
  -- Expenses = 200k + 150k + 250k + 175k + 225k = 1,000,000
  -- =========================================================================

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
  ) VALUES (
    v_upload_id, v_bank_acc_id, '2026-07-24', 1000000, 0, 'Bank transaction 1M for 5 expenses', 'unmatched', 'IDR'
  ) RETURNING id INTO v_bsl_id;

  v_exp1 := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 200000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp1, v_user_id);

  v_exp2 := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 150000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp2, v_user_id);

  v_exp3 := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 250000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp3, v_user_id);

  v_exp4 := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 175000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp4, v_user_id);

  v_exp5 := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 225000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp5, v_user_id);

  -- Link 1 bank line to all 5 expenses
  PERFORM public.link_bank_statement_line(v_bsl_id, 'expense', v_exp1, 'supplier', 200000);
  PERFORM public.link_bank_statement_line(v_bsl_id, 'expense', v_exp2, 'supplier', 150000);
  PERFORM public.link_bank_statement_line(v_bsl_id, 'expense', v_exp3, 'supplier', 250000);
  PERFORM public.link_bank_statement_line(v_bsl_id, 'expense', v_exp4, 'supplier', 175000);
  PERFORM public.link_bank_statement_line(v_bsl_id, 'expense', v_exp5, 'supplier', 225000);

  SELECT sum(allocation_amount) INTO v_allocated FROM public.bank_statement_allocations WHERE bank_statement_line_id = v_bsl_id;
  IF v_allocated <> 1000000 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: Expected total allocation 1,000,000 but got %', v_allocated;
  END IF;

  SELECT reconciliation_status INTO v_line_status FROM public.bank_statement_lines WHERE id = v_bsl_id;
  IF v_line_status <> 'matched' THEN
    RAISE EXCEPTION 'TEST 1 FAILED: Bank line status should be matched, got %', v_line_status;
  END IF;

  RAISE NOTICE 'TEST 1 PASSED: 1 bank line (1,000,000) -> 5 expenses (200k+150k+250k+175k+225k) allocated perfectly!';

  -- =========================================================================
  -- SCENARIO 2: Many Bank Transactions -> 1 Expense (Partial payments / split)
  -- Expense = Rp 1,000,000
  -- Bank A = 400k, Bank B = 350k, Bank C = 250k -> Paid = 1,000,000
  -- =========================================================================

  v_exp_multi := public.save_finance_expense(NULL, jsonb_build_object(
    'amount', 1000000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
    'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
  ));
  PERFORM public.approve_finance_expense(v_exp_multi, v_user_id);

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
  ) VALUES (
    v_upload_id, v_bank_acc_id, '2026-07-24', 400000, 0, 'Bank line A 400k', 'unmatched', 'IDR'
  ) RETURNING id INTO v_bsl_a;

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
  ) VALUES (
    v_upload_id, v_bank_acc_id, '2026-07-24', 350000, 0, 'Bank line B 350k', 'unmatched', 'IDR'
  ) RETURNING id INTO v_bsl_b;

  INSERT INTO public.bank_statement_lines (
    upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
  ) VALUES (
    v_upload_id, v_bank_acc_id, '2026-07-24', 250000, 0, 'Bank line C 250k', 'unmatched', 'IDR'
  ) RETURNING id INTO v_bsl_c;

  -- Link all 3 bank lines to the single expense
  PERFORM public.link_bank_statement_line(v_bsl_a, 'expense', v_exp_multi, 'supplier', 400000);
  PERFORM public.link_bank_statement_line(v_bsl_b, 'expense', v_exp_multi, 'supplier', 350000);
  PERFORM public.link_bank_statement_line(v_bsl_c, 'expense', v_exp_multi, 'supplier', 250000);

  SELECT sum(allocation_amount) INTO v_allocated 
    FROM public.bank_statement_allocations 
   WHERE document_type = 'expense' AND document_id = v_exp_multi;
  IF v_allocated <> 1000000 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: Expected total allocations on expense 1,000,000 but got %', v_allocated;
  END IF;

  SELECT paid_amount INTO v_allocated FROM public.finance_expenses WHERE id = v_exp_multi;
  IF v_allocated <> 1000000 THEN
    RAISE EXCEPTION 'TEST 2 FAILED: Expected expense paid_amount 1,000,000 but got %', v_allocated;
  END IF;

  RAISE NOTICE 'TEST 2 PASSED: 3 bank lines (400k+350k+250k) -> 1 expense (1,000,000) allocated and paid!';

  -- =========================================================================
  -- SCENARIO 3: Partial Allocation
  -- Bank = Rp 1,000,000 -> Allocate 600,000 -> Remaining Bank = 400,000
  -- =========================================================================
  DECLARE
    v_bsl_part uuid;
    v_exp_part uuid;
    v_remaining numeric;
  BEGIN
    INSERT INTO public.bank_statement_lines (
      upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
    ) VALUES (
      v_upload_id, v_bank_acc_id, '2026-07-24', 1000000, 0, 'Bank line 1M partial test', 'unmatched', 'IDR'
    ) RETURNING id INTO v_bsl_part;

    v_exp_part := public.save_finance_expense(NULL, jsonb_build_object(
      'amount', 600000, 'expense_category', 'office_supplies', 'expense_date', '2026-07-24',
      'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id
    ));
    PERFORM public.approve_finance_expense(v_exp_part, v_user_id);

    PERFORM public.link_bank_statement_line(v_bsl_part, 'expense', v_exp_part, 'supplier', 600000);

    SELECT reconciliation_status INTO v_line_status FROM public.bank_statement_lines WHERE id = v_bsl_part;
    IF v_line_status <> 'partially_reconciled' THEN
      RAISE EXCEPTION 'TEST 3 FAILED: Bank line status should be partially_reconciled, got %', v_line_status;
    END IF;

    SELECT 1000000 - COALESCE(sum(allocation_amount), 0) INTO v_remaining 
      FROM public.bank_statement_allocations WHERE bank_statement_line_id = v_bsl_part;
    IF v_remaining <> 400000 THEN
      RAISE EXCEPTION 'TEST 3 FAILED: Expected remaining bank balance 400,000, got %', v_remaining;
    END IF;

    RAISE NOTICE 'TEST 3 PASSED: Partial allocation Bank 1,000,000 - 600,000 = 400,000 remaining (partially_reconciled)!';
  END;

  -- =========================================================================
  -- SCENARIO 4: edit_approved_finance_expense_atomic with partial bank link
  -- (Simulating user's exact case: Expense EXP/26/240 linking 658,125 from 10.6M bank line)
  -- =========================================================================
  DECLARE
    v_bsl_user uuid;
    v_exp_user uuid;
    v_pph_code_id uuid;
  BEGIN
    SELECT id INTO v_pph_code_id FROM public.tax_codes WHERE code = 'PPH21-NE';

    INSERT INTO public.bank_statement_lines (
      upload_id, bank_account_id, transaction_date, debit_amount, credit_amount, description, reconciliation_status, currency
    ) VALUES (
      v_upload_id, v_bank_acc_id, '2026-07-24', 10649560, 0, 'Large bank transaction 10.6M', 'unmatched', 'IDR'
    ) RETURNING id INTO v_bsl_user;

    v_exp_user := public.save_finance_expense(NULL, jsonb_build_object(
      'amount', 675000, 'expense_category', 'marketing_advertising', 'expense_date', '2026-07-24',
      'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id,
      'pph_amount', 16875, 'ppn_amount', 0, 'pph_code_id', v_pph_code_id
    ));
    PERFORM public.approve_finance_expense(v_exp_user, v_user_id);

    -- Call edit_approved_finance_expense_atomic with partial allocation 658,125
    PERFORM public.edit_approved_finance_expense_atomic(
      v_exp_user,
      jsonb_build_object(
        'amount', 675000, 'expense_category', 'marketing_advertising', 'expense_date', '2026-07-24',
        'payment_method', 'bank_transfer', 'bank_account_id', v_bank_acc_id,
        'pph_amount', 16875, 'ppn_amount', 0, 'pph_code_id', v_pph_code_id,
        'description', 'SAPJ 26-034 -SODIUM DICLOFENAC - FAIZAH - PT RANIA'
      ),
      v_bsl_user,
      658125
    );

    SELECT sum(allocation_amount) INTO v_allocated
      FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = v_bsl_user AND document_id = v_exp_user;

    IF v_allocated <> 658125 THEN
      RAISE EXCEPTION 'TEST 4 FAILED: Expected allocation 658,125 but got %', v_allocated;
    END IF;

    RAISE NOTICE 'TEST 4 PASSED: edit_approved_finance_expense_atomic successfully linked 658,125 to 10.6M bank line!';
  END;

END $test$;

ROLLBACK;
`;

const tempFile = path.join(process.cwd(), 'scripts', '_test_bank_allocation_1_to_many.sql');
fs.writeFileSync(tempFile, testSql);

try {
  const result = execSync(`npx supabase db query --linked --file scripts/_test_bank_allocation_1_to_many.sql`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(result);
  console.log('All 4 bank allocation test scenarios passed successfully!');
} finally {
  if (fs.existsSync(tempFile)) {
    fs.unlinkSync(tempFile);
  }
}
