import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('expense bank reconciliation hardening guards chronology, legacy bank settlement, and retries', () => {
  const sql = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260904130000_harden_expense_bank_reconciliation.sql', 'utf8');
  assert.match(sql, /v_line\.transaction_date < v_expense\.expense_date/);
  assert.match(sql, /v_line\.transaction_date < v_expense\.created_at::date/);
  assert.match(sql, /expense_recognition_has_direct_bank_settlement/);
  assert.match(sql, /legacy direct-bank recognition/);
  assert.match(sql, /allocation already exists/);
  assert.match(sql, /link_bank_statement_line/);
  assert.doesNotMatch(sql, /UPDATE\s+(finance_expenses|bank_statement_lines|journal_entries)/i);
});
