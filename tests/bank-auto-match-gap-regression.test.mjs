import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  new URL('../supabase/migrations/20260831210000_fix_bank_reconciliation_auto_match_gap.sql', import.meta.url),
  'utf8',
);
const reconciliationUi = fs.readFileSync(
  new URL('../src/components/finance/BankReconciliationEnhanced.tsx', import.meta.url),
  'utf8',
);

// Imports and the explicit Auto Match action must continue through the same
// post-insert RPC. The BEFORE trigger cannot create a canonical allocation.
assert.match(reconciliationUi, /rpc\('auto_match_smart'\)/);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.auto_match_bank_statement_line\(\)/);
assert.doesNotMatch(migration, /NEW\.matched_expense_id\s*:=/);

// Existing bank-leg documents (Payment/AP, Receipt/Sales, transfers, tax and
// already-bank-paid expenses) retain the canonical settlement-view path.
assert.match(migration, /FROM public\.vw_finance_document_settlements s/);
assert.match(migration, /PERFORM public\.link_bank_statement_line\(/);
assert.match(migration, /v_candidate->>'document_type'/);

// Directly recorded Expenses/CAP rows are AP recognition until the actual
// bank line is linked. Reuse the approved atomic edit command so Expense and
// Journal identities are retained and the canonical allocation is created.
assert.match(migration, /fe\.payment_method IS NULL/);
assert.match(migration, /fe\.bank_account_id IS NULL/);
assert.match(migration, /public\.calculate_finance_expense_payable\(fe\.id\)/);
assert.match(migration, /ic\.container_ref/);
assert.match(migration, /supplier\.company_name/);
assert.match(migration, /staff\.full_name/);
assert.match(migration, /PERFORM public\.edit_approved_finance_expense_atomic\(/);

// Amount, bank account, direction and date are gates, never enough by
// themselves. A document identifier or meaningful business-text evidence is
// mandatory, and equal best-tier candidates remain entirely unmatched.
assert.match(migration, /s\.bank_account_id = v_line\.bank_account_id/);
assert.match(migration, /s\.direction = v_direction/);
assert.match(migration, /abs\(v_line\.transaction_date - s\.settlement_date\) <= 7/);
assert.match(migration, /abs\(c\.remaining_amount - v_bank_amount\) <= 1/);
assert.match(migration, /finance_bank_match_text_score/);
assert.match(migration, /IF v_candidate_count = 1 THEN/);
assert.match(migration, /ELSIF v_candidate_count > 1 THEN[\s\S]*left fully unmatched/);
assert.doesNotMatch(migration, /v_amount\s*\*\s*0\.05/);

// Concurrency and duplicate-allocation guards are part of the matcher itself.
assert.match(migration, /FOR UPDATE SKIP LOCKED/);
assert.match(migration, /NOT EXISTS \([\s\S]*FROM public\.bank_statement_allocations/);

console.log('bank auto-match gap regression checks passed');
