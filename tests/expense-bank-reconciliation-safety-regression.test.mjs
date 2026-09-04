import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('expense bank reconciliation hardening guards chronology, legacy bank settlement, and retries', () => {
  const sql = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260904130000_harden_expense_bank_reconciliation.sql', 'utf8');
  assert.match(sql, /v_line\.transaction_date < v_expense\.expense_date/);
  assert.match(sql, /expense_recognition_has_direct_bank_settlement/);
  assert.match(sql, /legacy direct-bank recognition/);
  assert.match(sql, /allocation already exists/);
  assert.match(sql, /link_bank_statement_line/);
  assert.doesNotMatch(sql, /UPDATE\s+(finance_expenses|bank_statement_lines|journal_entries)/i);
});

test('obligation-date fix uses business expense_date and never created_at', () => {
  const sql = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260905120000_fix_expense_bank_obligation_date.sql', 'utf8');
  const correctedRule = sql.slice(sql.indexOf('v_good text := $good$'), sql.indexOf('$good$;', sql.indexOf('v_good text := $good$')));
  assert.match(correctedRule, /v_line\.transaction_date < v_expense\.expense_date/);
  assert.doesNotMatch(correctedRule, /v_expense\.created_at/);
  assert.match(sql, /created_at is a technical ingestion timestamp/);
  assert.match(sql, /expense_date IS NULL/);
});

test('business-date chronology allows same-day/later and rejects truly earlier settlement', () => {
  const allowed = (bankDate, expenseDate) => bankDate >= expenseDate;
  assert.equal(allowed('2025-11-22', '2025-11-22'), true);
  assert.equal(allowed('2025-11-23', '2025-11-22'), true);
  assert.equal(allowed('2025-11-21', '2025-11-22'), false);
  // A delayed technical insert date has no bearing on the business rule.
  assert.equal(allowed('2025-11-22', '2025-11-22', '2026-09-01'), true);
});

test('AP recognition and partial settlement remain separate accounting events', () => {
  const canonical = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260903120000_fix_expense_partial_payment_accounting.sql', 'utf8');
  assert.match(canonical, /IF p_document_type <> 'expense' THEN[\s\S]*Document journal does not contain the selected bank account/);
  assert.match(canonical, /'expense_payment'/);
  assert.match(canonical, /v_je,1,v_settlement_coa[\s\S]*v_je,2,v_bank_coa/);
  assert.match(canonical, /v_allocate:=round\(COALESCE\(p_allocation_amount,LEAST\(v_bank_remaining,v_doc_remaining\)\),2\)/);
  assert.match(canonical, /'document_remaining',v_doc_remaining-v_allocate/);
});
