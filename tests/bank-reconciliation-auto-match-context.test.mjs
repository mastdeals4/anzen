import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20261024183000_improve_bank_auto_match_context.sql', import.meta.url),
  'utf8',
);
const ui = readFileSync(
  new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
  'utf8',
);

test('Auto-match includes purchase invoice and supplier context for Payment Vouchers', () => {
  assert.match(migration, /WHEN 'payment' THEN/);
  assert.match(migration, /public\.voucher_allocations va[\s\S]*?public\.purchase_invoices pi/);
  assert.match(migration, /pi\.invoice_number/);
  assert.match(migration, /pis\.company_name/);
  assert.match(migration, /pv\.reference_number/);
});

test('Auto-match includes salary advance staff identity', () => {
  assert.match(migration, /public\.finance_staff_master staff ON staff\.id = pv\.staff_id/);
  assert.match(migration, /staff\.full_name/);
});

test('Auto-match includes customer and sales invoice context for Receipt Vouchers', () => {
  assert.match(migration, /WHEN 'receipt' THEN/);
  assert.match(migration, /rv\.description/);
  assert.match(migration, /cu\.company_name/);
  assert.match(migration, /si\.invoice_number/);
  assert.match(migration, /ci\.company_name/);
});

test('Auto-match still requires correct bank, direction, date window, and near-exact amount', () => {
  assert.match(migration, /s\.bank_account_id = v_line\.bank_account_id/);
  assert.match(migration, /s\.direction = v_direction/);
  assert.match(migration, /abs\(v_line\.transaction_date - s\.settlement_date\) <= 7/);
  assert.match(migration, /abs\(c\.remaining_amount - v_bank_amount\) <= 1/);
});

test('Auto-match still refuses ambiguous multiple best candidates', () => {
  assert.match(migration, /IF v_candidate_count = 1 THEN/);
  assert.match(migration, /ELSIF v_candidate_count > 1 THEN[\s\S]*?v_skipped := v_skipped \+ 1/);
});

test('Auto-match remains available to authenticated finance users', () => {
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.auto_match_smart\(\) TO authenticated/);
});

test('Auto-Match is visible beside the bank reconciliation status filters', () => {
  const unmatchedFilter = ui.indexOf('✕ Unmatched ({stats.unmatched})');
  const autoMatchAction = ui.indexOf("{autoMatching ? 'Matching…' : 'Auto-Match'}");
  assert.ok(unmatchedFilter >= 0, 'Unmatched status filter should be present');
  assert.ok(autoMatchAction > unmatchedFilter, 'Auto-Match should be beside the visible status filters');
  assert.match(ui, /aria-label="Run bank transaction auto-match"/);
  assert.doesNotMatch(ui, /title="Auto-match"/, 'Old duplicate header Match control should be removed');
});
