import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(
  'supabase/migrations/20260829100000_reclassify_imron_salary_advance_ap_difference.sql',
  'utf8',
);

test('repair is evidence-gated to the exact Imron historical AP line', () => {
  assert.match(sql, /EXP\/26-26\/110/);
  assert.match(sql, /v_staff_id uuid := 'b115a6f0-dbc2-49b1-aad4-58136704eadf'/);
  assert.match(sql, /fe\.amount=500000/);
  assert.match(sql, /l\.account_id=v_ap AND l\.debit=0 AND l\.credit=500000/);
  assert.match(sql, /l\.supplier_id IS NULL/);
  assert.match(sql, /v_candidate_count <> 1/);
});

test('repair posts only AP-to-staff-advance reclassification and preserves source history', () => {
  assert.match(sql, /historical_salary_ap_reclassification/);
  assert.match(sql, /'debit_account','2110'/);
  assert.match(sql, /'credit_account','1160'/);
  assert.match(sql, /v_ap,'Remove legacy Imron salary-advance effect[\s\S]*500000,0/);
  assert.match(sql, /v_staff_advance,'Close Imron salary advance[\s\S]*0,500000/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.journal_entry_lines/is);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.(?:journal|payment_vouchers|bank_statement)/is);
});

test('repair does not touch bank statements, allocations, vouchers, or suppliers', () => {
  for (const forbidden of [
    'bank_statement_lines',
    'bank_statement_allocations',
    'payment_vouchers',
    'supplier_payables_view',
    'suppliers',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`(?:UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+public\\.${forbidden}`, 'i'));
  }
  assert.match(sql, /finance_historical_repair_items/);
  assert.match(sql, /audit_logs/);
});

test('repair is idempotent and expected balances move by exactly Rp500,000', () => {
  assert.match(sql, /v_existing_count = 1/);
  assert.match(sql, /ap_control_after',v_ap_credit-500000/);
  assert.match(sql, /credit_staff_advances',500000/);
  assert.match(sql, /records_repaired=1/);
  assert.match(sql, /v_ap_after-v_supplier_after/);
  assert.match(sql, /v_imron_after/);
  assert.match(sql, /supplier_subledger_after/);
  assert.match(sql, /imron_staff_advance_after/);
});
