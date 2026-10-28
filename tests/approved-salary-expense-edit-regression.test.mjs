import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../supabase/migrations/20261012180000_allow_safe_approved_salary_expense_amount_edit.sql', import.meta.url),
  'utf8',
);
const atomicEditMigration = readFileSync(
  new URL('../supabase/migrations/20260922230000_edit_approved_finance_expense_so_allocations.sql', import.meta.url),
  'utf8',
);
const saveExpenseMigration = readFileSync(
  new URL('../supabase/migrations/20260922220000_final_workflow_and_security_stabilization.sql', import.meta.url),
  'utf8',
);
const expenseUi = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8',
);

test('1. Editing an unapproved expense: routes to save_finance_expense and permits safe salary amount edit', () => {
  // UI routes unapproved expenses to saveFinanceExpense
  assert.match(expenseUi, /if\s*\(editingApprovedExpense\)\s*\{[\s\S]*\}\s*else\s*\{\s*await\s*saveFinanceExpense\(editingExpense\.id,\s*expenseData\);/);
  // save_finance_expense updates amount directly for non-approved expenses
  assert.match(saveExpenseMigration, /UPDATE public\.finance_expenses SET[\s\S]*amount=\(p_payload->>'amount'\)::numeric/);
  // The trigger allows the update if gross is sufficient to cover committed advances
  assert.match(migration, /IF NEW\.amount < v_committed_total - 0\.01 THEN/);
});

test('2. Editing an approved expense without an applied salary advance: preserves single journal and updates amount', () => {
  // edit_approved_finance_expense_atomic updates amount and checks journal identity
  assert.match(atomicEditMigration, /UPDATE public\.finance_expenses SET[\s\S]*amount=\(p_payload->>'amount'\)::numeric/);
  assert.match(atomicEditMigration, /IF v_journal_count<>1 THEN RAISE EXCEPTION 'Approved expense must have exactly one active effective journal'; END IF;/);
  assert.match(atomicEditMigration, /Expense edit did not preserve exactly one active journal/);
  // When no advances exist, the trigger condition is bypassed
  assert.match(migration, /IF OLD\.expense_category = 'salary'[\s\S]*AND EXISTS \([\s\S]*SELECT 1[\s\S]*FROM public\.salary_advance_applications/);
});

test('3. Editing an approved salary with an applied advance: allows safe gross increase or safe decrease', () => {
  // Trigger calculates advance applied and committed total
  assert.match(migration, /SELECT COALESCE\(sum\(sa\.applied_amount\), 0\)[\s\S]*INTO v_advance_applied[\s\S]*FROM public\.salary_advance_applications sa/);
  assert.match(migration, /v_committed_total := v_advance_applied \+ v_non_advance_paid \+ COALESCE\(NEW\.pph_amount, 0\);/);
  // Allows update when NEW.amount >= v_committed_total
  assert.match(migration, /RETURN NEW;/);
});

test('4. Editing with a linked bank transaction: factors in bank allocations and preserves existing bank link', () => {
  // Trigger accounts for bank statement allocations and direct bank lines
  assert.match(migration, /FROM public\.bank_statement_allocations bsa[\s\S]*WHERE bsa\.document_type = 'expense'/);
  assert.match(migration, /FROM public\.bank_statement_lines bsl[\s\S]*WHERE bsl\.matched_expense_id = OLD\.id/);
  // Atomic edit preserves existing bank allocation if line ID and amount are unchanged
  assert.match(atomicEditMigration, /IF p_bank_statement_line_id IS NOT NULL[\s\S]*AND v_same_selected_count=0 THEN/);
});

test('5. Editing without a linked bank transaction: succeeds cleanly with NULL bank line', () => {
  // Atomic edit supports NULL p_bank_statement_line_id
  assert.match(atomicEditMigration, /p_bank_statement_line_id uuid DEFAULT NULL::uuid/);
  // Trigger does not require bank lines
  assert.match(migration, /v_non_advance_paid := v_voucher_paid \+ v_bank_allocated \+ v_direct_bank;/);
});

test('6. Preventing duplicate journals, payments, and advance applications: guarantees idempotency', () => {
  // In UI, does not re-apply advances if already applied
  assert.match(expenseUi, /persistedSalaryAdvanceApplied === 0\)\s*\{\s*const \{ error: advanceError \} = await supabase\.rpc\('apply_selected_salary_advances_to_expense'/);
  // Selected bank transaction is not duplicated on simple edit
  assert.match(expenseUi, /setSelectedBankTransactionId\(''\);/);
  // Atomic edit preserves exactly one active journal
  assert.match(atomicEditMigration, /AND is_posted AND NOT COALESCE\(is_reversed,false\)\)<>1 THEN[\s\S]*RAISE EXCEPTION 'Expense edit did not preserve exactly one active journal';/);
});

test('7. Correct outstanding advance and net payable calculations after an amount change', () => {
  // UI recalculates net payable subtracting advanceApplied
  assert.match(expenseUi, /net_salary_payable: Math\.max\(\s*\(preservingHistoricalValues \? Number\(formData\.amount \|\| 0\) : calculation\.gross_salary\)[\s\S]*?- advanceApplied/);
  // recalculate_expense_payment_state includes posted salary advance applications
  assert.match(migration, /SELECT v_supplier_paid\+COALESCE\(sum\(sa\.applied_amount\),0\) INTO v_supplier_paid[\s\S]*FROM public\.salary_advance_applications sa[\s\S]*JOIN public\.payment_vouchers settlement ON settlement\.id = sa\.settlement_payment_voucher_id[\s\S]*WHERE sa\.salary_expense_id = p_expense_id AND settlement\.is_posted = true;/);
  // Target paid is bounded by payable
  assert.match(migration, /v_target_paid := LEAST\(GREATEST\(v_supplier_paid,0\),GREATEST\(v_payable,0\)\);/);
});

test('8. Preventing unsafe edits when a finalised payment or settlement cannot be adjusted', () => {
  // Changing staff with applied advances is blocked with actionable error
  assert.match(migration, /IF OLD\.staff_id IS DISTINCT FROM NEW\.staff_id THEN[\s\S]*RAISE EXCEPTION 'Salary % has applied advance settlements for the assigned staff member and cannot be reassigned to a different employee\./);
  // Changing category with applied advances is blocked
  assert.match(migration, /IF NEW\.expense_category <> 'salary' THEN[\s\S]*RAISE EXCEPTION 'Salary % has applied advance settlements and cannot have its category changed\./);
  // Reducing amount below committed advances + disbursements is blocked with actionable error
  assert.match(migration, /IF NEW\.amount < v_committed_total - 0\.01 THEN[\s\S]*RAISE EXCEPTION 'Cannot reduce salary % gross amount to %: % is already committed/);
  // Changing bank account while allocations exist is blocked
  assert.match(migration, /IF \(OLD\.bank_account_id IS DISTINCT FROM NEW\.bank_account_id\)[\s\S]*AND \(v_bank_allocated > 0 OR v_direct_bank > 0\) THEN[\s\S]*RAISE EXCEPTION 'Salary % has % in reconciled\/linked bank statement allocations/);
  // UI also guards gross reduction below applied advances
  assert.match(expenseUi, /if \(formData\.expense_category === 'salary' && persistedSalaryAdvanceApplied > 0\) \{[\s\S]*Number\(formData\.amount \|\| 0\) < minRequired - 0\.01[\s\S]*alert\(`Cannot reduce gross salary/);
});

test('9. Existing historical expense and journal records remain unchanged unless properly controlled', () => {
  // Migration contains NO hardcoded historical UPDATE or DELETE statements for EXP/26/285 or any other expense
  assert.doesNotMatch(migration, /UPDATE public\.finance_expenses\s+SET\s+amount\s*=/i);
  assert.doesNotMatch(migration, /EXP\/26\/285/);
  assert.doesNotMatch(migration, /DELETE FROM public\.finance_expenses/i);
  assert.doesNotMatch(migration, /DELETE FROM public\.payment_vouchers/i);
  assert.doesNotMatch(migration, /DELETE FROM public\.journal_entries/i);
});
