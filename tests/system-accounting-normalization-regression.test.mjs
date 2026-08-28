import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const expenseUi = readFileSync(new URL('../src/components/finance/ExpenseManager.tsx', import.meta.url), 'utf8');
const normalization = readFileSync(
  new URL('../supabase/migrations/20260830134000_normalize_current_expense_accounting_identity.sql', import.meta.url),
  'utf8',
);
const tax = readFileSync(
  new URL('../supabase/migrations/20260830133000_fix_pph_register_period_totals_status.sql', import.meta.url),
  'utf8',
);
const partyAndPettyCash = readFileSync(
  new URL('../supabase/migrations/20260830135000_normalize_party_and_petty_cash_resolution.sql', import.meta.url),
  'utf8',
);
const trialBalance = readFileSync(
  new URL('../supabase/migrations/20260830136000_normalize_effective_trial_balance.sql', import.meta.url),
  'utf8',
);

test('normal expense UI exposes business states and keeps audit mechanics out of actions', () => {
  assert.match(expenseUi, /s === 'REPLACED'[\s\S]*Approved · Active/);
  assert.match(expenseUi, /s === 'REVERSED'[\s\S]*Cancelled/);
  assert.doesNotMatch(expenseUi, /> Replaced</);
  assert.doesNotMatch(expenseUi, /Undo Historical/);
  assert.match(expenseUi, /effective_posting_state === 'REPLACED'[\s\S]*effective_posting_state === 'PENDING'/);
});

test('replacement paths are normalized without changing accounting amounts or dates', () => {
  assert.match(normalization, /effective_posting_state = 'REPLACED'/);
  assert.match(normalization, /SET source_module = 'expenses'/);
  assert.match(normalization, /SET journal_entry_id = n\.effective_journal_id/);
  assert.match(normalization, /source_module = 'expense_history'/);
  assert.doesNotMatch(normalization, /SET[\s\S]{0,80}(?:debit|credit|entry_date|amount)\s*=/i);
  assert.doesNotMatch(normalization, /DELETE FROM public\.(?:journal_entries|journal_entry_lines|finance_expenses)/i);
});

test('all tax surfaces consume the centralized canonical period resolver', () => {
  assert.match(tax, /CREATE OR REPLACE VIEW public\.vw_canonical_tax_period_amounts/);
  for (const view of ['vw_pph_by_period_type', 'vw_tax_period_status', 'vw_outstanding_tax', 'vw_monthly_tax_summary']) {
    assert.match(tax, new RegExp(`CREATE OR REPLACE VIEW public\\.${view}`));
  }
  assert.match(tax, /actual_paid AS paid_amount/);
  assert.doesNotMatch(tax, /fn_settled_import_pph22/);
});

test('party and petty-cash reconciliation fix identities without changing amounts', () => {
  assert.match(partyAndPettyCash, /si\.id = j\.reference_id OR si\.invoice_number = j\.reference_number/);
  assert.match(partyAndPettyCash, /SET customer_id = r\.customer_id/);
  assert.match(partyAndPettyCash, /CREATE OR REPLACE VIEW public\.missing_petty_cash_links/);
  assert.match(partyAndPettyCash, /historical_expense:%/);
  assert.doesNotMatch(partyAndPettyCash, /SET\s+(?:debit|credit|amount|entry_date)\s*=/i);
});

test('trial balance resolves only effective posted non-reversed journals', () => {
  assert.match(trialBalance, /CREATE OR REPLACE VIEW public\.trial_balance_view/);
  assert.match(trialBalance, /j\.is_posted = true/);
  assert.match(trialBalance, /NOT COALESCE\(j\.is_reversed, false\)/);
  assert.doesNotMatch(trialBalance, /UPDATE public\.(?:journal_entries|journal_entry_lines)/i);
});
