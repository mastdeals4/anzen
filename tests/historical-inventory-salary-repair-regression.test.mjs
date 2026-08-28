import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../supabase/migrations/20260828100000_repair_cogs_inventory_salary_advance_history.sql', import.meta.url);
const inventoryPath = new URL('../src/pages/Inventory.tsx', import.meta.url);
const batchesPath = new URL('../src/pages/Batches.tsx', import.meta.url);

test('historical repair is evidence-gated and never writes physical stock', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /v_exact_count<>24 OR v_additive_count<>5 OR v_no_canonical_count<>1/);
  assert.match(sql, /v_bridge<>4106722840\.60/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.batches\s+SET\s+current_stock/is);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.inventory_transactions/is);
  assert.doesNotMatch(sql, /UPDATE\s+public\.sales_invoices/is);
});

test('salary advances use account 1160 and preserve canonical vouchers', async () => {
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /WHERE code='1160'/);
  assert.match(sql, /PV\/26-26\/006/);
  assert.match(sql, /PV\/26-26\/007/);
  assert.match(sql, /historical_salary_advance_repair/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.payment_vouchers/is);
});

test('inventory UI reads the certified effective ledger without hiding evidence', async () => {
  const [inventory, batches] = await Promise.all([
    readFile(inventoryPath, 'utf8'),
    readFile(batchesPath, 'utf8'),
  ]);
  assert.match(inventory, /from\('inventory_v1_effective_ledger'\)/);
  assert.match(inventory, /Historical Qty/);
  assert.match(inventory, /Evidence only/);
  assert.match(batches, /from\('inventory_v1_effective_ledger'\)/);
  assert.match(batches, /Historical evidence · 0 effective qty/);
});
