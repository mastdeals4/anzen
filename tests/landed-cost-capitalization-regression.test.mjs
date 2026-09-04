import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('landed-cost capitalization policy is shared and excludes tax categories', () => {
  const sql = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260904120000_unify_landed_cost_capitalization.sql', 'utf8');
  assert.match(sql, /is_capitalizable_landed_cost_category/);
  assert.match(sql, /calculate_container_landed_cost_pool/);
  assert.match(sql, /auto_post_expense_accounting/);
  assert.match(sql, /code=''1130''/);
  assert.doesNotMatch(sql, /'ppn_import'.*is_capitalizable/s);
  assert.doesNotMatch(sql, /'pph_import'.*is_capitalizable/s);
  assert.doesNotMatch(sql, /UPDATE\s+(finance_expenses|batches|journal_entries)/i);
});
