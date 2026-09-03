import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync('supabase/migrations/20260904120000_fix_purchase_invoice_canonical_fx.sql', 'utf8');

test('canonical save validates foreign PI FX and converts functional amounts once', () => {
  assert.match(sql, /v_currency = ''IDR'' THEN 1 ELSE NULLIF/);
  assert.match(sql, /v_rate IS NULL OR v_rate <= 1/);
  assert.match(sql, /v_total_amount \* v_rate/);
  assert.match(sql, /v_line_total \* v_rate/);
  assert.match(sql, /transaction_debit=CASE WHEN debit>0 THEN round\(debit \/ v_rate/);
});

test('wrapper duplicate USD conversion is removed and transaction metadata is preserved', () => {
  assert.match(sql, /wrapper previously multiplied journals after save/);
  assert.match(sql, /d:=replace\(d,old,''\)/);
});
