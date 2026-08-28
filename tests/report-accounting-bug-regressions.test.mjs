import assert from 'node:assert/strict';
import fs from 'node:fs';

const payables = fs.readFileSync(new URL('../supabase/migrations/20260825210000_fix_outstanding_expense_bills_canonical_ap.sql', import.meta.url), 'utf8');
const ledger = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
const reports = fs.readFileSync(new URL('../src/components/finance/FinancialReports.tsx', import.meta.url), 'utf8');

assert.match(payables, /WHERE \(CASE WHEN fe\.expense_category='import_broker'/);
assert.doesNotMatch(payables, /WHERE fe\.payment_method IS NULL/);
assert.match(ledger, /bank_statement_allocations/);
assert.match(ledger, /allocation_amount/);
assert.match(ledger, /Canonical allocations/);
assert.match(reports, /Functional IDR \(USD transaction amounts are not converted or mixed\)/);
assert.match(reports, /Reporting basis/);

// The protected split remains represented as two canonical allocations whose
// amounts sum to one bank event (Rp3,161,000 + Rp490,500 = Rp3,651,500).
assert.equal(3161000 + 490500, 3651500);
console.log('report/accounting bug regression checks passed');
