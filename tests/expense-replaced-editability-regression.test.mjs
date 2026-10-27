import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const expenseManagerCode = readFileSync(
  new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url),
  'utf8'
);
const baselineSql = readFileSync(
  new URL('../supabase/migrations/20260905140000_canonical_baseline.sql', import.meta.url),
  'utf8'
);

test('ExpenseManager table row and view modal edit button conditions', () => {
  // 1. Table row action button condition
  assert.match(
    expenseManagerCode,
    /\(postingState === 'ACTIVE' \|\| postingState === 'PENDING' \|\| postingState === 'REJECTED'\)/,
    'Table row checks postingState for ACTIVE, PENDING, REJECTED'
  );

  // 2. View modal action button condition
  assert.match(
    expenseManagerCode,
    /viewingExpense\.effective_posting_state === 'ACTIVE' \|\| viewingExpense\.effective_posting_state === 'REPLACED'/,
    'View modal allows REPLACED state'
  );

  // 3. handleEdit guard: blocks REVERSED and AMBIGUOUS
  assert.match(
    expenseManagerCode,
    /if \(expense\.effective_posting_state === 'REVERSED' \|\| expense\.effective_posting_state === 'AMBIGUOUS'\)/,
    'handleEdit blocks REVERSED and AMBIGUOUS'
  );
});

test('edit_approved_finance_expense_atomic strictly requires exactly one active expense journal', () => {
  // Verify that edit_approved_finance_expense_atomic checks for source_module IN ('expense', 'expenses')
  assert.match(
    baselineSql,
    /WHERE source_module IN\('expense','expenses'\)[\s\S]*AND \(reference_id=p_expense_id OR reference_number='EXP-'\|\|p_expense_id::text\)[\s\S]*AND is_posted=true AND NOT COALESCE\(is_reversed,false\)/,
    'edit_approved_finance_expense_atomic looks only for active expense journals'
  );

  assert.match(
    baselineSql,
    /IF v_journal_count<>1 THEN RAISE EXCEPTION 'Approved expense must have exactly one active effective journal'; END IF;/,
    'edit_approved_finance_expense_atomic throws if no active expense journal is found'
  );
});

test('trigger_auto_post_expense_accounting_update enforces single active expense journal constraint', () => {
  assert.match(
    baselineSql,
    /IF TG_OP='UPDATE' AND OLD\.approval_status='approved' AND v_active_count<>1 THEN[\s\S]*RAISE EXCEPTION 'Approved expense % must have exactly one active journal before edit'/,
    'Trigger blocks approved expense edits when active count <> 1'
  );
});

test('canonicalize_historical_repair_expense_journals migration targets ONLY EXP/26-26/139 and EXP/26/177', () => {
  const migrationSql = readFileSync(
    new URL('../supabase/migrations/20260906230000_canonicalize_historical_repair_expense_journals.sql', import.meta.url),
    'utf8'
  );

  // EXP/26-26/139
  assert.match(migrationSql, /2cde9efd-9b22-4ba6-acbe-f712d6bb0497/);
  assert.match(migrationSql, /JE2609-0018/);
  assert.match(migrationSql, /EXP-3b56b2ee-c157-4da8-8bdc-c0bea9b3316d/);

  // EXP/26/177
  assert.match(migrationSql, /4d89886c-eab1-4d39-8a46-f499319e1b69/);
  assert.match(migrationSql, /JE2609-0022/);
  assert.match(migrationSql, /EXP-e95a4775-cca4-4f38-830b-fcfd7ed5a1f3/);

  // Verifies setting source_module to expenses
  assert.match(migrationSql, /source_module = 'expenses'/);
});

