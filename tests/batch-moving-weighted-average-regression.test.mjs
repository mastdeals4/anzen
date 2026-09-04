import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync('supabase/migrations/20260905130000_enable_batch_moving_weighted_average.sql', 'utf8');

test('moving weighted average formula is batch-level and preserves zero-stock reset', () => {
  assert.match(sql, /prior_qty := GREATEST\(COALESCE\(b\.current_stock,0\) - p_received_quantity, 0\)/);
  assert.match(sql, /CASE WHEN prior_qty <= 0 THEN p_receipt_unit_cost/);
  assert.match(sql, /\(prior_qty \* prior_cost\) \+ \(p_received_quantity \* p_receipt_unit_cost\)/);
  const average = (q, c, n, nc) => q <= 0 ? nc : ((q * c) + (n * nc)) / (q + n);
  assert.equal(average(300, 100, 200, 160), 124);
  assert.equal(average(0, 999, 500, 177350), 177350);
});

test('receipt layers retain PI/FX/cost identity and container allocation is layer-quantity based', () => {
  assert.match(sql, /purchase_batch_cost_layers/);
  assert.match(sql, /import_container_id=p_container_id/);
  assert.match(sql, /pool \* l\.quantity \/ total_qty/);
  assert.doesNotMatch(sql, /batches\.import_quantity/);
  assert.match(sql, /final_functional_unit_cost/);
});

test('receiving hook does not create purchase journals and respects locked batches', () => {
  assert.match(sql, /apply_batch_receipt_weighted_average/);
  assert.match(sql, /COALESCE\(cost_locked,false\)=false/);
  assert.doesNotMatch(sql, /INSERT INTO public\.journal_entries/);
});
