import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260903120000_fix_expense_partial_payment_accounting.sql', import.meta.url),
  'utf8',
);

const paymentState = (payable, payments) => {
  const actualPaid = Math.min(payable, payments.reduce((sum, amount) => sum + amount, 0));
  return { actualPaid, outstanding: payable - actualPaid };
};

test('full, partial, and repeated payments preserve the payable/payment distinction', () => {
  assert.deepEqual(paymentState(100, [100]), { actualPaid: 100, outstanding: 0 });
  assert.deepEqual(paymentState(100, [60]), { actualPaid: 60, outstanding: 40 });
  assert.deepEqual(paymentState(100, [30, 20]), { actualPaid: 50, outstanding: 50 });
  assert.deepEqual(paymentState(6_094_500, [3_742_000, 2_352_000]), {
    actualPaid: 6_094_000,
    outstanding: 500,
  });
  assert.deepEqual(paymentState(15_773_002, [15_273_502]), {
    actualPaid: 15_273_502,
    outstanding: 499_500,
  });
});

test('bank-transfer expense recognition credits AP, not the full payable to Bank', () => {
  assert.match(migration, /NEW\.payment_method = 'bank_transfer'[\s\S]*code='2110'/);
  assert.match(migration, /v_outstanding boolean := NEW\.payment_method IS NULL OR NEW\.payment_method IN \('outstanding','bank_transfer'\)/);
  assert.doesNotMatch(migration, /UPDATE\s+public\.finance_expenses\s+SET/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.journal_entry_lines\s+SET/i);
});

test('each confirmed direct allocation posts exactly its own cash amount', () => {
  assert.match(migration, /v_allocation_id uuid := gen_random_uuid\(\)/);
  assert.match(migration, /'expense_payment'/);
  assert.match(migration, /v_functional_amount:=round\(v_allocate\*v_rate,2\)/);
  assert.match(
    migration,
    /v_settlement_coa[\s\S]*v_functional_amount,0[\s\S]*v_bank_coa[\s\S]*0,v_functional_amount/,
  );
  assert.match(migration, /journal bank credit must equal the confirmed allocation amount/i);
  assert.match(migration, /sum\(a\.allocation_amount\)/);
  assert.match(migration, /Allocation exceeds document outstanding amount/);
  assert.match(migration, /Allocation exceeds remaining bank amount/);
});

test('VAT, PPh, and broker payable calculations remain authoritative and unchanged', () => {
  assert.match(migration, /calculate_finance_expense_payable\(p_document_id\)/);
  assert.match(migration, /p_payment_kind='pph23'[\s\S]*code='2132'/);
  assert.match(migration, /post_customs_broker_canonical/);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION public\.calculate_finance_expense_payable/);
  assert.doesNotMatch(migration, /broker_reimbursement_line_total|broker_reimbursement_expense_base/);
});

test('multiple allocations retain separate payment journals and approved edits do not repoint them', () => {
  assert.match(migration, /reference_number[\s\S]*'EXP-PAY-'\|\|v_allocation_id::text/);
  assert.match(migration, /SET allocation_amount=allocation_amount/);
  const editGuard = migration.slice(migration.indexOf('-- Allocation rows retain'), migration.indexOf('CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal'));
  assert.match(editGuard, /v_definition:=regexp_replace[\s\S]*journal_entry_id=v_journal_id/);
  assert.match(editGuard, /allocation_amount=allocation_amount/);
  assert.match(editGuard, /Approved expense edit still repoints payment journals/);
});

test('unlink reverses the payment event and keeps posted audit history', () => {
  assert.match(migration, /source_module='expense_payment'/);
  assert.match(migration, /'expense_payment_reversal'/);
  assert.match(migration, /SET is_reversed=true,reversed_by_id=v_reversal_id/);
  assert.match(migration, /PERFORM public\.recalculate_expense_payment_state\(v_a\.document_id\)/);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_entries/);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_entry_lines/);
});

test('pending expenses and unsupported cross-currency direct payments stay protected', () => {
  assert.match(migration, /approval_status <> 'approved'/);
  assert.match(migration, /must be approved before bank allocation/);
  assert.match(migration, /use Payment Voucher for cross-currency payment/);
});

test('migration contains no historical data repair', () => {
  assert.doesNotMatch(migration, /EXP\/26-26\/139|EXP\/26\/177/);
  assert.doesNotMatch(migration, /historical_repair_commands/);
  assert.doesNotMatch(migration, /UPDATE\s+public\.bank_statement_lines\s+SET\s+(?:debit_amount|credit_amount)/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.finance_expenses\s+SET\s+(?:amount|paid_amount)/i);
});
