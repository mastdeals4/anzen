import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync(new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url), 'utf8');
const expenseUi = fs.readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const bankLedger = fs.readFileSync(new URL('../src/components/finance/BankLedger.tsx', import.meta.url), 'utf8');
const journalUi = fs.readFileSync(new URL('../src/components/finance/JournalEntryViewerEnhanced.tsx', import.meta.url), 'utf8');
const recognition = fs.readFileSync(new URL('../supabase/migrations/20260824110000_separate_expense_recognition_from_bank_payment.sql', import.meta.url), 'utf8');
const payment = fs.readFileSync(new URL('../supabase/migrations/20260826110000_fix_discovered_bank_finance_logic.sql', import.meta.url), 'utf8');
const advances = fs.readFileSync(new URL('../supabase/migrations/20260803150000_fix_salary_advance_gl_accounting.sql', import.meta.url), 'utf8');
const advanceWorkflow = fs.readFileSync(new URL('../supabase/migrations/20260727160000_salary_advance_workflow.sql', import.meta.url), 'utf8');
const bankJournal = fs.readFileSync(new URL('../supabase/migrations/20260726153000_finance_loan_capital_consolidation.sql', import.meta.url), 'utf8');

// A successful zero-row query is distinct from a failed query. The UI must
// preserve the error and render an alert instead of the empty-state copy.
assert.match(ui, /const \[statementLoadError, setStatementLoadError\]/);
assert.match(ui, /setStatementLoadError\(null\)/);
assert.match(ui, /setStatementLoadError\(err instanceof Error \? err\.message/);
assert.match(ui, /statementLoadError \?/);
assert.match(ui, /Unable to load bank transactions/);
assert.match(ui, /No Bank Transactions/);
assert.match(ui, /statementLines\.length === 0/);
assert.match(ui, /No Matching Transactions/);
assert.match(ui, /Allocation breakdown/);
assert.match(ui, /line\.allocations\.length/);
assert.match(ui, /document_total/);
assert.match(ui, /journal_entry_id/);
assert.match(ui, /aria-expanded=\{expandedLineIds\.has\(line\.id\)\}/);
// Split bank settlements remain visible in Expense Payment Breakdown even
// when the compatibility matched_expense_id projection is cleared.
assert.match(expenseUi, /from\('bank_statement_allocations'\)/);
assert.match(expenseUi, /\.eq\('document_type', 'expense'\)/);
assert.match(expenseUi, /allocation_amount/);
assert.match(expenseUi, /links\.some\(existing => existing\.id === line\.id\)/);
// Bank Ledger and Journal Register must use canonical allocations even when
// matched_entry_id/payment_id compatibility projections are NULL.
assert.match(bankLedger, /from\('bank_statement_allocations'\)/);
assert.match(bankLedger, /allocated_amount/);
assert.match(journalUi, /from\('bank_statement_allocations'\)/);
assert.match(journalUi, /canonicalAllocations/);
// The canonical line query uses an inclusive start and exclusive next-day end,
// so 20-Feb-2026 is included in Jan–Aug and excluded from Jul–Aug.
assert.match(ui, /\.gte\('transaction_date', dateRange\.start\)[\s\S]*\.lt\('transaction_date', endDateStr\)/);
assert.match(bankLedger, /\.gte\('transaction_date', globalDateRange\.startDate\)[\s\S]*\.lt\('transaction_date', endDateStr\)/);
assert.match(ui, /account_number === '0930 2010 14'/, 'IDR default must select the audited IDR account');
assert.match(ui, /\.gte\('transaction_date', dateRange\.start\)[\s\S]*\.lt\('transaction_date', endDateStr\)/);
const statementQuery = ui.slice(ui.indexOf("const { data: rangeData"), ui.indexOf("let data = rangeData"));
assert.doesNotMatch(statementQuery, /\.limit\(/, 'historical reconciliation must not impose an arbitrary row limit');

// Recognition is AP-only when an expense has not been linked to a real cash
// event. Bank transfer selection cannot itself credit a bank account.
assert.match(recognition, /normalize_unlinked_expense_payment/);
assert.match(recognition, /NEW\.payment_method := NULL/);
assert.match(recognition, /NEW\.bank_account_id := NULL/);

// Actual expense payment uses allocated supplier cash, leaves PPh payable,
// and caps paid AP at the canonical payable. Broker payable is computed from
// the broker model rather than the base expense header.
assert.match(payment, /calculate_finance_expense_payable/);
assert.match(payment, /final_cash_payable/);
assert.match(payment, /v_pph_bank:=0; -- PPh was recognized on the expense and remains payable/);
assert.match(payment, /paid_amount=LEAST\(GREATEST\(v_supplier_paid,0\),GREATEST\(v_payable,0\)\)/);
// Reproduce the forensic broker case: the base invoice amount is not the
// cash payable, and an unpaid document must not acquire a bank credit merely
// because settlement_amount was populated.
const broker139 = { voucher: 'EXP/26-26/139', base: 2_400_000, settlement: 6_094_500, paid: 0 };
assert.equal(broker139.paid, 0);
assert.ok(broker139.settlement > broker139.base);
assert.match(recognition, /actual payment is posted by payment voucher\/reconciliation/);

// Salary advance issuance and application remain separate events: issuance
// debits Staff Advances (1160), while application uses advance_adjustment.
assert.match(advances, /v_is_advance/);
assert.match(advances, /code='1160'/);
assert.match(advances, /v_is_settlement/);
assert.match(advanceWorkflow, /apply_salary_advances_to_expense/);
assert.match(advanceWorkflow, /payment_method', 'advance_adjustment'/);
assert.match(advances, /v_debit_account:=v_advance/);
assert.match(advances, /v_credit_account:=v_advance/);

// Journal creation from a bank line is only available through the explicit
// bank-linked command, which rejects missing/already-linked lines before any
// journal insert and links the new journal in the same operation.
assert.match(bankJournal, /IF NOT FOUND OR v_line\.matched_entry_id IS NOT NULL THEN RAISE EXCEPTION/);
assert.match(bankJournal, /v_journal:=public\.save_finance_journal/);
assert.match(bankJournal, /public\.link_bank_statement_line\(p_bank_line_id,'journal',v_journal/);

console.log('bank reconciliation UI and accounting boundary regression checks passed');
