import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile('supabase/migrations/20260830140000_set_based_canonical_tax_period_resolver.sql', 'utf8');
const ui = await readFile('src/components/finance/tax/TaxUI.tsx', 'utf8');
const calendar = await readFile('src/components/finance/tax/TaxCalendarPanel.tsx', 'utf8');
const centre = await readFile('src/components/finance/TaxComplianceCentre.tsx', 'utf8');

assert.match(sql, /WITH periods AS MATERIALIZED/);
assert.match(sql, /expense_pph AS/);
assert.match(sql, /voucher_pph AS/);
assert.match(sql, /paid AS/);
assert.match(sql, /CREATE OR REPLACE VIEW public\.vw_tax_period_status/);
assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_tax_payments_period_status_amount/);
assert.match(sql, /CASE WHEN coalesce\(pay\.amount,0\)>.01 OR p\.status IN \('paid','filed','closed'\)/);
assert.match(sql, /coalesce\(a\.due_date,a\.expense_date\)/);
assert.match(ui, /case 'overpaid':\s+return 'Overpaid'/);
assert.match(ui, /if \(paid > total \+ 0\.01\) return 'overpaid'/);
assert.match(calendar, /case 'overpaid'/);
assert.match(centre, /<FinancePage title="TAX COMPLIANCE">/);
assert.match(centre, /label: 'PPN'/);

console.log('tax compliance canonical resolver regression checks passed');

assert.match(sql, /greatest\(actual_paid-\(CASE WHEN tax_type='PPN'/);
assert.match(sql, /payment_status/);
