import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

test('CASE 1: Bank DEBIT, Counterparty = Vijay Lunkad, Type = Loan -> Loan Given, Account = 1310, Dr 1310 / Cr Bank', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_bank_id uuid;
      v_coa_1310 uuid;
      v_res jsonb;
      v_loan_id uuid;
      v_je_id uuid;
      v_dr_coa text;
      v_cr_coa text;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_bank_id FROM bank_accounts WHERE is_active = true LIMIT 1;
      SELECT id INTO v_coa_1310 FROM chart_of_accounts WHERE code = '1310' LIMIT 1;
      
      -- Test creation of given loan
      v_res := save_finance_loan(jsonb_build_object(
        'loan_date', '2026-09-20',
        'counterparty_name', 'Test Case 1 Borrower',
        'counterparty_type', 'person',
        'loan_type', 'given',
        'coa_id', v_coa_1310,
        'principal_amount', 1000000,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Test Loan Given 1310'
      ));
      
      v_loan_id := (v_res->>'id')::uuid;
      v_je_id := (v_res->>'journal_entry_id')::uuid;
      
      -- Verify journal lines: line 1 must be Dr 1310, line 2 must be Cr Bank
      SELECT coa.code INTO v_dr_coa
      FROM journal_entry_lines jel
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = v_je_id AND jel.debit > 0;
      
      SELECT coa.code INTO v_cr_coa
      FROM journal_entry_lines jel
      JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = v_je_id AND jel.credit > 0;
      
      IF v_dr_coa <> '1310' THEN
        RAISE EXCEPTION 'Expected Dr 1310, got %', v_dr_coa;
      END IF;
      
      IF v_cr_coa NOT LIKE '1111%' THEN
        RAISE EXCEPTION 'Expected Cr Bank, got %', v_cr_coa;
      END IF;
      
      -- Clean up test records: delete child references before parent
      DELETE FROM loans WHERE id = v_loan_id;
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      DELETE FROM journal_entries WHERE id = v_je_id;
    END $$;
    SELECT 1 as success;
  `);

  assert.equal(rows[0].success, 1);
});

test('CASE 2: Bank CREDIT, Counterparty = Vijay Lunkad, Type = Loan -> Loan Received, Suggested account = 2105, NOT 2210 by default', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_bank_id uuid;
      v_res jsonb;
      v_loan_id uuid;
      v_je_id uuid;
      v_loan_coa text;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_bank_id FROM bank_accounts WHERE is_active = true LIMIT 1;
      
      -- Call save_finance_loan without explicit coa_id for Vijay Lunkad (person)
      v_res := save_finance_loan(jsonb_build_object(
        'loan_date', '2026-09-20',
        'counterparty_name', 'Vijay Lunkad',
        'counterparty_type', 'person',
        'loan_type', 'taken',
        'principal_amount', 2000000,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Test Loan Received Director'
      ));
      
      v_loan_id := (v_res->>'id')::uuid;
      v_je_id := (v_res->>'journal_entry_id')::uuid;
      
      SELECT coa.code INTO v_loan_coa
      FROM loans l
      JOIN chart_of_accounts coa ON coa.id = l.coa_id
      WHERE l.id = v_loan_id;
      
      IF v_loan_coa <> '2105' THEN
        RAISE EXCEPTION 'Expected default COA 2105 for person counterparty, got %', v_loan_coa;
      END IF;
      
      -- Clean up: delete loan first because loans.journal_entry_id references journal_entries.id
      DELETE FROM loans WHERE id = v_loan_id;
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      DELETE FROM journal_entries WHERE id = v_je_id;
    END $$;
    SELECT 1 as success;
  `);

  assert.equal(rows[0].success, 1);
});

test('CASE 3: Bank CREDIT, Counterparty = BCA / institutional bank -> Loan Received, Suggested account may be 2210', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_bank_id uuid;
      v_res jsonb;
      v_loan_id uuid;
      v_je_id uuid;
      v_loan_coa text;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_bank_id FROM bank_accounts WHERE is_active = true LIMIT 1;
      
      -- Call save_finance_loan for Bank Central Asia (institutional bank)
      v_res := save_finance_loan(jsonb_build_object(
        'loan_date', '2026-09-20',
        'counterparty_name', 'Bank Central Asia',
        'counterparty_type', 'bank',
        'loan_type', 'taken',
        'principal_amount', 5000000,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Test Commercial Bank Loan'
      ));
      
      v_loan_id := (v_res->>'id')::uuid;
      v_je_id := (v_res->>'journal_entry_id')::uuid;
      
      SELECT coa.code INTO v_loan_coa
      FROM loans l
      JOIN chart_of_accounts coa ON coa.id = l.coa_id
      WHERE l.id = v_loan_id;
      
      IF v_loan_coa <> '2210' THEN
        RAISE EXCEPTION 'Expected default COA 2210 for institutional bank, got %', v_loan_coa;
      END IF;
      
      -- Clean up
      DELETE FROM loans WHERE id = v_loan_id;
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      DELETE FROM journal_entries WHERE id = v_je_id;
    END $$;
    SELECT 1 as success;
  `);

  assert.equal(rows[0].success, 1);
});

test('CASE 4: Loan Given Rp 10m, then Repayment Rp 10m -> Outstanding = Rp 0, Status = Closed', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_bank_id uuid;
      v_coa_1310 uuid;
      v_res jsonb;
      v_rep_res jsonb;
      v_loan_id uuid;
      v_loan_je_id uuid;
      v_rep_id uuid;
      v_rep_je_id uuid;
      v_out numeric;
      v_status text;
      v_rep_dr_coa text;
      v_rep_cr_coa text;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_bank_id FROM bank_accounts WHERE is_active = true LIMIT 1;
      SELECT id INTO v_coa_1310 FROM chart_of_accounts WHERE code = '1310' LIMIT 1;
      
      -- 1. Create loan given Rp 10m
      v_res := save_finance_loan(jsonb_build_object(
        'loan_date', '2026-09-12',
        'counterparty_name', 'Temporary Borrower',
        'counterparty_type', 'person',
        'loan_type', 'given',
        'coa_id', v_coa_1310,
        'principal_amount', 10000000,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Temporary Loan 10m'
      ));
      v_loan_id := (v_res->>'id')::uuid;
      v_loan_je_id := (v_res->>'journal_entry_id')::uuid;
      
      -- 2. Repay loan given Rp 10m
      v_rep_res := save_finance_loan_repayment(jsonb_build_object(
        'loan_id', v_loan_id,
        'transaction_date', '2026-09-14',
        'principal_amount', 10000000,
        'interest_amount', 0,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Temporary Loan Return'
      ));
      v_rep_id := (v_rep_res->>'id')::uuid;
      v_rep_je_id := (v_rep_res->>'journal_entry_id')::uuid;
      
      -- Check outstanding balance and status
      SELECT outstanding_balance, status INTO v_out, v_status FROM loans WHERE id = v_loan_id;
      
      IF v_out <> 0 THEN
        RAISE EXCEPTION 'Expected outstanding balance 0, got %', v_out;
      END IF;
      
      IF v_status <> 'closed' THEN
        RAISE EXCEPTION 'Expected status closed, got %', v_status;
      END IF;
      
      -- Check repayment journal lines: Dr Bank, Cr 1310
      SELECT coa.code INTO v_rep_dr_coa
      FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = v_rep_je_id AND jel.debit > 0;
      
      SELECT coa.code INTO v_rep_cr_coa
      FROM journal_entry_lines jel JOIN chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = v_rep_je_id AND jel.credit > 0;
      
      IF v_rep_dr_coa NOT LIKE '1111%' OR v_rep_cr_coa <> '1310' THEN
        RAISE EXCEPTION 'Expected Dr Bank / Cr 1310, got Dr % / Cr %', v_rep_dr_coa, v_rep_cr_coa;
      END IF;
      
      -- Clean up test records
      DELETE FROM loan_transactions WHERE id = v_rep_id;
      DELETE FROM loans WHERE id = v_loan_id;
      DELETE FROM journal_entry_lines WHERE journal_entry_id IN (v_loan_je_id, v_rep_je_id);
      DELETE FROM journal_entries WHERE id IN (v_loan_je_id, v_rep_je_id);
    END $$;
    SELECT 1 as success;
  `);

  assert.equal(rows[0].success, 1);
});

test('CASE 5: Existing LN2601-0001 Rp 20m director liability -> September temporary Vijay loan MUST NOT modify it', () => {
  const rows = runSql(`
    SELECT loan_number, loan_type, counterparty_name, principal_amount, outstanding_balance, status, coa.code as coa_code
    FROM loans l
    JOIN chart_of_accounts coa ON coa.id = l.coa_id
    WHERE l.loan_number = 'LN2601-0001';
  `);

  assert.equal(rows.length, 1);
  const l = rows[0];
  assert.equal(l.loan_number, 'LN2601-0001');
  assert.equal(l.loan_type, 'taken');
  assert.equal(l.counterparty_name, 'Vijay Lunkad');
  assert.equal(Number(l.principal_amount), 20000000);
  assert.equal(Number(l.outstanding_balance), 20000000);
  assert.equal(l.status, 'active');
  assert.equal(l.coa_code, '2105');
});

test('CASE 6: Record the same bank line twice -> No duplicate loan, No duplicate journal, No duplicate bank reconciliation', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_bank_id uuid;
      v_upload_id uuid;
      v_line_id uuid;
      v_coa_1310 uuid;
      v_res jsonb;
      v_loan_id uuid;
      v_je_id uuid;
      v_error_caught boolean := false;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);
      SELECT id INTO v_bank_id FROM bank_accounts WHERE is_active = true LIMIT 1;
      SELECT id INTO v_upload_id FROM bank_statement_uploads LIMIT 1;
      SELECT id INTO v_coa_1310 FROM chart_of_accounts WHERE code = '1310' LIMIT 1;
      
      -- Create a dummy bank statement line
      v_line_id := gen_random_uuid();
      INSERT INTO bank_statement_lines(
        id, upload_id, bank_account_id, transaction_date,
        description, debit_amount, credit_amount, currency
      )
      VALUES (
        v_line_id, v_upload_id, v_bank_id, '2026-09-20',
        'Test Duplicate Protection Line', 1000000, 0, 'IDR'
      );
      
      -- Record loan 1st time (linking bank line)
      v_res := save_finance_loan(jsonb_build_object(
        'loan_date', '2026-09-20',
        'counterparty_name', 'Duplicate Test Borrower',
        'counterparty_type', 'person',
        'loan_type', 'given',
        'coa_id', v_coa_1310,
        'principal_amount', 1000000,
        'bank_account_id', v_bank_id,
        'transaction_currency', 'IDR',
        'exchange_rate', 1,
        'description', 'Test Loan Line'
      ), v_line_id);
      
      v_loan_id := (v_res->>'id')::uuid;
      v_je_id := (v_res->>'journal_entry_id')::uuid;
      
      -- Attempt to record loan 2nd time on the same bank line
      BEGIN
        PERFORM save_finance_loan(jsonb_build_object(
          'loan_date', '2026-09-20',
          'counterparty_name', 'Duplicate Test Borrower',
          'counterparty_type', 'person',
          'loan_type', 'given',
          'coa_id', v_coa_1310,
          'principal_amount', 1000000,
          'bank_account_id', v_bank_id,
          'transaction_currency', 'IDR',
          'exchange_rate', 1,
          'description', 'Test Loan Line 2nd time'
        ), v_line_id);
      EXCEPTION WHEN OTHERS THEN
        v_error_caught := true;
      END;
      
      -- Cleanup
      DELETE FROM loans WHERE id = v_loan_id;
      DELETE FROM journal_entry_lines WHERE journal_entry_id = v_je_id;
      DELETE FROM journal_entries WHERE id = v_je_id;
      DELETE FROM bank_statement_lines WHERE id = v_line_id;
      
      IF NOT v_error_caught THEN
        RAISE EXCEPTION 'Expected error when recording same bank line twice, but none was thrown';
      END IF;
    END $$;
    SELECT 1 as success;
  `);

  assert.equal(rows[0].success, 1);
});
