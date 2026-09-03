import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('migration 20260903180000 drops generated expressions and standardizes batch cost semantics', () => {
  const migration = fs.readFileSync(
    '/Users/Kunal/Documents/anzen-main/supabase/migrations/20260903180000_standardize_batch_cost_semantics.sql',
    'utf8'
  );

  // 1. Drops obsolete generated expressions
  assert.ok(migration.includes('ALTER TABLE public.batches ALTER COLUMN cost_per_unit DROP EXPRESSION IF EXISTS'));
  assert.ok(migration.includes('ALTER TABLE public.batches ALTER COLUMN import_price_per_unit DROP EXPRESSION IF EXISTS'));

  // 2. Reconciles local batches from purchase invoice item unit prices
  assert.ok(migration.includes('WHERE b.purchase_invoice_id = pi.id'));
  assert.ok(migration.includes('AND pii.product_id = b.product_id'));
  assert.ok(migration.includes('AND b.import_container_id IS NULL'));
  assert.ok(migration.includes('DFS/125120557'));
  assert.ok(migration.includes('PH25097020'));

  // 3. Updates effective_sales_cogs_unit_cost
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.effective_sales_cogs_unit_cost'));
  assert.ok(migration.includes('COALESCE('));
  assert.ok(migration.includes('NULLIF(b.landed_cost_per_unit, 0)'));
  assert.ok(migration.includes('NULLIF(b.import_price, 0)'));

  // 4. Updates save_batch_inventory_v1
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.save_batch_inventory_v1'));
  assert.ok(migration.includes('CASE WHEN v_is_local THEN v_unit_price ELSE 0 END'));

  // 5. Updates reallocate_container_costs
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.reallocate_container_costs'));

  // 6. Updates post_sales_invoice_cogs
  assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.post_sales_invoice_cogs'));
});
