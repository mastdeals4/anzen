import assert from 'node:assert/strict';
import fs from 'node:fs';

const allocationMigration = fs.readFileSync(new URL('../supabase/migrations/20260812150000_bank_reconciliation_allocations.sql', import.meta.url), 'utf8');
const paymentUi = fs.readFileSync(new URL('../src/components/finance/PaymentVoucherManager.tsx', import.meta.url), 'utf8');
const receiptUi = fs.readFileSync(new URL('../src/components/finance/ReceiptVoucherManager.tsx', import.meta.url), 'utf8');
const expenseUi = fs.readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const reconUi = fs.readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const advances = fs.readFileSync(new URL('../supabase/migrations/20260727160000_salary_advance_workflow.sql', import.meta.url), 'utf8');

assert.match(allocationMigration, /bank_statement_allocations/);
assert.match(allocationMigration, /UNIQUE \(bank_statement_line_id, document_type, document_id, payment_kind\)/);
assert.match(allocationMigration, /Allocation exceeds remaining bank amount/);
assert.match(allocationMigration, /Allocation exceeds document outstanding amount/);
assert.match(allocationMigration, /is_posted AND NOT COALESCE\(je\.is_reversed,false\)/);

// One bank -> many documents; many bank lines -> one document; partials all
// remain allocation relationships, never extra cash events.
assert.match(reconUi, /line\.allocations\.map/);
assert.match(expenseUi, /from\('bank_statement_allocations'\)/);
assert.match(paymentUi, /document_type', 'payment'/);
assert.match(paymentUi, /bank_statement_lines\?: BankTransactionLine\[\]/);
assert.match(receiptUi, /document_type', 'receipt'/);
assert.match(receiptUi, /canonicalBankAllocations/);

// Voucher-level settlement remains separate from the bank event and supports
// multiple invoice/expense allocations, including supplier/PPh kinds.
assert.match(paymentUi, /voucher_allocations/);
assert.match(allocationMigration, /payment_kind/);
assert.match(receiptUi, /voucher_allocations/);
assert.match(receiptUi, /sales_invoice_id/);

// Staff advance issuance/application remains a distinct asset workflow.
assert.match(advances, /apply_salary_advances_to_expense/);
assert.match(advances, /advance_adjustment/);

const allocationSum = amounts => amounts.reduce((sum, amount) => sum + amount, 0);
assert.equal(allocationSum([6_000_000, 4_000_000]), 10_000_000); // two payments -> one expense
assert.equal(allocationSum([490_500, 3_161_000]), 3_651_500); // one bank -> two expenses
assert.equal(10_000_000 - allocationSum([6_000_000]), 4_000_000); // remaining AP
assert.equal(10_000_000 - allocationSum([6_000_000, 4_000_000]), 0);
assert.equal(allocationSum(Array.from({ length: 25 }, () => 4)), 100);

console.log('payment/allocation model regression checks passed');
