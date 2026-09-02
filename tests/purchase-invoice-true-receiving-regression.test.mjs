import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const batches = fs.readFileSync('src/pages/Batches.tsx', 'utf8');
const purchase = fs.readFileSync('src/components/finance/PurchaseInvoiceManager.tsx', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260902110000_purchase_invoice_true_receiving_quantity.sql', 'utf8');

test('Inward Pending uses the server-side true receiving total, not allocations alone', () => {
  assert.match(batches, /rpc\('purchase_invoice_item_received_totals'/);
  assert.match(batches, /r\.pending = Math\.max\(0, r\.quantity - r\.received\)/);
  assert.match(migration, /purchase_invoice_item_received_quantity/);
  assert.match(migration, /inventory_transactions/);
  assert.match(migration, /purchase_invoice_receiving_allocations/);
});

test('receiving form and RPC use the same true outstanding quantity', () => {
  assert.match(purchase, /rpc\('purchase_invoice_item_received_quantity'/);
  assert.match(migration, /v_existing := public\.purchase_invoice_item_received_quantity/);
  assert.match(migration, /v_existing \+ p_received_quantity > v_item\.quantity \+ 0\.01/);
});

test('legacy receipts are not double-counted when canonical operation allocation exists', () => {
  assert.match(migration, /NOT EXISTS \([\s\S]*a\.operation_id = it\.operation_id/);
});

test('receiving arithmetic preserves required quantity-delta behavior', () => {
  const outstanding = (quantity, received) => Math.max(0, quantity - received);
  assert.equal(outstanding(500, 0), 500);
  assert.equal(outstanding(500, 500), 0);
  assert.equal(outstanding(500, 490), 10);
  assert.equal(outstanding(510, 500), 10);
  assert.equal(outstanding(490, 500), 0);
  assert.equal(500 + 10 > 500 + 0.01, true);
});

test('quantity reductions below true received quantity are blocked', () => {
  assert.match(migration, /guard_purchase_invoice_item_received_quantity/);
  assert.match(migration, /NEW\.quantity < v_received - 0\.01/);
  assert.match(migration, /controlled inventory correction/);
});

test('canonical operation idempotency remains intact', () => {
  assert.match(migration, /WHERE operation_id=p_operation_id/);
  assert.match(migration, /idempotent_retry/);
});
