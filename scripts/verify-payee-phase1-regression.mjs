import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

console.log('Starting Phase 1 Payee & Tax Architecture verification...');

const testSql = `
BEGIN;

DO $test$
DECLARE
  v_pph21_ne_id uuid;
  v_pph21_tt_id uuid;
  v_acc_2131 uuid;
  v_acc_2132 uuid;
  v_bank_acc_id uuid;
  v_resolved_acc uuid;
  v_payee_id uuid;
  v_dummy_code uuid;
  v_expense_id uuid;
  v_je_id uuid;
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id FROM public.user_profiles WHERE is_active=true LIMIT 1;
  SELECT id INTO v_acc_2131 FROM public.chart_of_accounts WHERE code = '2131';
  SELECT id INTO v_acc_2132 FROM public.chart_of_accounts WHERE code = '2132';
  SELECT id INTO v_bank_acc_id FROM public.bank_accounts WHERE is_active = true LIMIT 1;

  PERFORM set_config('app.expense_atomic_bank_link', 'on', true);

  -- TEST 1: Canonical Tax Code Mapping
  SELECT id INTO v_pph21_ne_id FROM public.tax_codes WHERE code = 'PPH21-NE';
  SELECT id INTO v_pph21_tt_id FROM public.tax_codes WHERE code = 'PPH21-TT';

  IF v_pph21_ne_id IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAILED: PPH21-NE tax code was not found in tax_codes';
  END IF;
  IF v_pph21_tt_id IS NULL THEN
    RAISE EXCEPTION 'TEST 1 FAILED: PPH21-TT tax code was not found in tax_codes';
  END IF;

  v_resolved_acc := public.fn_pph_payable_account_id(v_pph21_ne_id);
  IF v_resolved_acc <> v_acc_2131 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: PPH21-NE did not resolve to 2131 PPh 21 Payable (got %)', v_resolved_acc;
  END IF;

  v_resolved_acc := public.fn_pph_payable_account_id(v_pph21_tt_id);
  IF v_resolved_acc <> v_acc_2131 THEN
    RAISE EXCEPTION 'TEST 1 FAILED: PPH21-TT did not resolve to 2131 PPh 21 Payable (got %)', v_resolved_acc;
  END IF;
  RAISE NOTICE 'TEST 1 PASSED: PPH21-NE and PPH21-TT map authoritatively to 2131 PPh 21 Payable.';

  -- TEST 2: Payee Master Creation & FK Integrity
  INSERT INTO public.finance_payees (
    payee_code, full_name, business_role, tax_classification, ptkp_status, default_pph_code_id
  ) VALUES (
    'TEST-PAY-001', 'Test Commission Recipient', 'sales_commission_recipient', 'bukan_pegawai_imbalan', 'TK/0', v_pph21_ne_id
  ) RETURNING id INTO v_payee_id;

  IF v_payee_id IS NULL THEN
    RAISE EXCEPTION 'TEST 2 FAILED: Payee creation returned NULL id';
  END IF;
  RAISE NOTICE 'TEST 2 PASSED: Payee created successfully with role and classification enums.';

  -- TEST 3: Zero-Fallback Enforcement: Missing pph_code_id must abort
  BEGIN
    INSERT INTO public.finance_expenses (
      expense_category, amount, expense_date, description, payment_method, bank_account_id,
      approval_status, pph_amount, pph_code_id, payee_id, created_by
    ) VALUES (
      'marketing_advertising', 1000000, CURRENT_DATE, 'Test Missing PPh Code', 'bank_transfer', v_bank_acc_id,
      'approved', 50000, NULL, v_payee_id, v_user_id
    );
    RAISE EXCEPTION 'TEST 3 FAILED: Expense with pph_amount > 0 and pph_code_id = NULL was approved without error!';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%pph_code_id is NULL%' THEN
      RAISE NOTICE 'TEST 3 PASSED: Missing pph_code_id was rejected as expected: %', SQLERRM;
    ELSE
      RAISE EXCEPTION 'TEST 3 FAILED: Unexpected exception: %', SQLERRM;
    END IF;
  END;

  -- TEST 4: Zero-Fallback Enforcement: Invalid/Unmapped tax code must abort (NO fallback to 2132)
  -- Insert dummy tax code with valid tax_type='PPN' (not a withholding PPh tax type, payment_account_id NULL)
  INSERT INTO public.tax_codes (code, name, tax_type, rate, is_withholding, payment_account_id, is_active)
  VALUES ('TEST-DUMMY', 'Dummy Tax', 'PPN', 5.0, true, NULL, true)
  RETURNING id INTO v_dummy_code;

  BEGIN
    INSERT INTO public.finance_expenses (
      expense_category, amount, expense_date, description, payment_method, bank_account_id,
      approval_status, pph_amount, pph_code_id, payee_id, created_by
    ) VALUES (
      'marketing_advertising', 1000000, CURRENT_DATE, 'Test Dummy Tax Code', 'bank_transfer', v_bank_acc_id,
      'approved', 50000, v_dummy_code, v_payee_id, v_user_id
    );
    RAISE EXCEPTION 'TEST 4 FAILED: Expense with unmapped tax code was approved without error!';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%no valid GL liability account configured%' OR SQLERRM LIKE '%does not resolve%' THEN
      RAISE NOTICE 'TEST 4 PASSED: Unmapped tax code aborted posting (no silent fallback to 2132): %', SQLERRM;
    ELSE
      RAISE EXCEPTION 'TEST 4 FAILED: Unexpected exception: %', SQLERRM;
    END IF;
  END;

  -- TEST 5: Valid PPh 21 Posting & Payee Line Attribution
  INSERT INTO public.finance_expenses (
    expense_category, amount, expense_date, description, payment_method, bank_account_id,
    approval_status, pph_amount, pph_code_id, payee_id, pph_dpp_amount, pph_rate, pph_calculation_regime, created_by
  ) VALUES (
    'marketing_advertising', 2000000, CURRENT_DATE, 'Valid Commission Payment', 'bank_transfer', v_bank_acc_id,
    'approved', 50000, v_pph21_ne_id, v_payee_id, 1000000, 2.50, 'pasal17_dpp50', v_user_id
  ) RETURNING id INTO v_expense_id;

  SELECT id INTO v_je_id FROM public.journal_entries 
  WHERE reference_id = v_expense_id AND source_module IN ('expense', 'expenses');

  IF v_je_id IS NULL THEN
    RAISE EXCEPTION 'TEST 5 FAILED: Journal entry was not created for approved expense';
  END IF;

  -- Verify line credited to 2131 PPh 21 Payable
  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines 
    WHERE journal_entry_id = v_je_id AND account_id = v_acc_2131 AND credit = 50000 AND payee_id = v_payee_id
  ) THEN
    RAISE EXCEPTION 'TEST 5 FAILED: PPh 21 Ditahan line not credited to account 2131 with payee_id!';
  END IF;

  -- Verify 2132 was NOT credited
  IF EXISTS (
    SELECT 1 FROM public.journal_entry_lines 
    WHERE journal_entry_id = v_je_id AND account_id = v_acc_2132
  ) THEN
    RAISE EXCEPTION 'TEST 5 FAILED: Account 2132 PPh 23 Payable was incorrectly credited!';
  END IF;

  RAISE NOTICE 'TEST 5 PASSED: Journal entry correctly credited 2131 and recorded payee_id attribution.';

END $test$;

ROLLBACK;
`;

const tempFilePath = path.join(process.cwd(), 'scripts', '_temp_test_phase1.sql');
fs.writeFileSync(tempFilePath, testSql);

try {
  const raw = execSync(`npx supabase db query --linked --file scripts/_temp_test_phase1.sql`, {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  console.log(raw);
  console.log('Phase 1 test execution finished successfully.');
} finally {
  if (fs.existsSync(tempFilePath)) {
    fs.unlinkSync(tempFilePath);
  }
}
