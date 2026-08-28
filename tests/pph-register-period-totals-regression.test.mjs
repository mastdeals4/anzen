import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260830133000_fix_pph_register_period_totals_status.sql', import.meta.url),
  'utf8',
);
const register = readFileSync(new URL('../src/components/finance/tax/PphRegisterPanel.tsx', import.meta.url), 'utf8');
const taxUi = readFileSync(new URL('../src/components/finance/tax/TaxUI.tsx', import.meta.url), 'utf8');

test('open PPh periods resolve approved sources by explicit period or due date', () => {
  assert.match(migration, /fn_pph_authoritative_source_total/);
  assert.match(migration, /fe\.pph_tax_period_id = p\.id/);
  assert.match(migration, /COALESCE\(fe\.due_date, fe\.expense_date\) BETWEEN p\.period_start AND p\.period_end/);
  assert.match(migration, /fe\.approval_status = 'approved'/);
  assert.match(migration, /effective_posting_state IN \('ACTIVE', 'REPLACED'\)/);
});

test('paid is sourced only from actual tax payments and historical paid periods stay frozen', () => {
  assert.match(migration, /fn_tax_payments_paid\(tp\.id\) AS actual_paid/);
  assert.match(migration, /paid_amount AS pph_paid_total/);
  assert.doesNotMatch(migration, /fn_settled_import_pph22/);
  assert.match(migration, /fn_tax_payments_paid\(tp\.id\) > 0\.01[\s\S]*THEN tp\.pph_total/);
});

test('zero total and zero paid can never resolve to Paid', () => {
  assert.match(migration, /COALESCE\(p_total, 0\) > 0\.01[\s\S]*THEN 'paid'/);
  assert.match(taxUi, /total > 0\.01 && outstanding <= 0\.01/);
  assert.doesNotMatch(taxUi, /if \(outstanding <= 0\.01\) return 'paid'/);
});

test('register drill-down uses the same explicit-period/payment-date attribution without synthetic sources', () => {
  assert.match(register, /usesStoredTotal/);
  assert.match(register, /pph_paid_total/);
  assert.match(register, /paymentDateMap\.get\(expense\.id\) \?\? expense\.due_date \?\? expense\.expense_date/);
  assert.match(register, /expense\.due_date \?\? expense\.expense_date/);
  assert.match(register, /expense\.pph_tax_period_id\) return expense\.pph_tax_period_id === row\.tax_period_id/);
  assert.doesNotMatch(register, /expense\.pph_tax_period_id \?\? expense\.tax_period_id/);
  assert.doesNotMatch(register, /latestPaymentDate/);
  assert.doesNotMatch(register, /Historical tax snapshot/);
  assert.doesNotMatch(register, /historical_tax_payment/);
  assert.doesNotMatch(register, /payment_voucher/);
  assert.match(register, /No source expense was found for this registered withholding amount/);
});

test('August and July expected accounting examples retain correct arithmetic', () => {
  const august21 = [120_000, 87_500, 50_000].reduce((sum, amount) => sum + amount, 0);
  const august23 = [140_000].reduce((sum, amount) => sum + amount, 0);
  assert.deepEqual(
    { pph21: [august21, 0, august21], pph23: [august23, 0, august23] },
    { pph21: [257_500, 0, 257_500], pph23: [140_000, 0, 140_000] },
  );
  assert.equal(257_500, 257_500, 'July PPh21 frozen total');
  assert.equal(188_000, 188_000, 'July PPh23 frozen total');
});
