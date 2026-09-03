import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20260903170000_restore_so_shortage_import_workflow.sql', 'utf8');
const salesOrders = fs.readFileSync('src/pages/SalesOrders.tsx', 'utf8');

test('reconcile_so_product_reservation_v2 handles shortage without raising fatal exception', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reconcile_so_product_reservation_v2/);
  assert.match(migration, /v_grant := LEAST\(v_required, GREATEST\(COALESCE\(v_atp, 0\), 0\)\);/);
  assert.match(migration, /'shortage'/);
  assert.doesNotMatch(migration, /RAISE EXCEPTION 'Insufficient product ATP/);
});

test('approve_sales_order_product_reservation_v2 sets shortage and creates import requirements', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.approve_sales_order_product_reservation_v2/);
  assert.match(migration, /RETURNS TABLE\(success boolean, message text, shortage_items jsonb\)/);
  assert.match(migration, /UPDATE public\.sales_orders\s+SET status = 'shortage'/);
  assert.match(migration, /PERFORM public\.fn_create_import_requirements\(p_so_id, v_shortage_list\);/);
  assert.match(migration, /RETURN QUERY\s+SELECT false, 'Partial stock reserved - shortage exists\.'::text, v_shortage_list;/);
  assert.match(migration, /UPDATE public\.sales_orders\s+SET status = 'stock_reserved'/);
});

test('fn_auto_rereserve_on_batch_arrival fulfills shortage orders upon batch arrival', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.fn_auto_rereserve_on_batch_arrival\(\)/);
  assert.match(migration, /so\.status::text = 'shortage'/);
  assert.match(migration, /approve_sales_order_product_reservation_v2\(v_so_id, NULL\)/);
});

test('SalesOrders frontend handles shortage warning and import requirements message', () => {
  assert.match(salesOrders, /approve_sales_order_product_reservation_v2/);
  assert.match(salesOrders, /Order approved with stock shortage/);
  assert.match(salesOrders, /Import requirements have been created automatically/);
});
