import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260905110000_harden_multi_pi_receiving_allocations.sql', 'utf8');
const cogs = fs.readFileSync('supabase/migrations/20260903180000_standardize_batch_cost_semantics.sql', 'utf8');

test('partial receiving uses operation idempotency instead of item/batch uniqueness', () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS purchase_invoice_receiving_allocations_purchase_invoice_item_id_batch_id_status_key/);
  assert.match(migration, /operation_id uuid NOT NULL UNIQUE|WHERE operation_id = p_operation_id/);
  assert.match(migration, /Received quantity exceeds invoice line quantity/);
});

test('receipts preserve independent FX/cost/container layer metadata', () => {
  for (const field of ['currency', 'exchange_rate', 'functional_unit_cost', 'functional_total_cost', 'import_container_id']) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /purchase_batch_cost_layers/);
  assert.match(migration, /Container is a receipt\/layer attribute/);
});

test('current COGS remains batch-level until an approved costing policy exists', () => {
  assert.match(cogs, /FROM sales_invoice_items sii\s+LEFT JOIN batches b/);
  assert.doesNotMatch(cogs, /purchase_batch_cost_layers/);
});

test('physical batch validation remains product, manufacturer and expiry aware', () => {
  assert.match(migration, /v_batch\.product_id IS DISTINCT FROM v_item\.product_id/);
  assert.match(migration, /v_batch\.make_id IS NOT NULL AND v_batch\.make_id IS DISTINCT FROM v_make_id/);
  assert.match(migration, /Expiry date conflicts with existing physical batch/);
});
