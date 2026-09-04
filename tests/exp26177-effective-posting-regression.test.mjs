import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase/migrations/20260905150000_register_exp26177_replacement.sql', import.meta.url), 'utf8');

test('explicit replacement metadata is authoritative and supports HR-REC replacements', () => {
  assert.match(sql, /expense_explicit_replacement_journals/);
  assert.match(sql, /replacement_journal_id/);
  assert.match(sql, /JE2609-0022/);
  assert.match(sql, /EXP\/26\/177/);
  assert.match(sql, /source_module NOT IN/);
});

test('registration is idempotent and does not alter accounting amounts', () => {
  assert.match(sql, /NOT EXISTS/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.(journal_entries|finance_expenses|bank_statement_allocations)/i);
});
