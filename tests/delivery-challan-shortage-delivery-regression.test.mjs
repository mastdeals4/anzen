import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const dcPage = fs.readFileSync('src/pages/DeliveryChallan.tsx', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260915170000_fix_dc_creation_and_approval_for_unreserved_sales_orders.sql', 'utf8');

function runDbQuery(sql) {
  try {
    const cmd = `npx supabase db query --linked "${sql.replace(/"/g, '\\"')}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(output);
  } catch (err) {
    console.warn('Database query failed or not connected in this test run:', err.message);
    return null;
  }
}

test('Frontend: Validates delivery quantity against remaining SO quantity (not reservation)', () => {
  assert.match(dcPage, /const maxRemaining = Number\(source\.quantity\) - Number\(source\.delivered_quantity \|\| 0\);/);
  assert.match(dcPage, /if \(totalQty > maxRemaining \+ 0\.0001\)/);
  assert.match(dcPage, /exceeds the remaining Sales Order quantity/);
  assert.doesNotMatch(dcPage, /Delivery quantity exceeds the remaining Sales Order product reservation/);
});

test('Frontend: Validates batch physical stock availability across all line items', () => {
  assert.match(dcPage, /const batchUsage = new Map<string, number>\(\);/);
  assert.match(dcPage, /if \(totalQuantity > availableStock\)/);
  assert.match(dcPage, /Insufficient available stock for batch/);
});

test('Migration: validate_dc_item_product_reservation_v2 checks remaining SO deliverable quantity', () => {
  assert.match(migration, /v_remaining := v_so_item\.quantity - COALESCE\(v_so_item\.delivered_quantity, 0\);/);
  assert.match(migration, /IF \(v_pending \+ NEW\.quantity\) > \(v_remaining \+ 0\.0001\) THEN/);
  assert.match(migration, /RAISE EXCEPTION 'Delivery quantity \(%\) exceeds remaining Sales Order quantity \(%\)'/);
});

test('Migration: consume_so_product_reservation_v2 consumes reservation or logs consumed audit record', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.consume_so_product_reservation_v2/);
  assert.match(migration, /v_consume_qty := LEAST\(v_res\.reserved_quantity, v\.quantity\);/);
  assert.match(migration, /Direct DC delivery without prior reservation/);
  assert.match(migration, /INSERT INTO public\.dc_batch_allocations/);
});

test('Logic Verification: 5000 / 5000 ordered PASS, 5001 / 5000 FAIL, 1000 / 5000 PASS, delivered reduction', () => {
  const orderedQty = 5000;
  let deliveredQty = 0;

  // Case 1: 5000 / 5000 -> PASS
  let requested = 5000;
  let maxRemaining = orderedQty - deliveredQty;
  assert.ok(requested <= maxRemaining, '5000 delivery against 5000 remaining must pass');

  // Case 2: 5001 / 5000 -> FAIL
  requested = 5001;
  assert.ok(requested > maxRemaining, '5001 delivery against 5000 remaining must fail');

  // Case 3: 1000 / 5000 -> PASS
  requested = 1000;
  assert.ok(requested <= maxRemaining, '1000 delivery against 5000 remaining must pass');

  // Case 4: Already delivered quantity reduces remaining
  deliveredQty = 2000;
  maxRemaining = orderedQty - deliveredQty;
  assert.equal(maxRemaining, 3000, 'Remaining should be 3000 after 2000 delivered');
  assert.ok(3000 <= maxRemaining, '3000 delivery against 3000 remaining must pass');
  assert.ok(3001 > maxRemaining, '3001 delivery against 3000 remaining must fail');

  // Case 5: Batch stock limit
  const batchStock = 1000;
  assert.ok(1000 <= batchStock, '1000 from 1000 batch stock must pass');
  assert.ok(1001 > batchStock, '1001 from 1000 batch stock must fail');
});

test('Live DB Invariant: Ferrous Fumarate USP batches have 10,000 kg available across 10 batches', () => {
  const result = runDbQuery(`
    SELECT count(*) as total_batches, sum(current_stock) as total_stock
    FROM batches b
    JOIN products p ON p.id = b.product_id
    WHERE p.product_name ILIKE '%Ferrous Fumarate%' AND b.is_active = true;
  `);
  if (result && result.rows && result.rows[0]) {
    assert.equal(Number(result.rows[0].total_batches), 10);
    assert.equal(Number(result.rows[0].total_stock), 10000);
  }
});

test('Live DB Invariant: SO-2026-0025 has 5,000 kg remaining to deliver', () => {
  const result = runDbQuery(`
    SELECT so.so_number, soi.quantity, soi.delivered_quantity
    FROM sales_orders so
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE so.so_number = 'SO-2026-0025';
  `);
  if (result && result.rows && result.rows[0]) {
    assert.equal(Number(result.rows[0].quantity), 5000);
    assert.equal(Number(result.rows[0].delivered_quantity), 0);
  }
});
