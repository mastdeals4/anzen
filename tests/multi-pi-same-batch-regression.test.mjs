import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('multi-PI same-batch receiving preserves physical identity and PI cost layers', () => {
  const sql = fs.readFileSync('/Users/Kunal/Documents/anzen-main/supabase/migrations/20260905100000_support_multi_pi_same_physical_batch.sql', 'utf8');
  assert.match(sql, /purchase_batch_cost_layers/);
  assert.match(sql, /UNIQUE \(product_id,batch_number\)/);
  assert.match(sql, /import_quantity=import_quantity\+p_received_quantity/);
  assert.match(sql, /post_inventory_movement/);
  assert.match(sql, /operation_id/);
  assert.match(sql, /functional_unit_cost/);
  assert.match(sql, /exchange_rate/);
  assert.match(sql, /Expiry date conflicts/);
  assert.doesNotMatch(sql, /UPDATE batches SET import_price=/);
  assert.doesNotMatch(sql, /UPDATE batches SET exchange_rate/);
});
