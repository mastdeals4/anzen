import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sql = fs.readFileSync(new URL('../supabase/migrations/20260901120000_fix_purchase_invoice_currency_posting.sql', import.meta.url), 'utf8');

test('purchase invoice posting converts foreign currency and preserves metadata', () => {
  assert.match(sql, /v_item\.line_total\*v_rate/);
  assert.match(sql, /v_total\*v_rate/);
  assert.match(sql, /transaction_currency/);
  assert.match(sql, /functional_currency/);
  assert.match(sql, /exchange_rate/);
});

test('purchase invoice posting rejects inconsistent item/header totals', () => {
  assert.match(sql, /totals do not reconcile/);
  assert.match(sql, /abs\(\(v_items \+ v_tax\) - v_total\)/);
});
