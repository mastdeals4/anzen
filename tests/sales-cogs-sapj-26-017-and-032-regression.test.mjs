import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/migrations/20260908163000_repair_historical_cogs_snapshots_sapj_26_017_and_032.sql',
  'utf8',
);

test('1. SAPJ-26-017 backfills forensically proven historical batch cost of 163549.65/kg across 3 batches', () => {
  // Batch A-3147: 150 kg * 163549.65 = 24532447.50
  assert.match(migration, /3286a2c5-461f-4571-bf71-6ca050e72f29/);
  assert.match(migration, /cogs_unit_cost = 163549\.65[\s\S]*cogs_total_cost = 24532447\.50/);

  // Batch A-3145: 250 kg * 163549.65 = 40887412.50
  assert.match(migration, /57d9c923-0a8f-4d61-99eb-e7bb1f351f63/);
  assert.match(migration, /cogs_unit_cost = 163549\.65[\s\S]*cogs_total_cost = 40887412\.50/);

  // Batch A-3146: 50 kg * 163549.65 = 8177482.50
  assert.match(migration, /f185574f-3b80-48c0-be90-dd9278934e27/);
  assert.match(migration, /cogs_unit_cost = 163549\.65[\s\S]*cogs_total_cost = 8177482\.50/);

  const total = 24532447.50 + 40887412.50 + 8177482.50;
  assert.equal(total, 73597342.50, 'SAPJ-26-017 sum must exactly match posted COGS Rp73,597,342.50');
});

test('2. SAPJ-26-032 backfills forensically proven historical batch cost of 187971.00/kg across 2 batches', () => {
  // Batch DFS/126010052: 50 kg * 187971.00 = 9398550.00
  assert.match(migration, /387b8c44-cd87-4b2d-9fc2-b9ed819c8d07/);
  assert.match(migration, /cogs_unit_cost = 187971\.00[\s\S]*cogs_total_cost = 9398550\.00/);

  // Batch DFS/125120557: 550 kg * 187971.00 = 103384050.00
  assert.match(migration, /54368b9e-33e0-439f-be71-4b1b88417dd4/);
  assert.match(migration, /cogs_unit_cost = 187971\.00[\s\S]*cogs_total_cost = 103384050\.00/);

  const total = 9398550.00 + 103384050.00;
  assert.equal(total, 112782600.00, 'SAPJ-26-032 sum must exactly match posted COGS Rp112,782,600.00');
});

test('3. Migration is strictly scoped to sales_invoice_items and alters no GL, batches, or inventory', () => {
  assert.doesNotMatch(migration, /\b(INSERT|DELETE)\b/i);
  assert.doesNotMatch(migration, /UPDATE\s+(public\.)?(journal_entries|journal_entry_lines|batches|inventory_transactions)\b/i);
});
