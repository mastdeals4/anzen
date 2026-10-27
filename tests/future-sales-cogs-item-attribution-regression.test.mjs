import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/20260905250000_attribute_future_sales_invoice_cogs_lines.sql', import.meta.url),
  'utf8',
);

function postItemLines(items) {
  return items.flatMap((item, index) => {
    const amount = Math.round(item.quantity * item.unitCost * 100) / 100;
    return [
      { line: index * 2 + 1, account: '5100', debit: amount, credit: 0, ...item },
      { line: index * 2 + 2, account: '1130', debit: 0, credit: amount, ...item },
    ];
  });
}

for (const [name, items] of [
  ['single-product/single-batch', [{ itemId: 'i1', productId: 'p1', batchId: 'b1', quantity: 2, unitCost: 125 }]],
  ['single-product/multiple-batch', [
    { itemId: 'i1', productId: 'p1', batchId: 'b1', quantity: 2, unitCost: 125 },
    { itemId: 'i2', productId: 'p1', batchId: 'b2', quantity: 3, unitCost: 140 },
  ]],
  ['multi-product/multiple-batch', [
    { itemId: 'i1', productId: 'p1', batchId: 'b1', quantity: 2, unitCost: 125 },
    { itemId: 'i2', productId: 'p2', batchId: 'b2', quantity: 3, unitCost: 140 },
    { itemId: 'i3', productId: 'p3', batchId: 'b3', quantity: 1.25, unitCost: 80.8 },
  ]],
  ['two-product/two-batch', [
    { itemId: 'i1', productId: 'p1', batchId: 'b1', quantity: 100, unitCost: 180000 },
    { itemId: 'i2', productId: 'p2', batchId: 'b2', quantity: 75, unitCost: 176250 },
  ]],
]) {
  test(`${name} produces balanced item-attributed COGS lines`, () => {
    const lines = postItemLines(items);
    assert.equal(lines.length, items.length * 2);
    assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), lines.reduce((sum, line) => sum + line.credit, 0));
    for (const item of items) {
      const attributed = lines.filter((line) => line.itemId === item.itemId);
      assert.equal(attributed.length, 2);
      assert.deepEqual(new Set(attributed.map((line) => line.batchId)), new Set([item.batchId]));
      assert.deepEqual(new Set(attributed.map((line) => line.account)), new Set(['5100', '1130']));
    }
  });
}

test('migration adds an auditable item reference without backfilling history', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS sales_invoice_item_id uuid/);
  assert.match(migration, /REFERENCES public\.sales_invoice_items\(id\) ON DELETE RESTRICT/);
  assert.match(migration, /idx_journal_entry_lines_sales_invoice_item_id/);
  assert.doesNotMatch(migration, /UPDATE public\.journal_entry_lines/i);
  assert.doesNotMatch(migration, /UPDATE public\.journal_entries/i);
});

test('posting preserves established eligibility, cost basis, snapshots, and retry idempotency', () => {
  assert.match(migration, /NEW\.journal_entry_id IS NULL/);
  assert.match(migration, /NEW\.payment_status NOT IN \('pending', 'partial', 'paid'\)/);
  assert.match(migration, /source_module = 'sales_invoice_cogs'[\s\S]*reference_id = NEW\.id/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(NEW\.id::text, 0\)\)/);
  assert.match(migration, /landed_cost_per_unit, 0[\s\S]*import_price, 0[\s\S]*cost_per_unit, 0/);
  assert.match(migration, /SET cogs_unit_cost = s\.unit_cost,[\s\S]*cogs_total_cost = s\.total_cost/);
});

test('both sides of each posting preserve item and batch attribution', () => {
  const attributedInserts = migration.match(/customer_id, batch_id, sales_invoice_item_id/g) ?? [];
  assert.equal(attributedInserts.length, 2);
  assert.match(migration, /v_cogs_account_id[\s\S]*v_item\.batch_id, v_item\.item_id/);
  assert.match(migration, /v_inventory_account_id[\s\S]*v_item\.batch_id, v_item\.item_id/);
  assert.match(migration, /v_total_cogs := v_total_cogs \+ ROUND/);
});

test('future drilldown prefers active posted item-level GL 5100 evidence', () => {
  assert.match(migration, /posted_item_cogs AS/);
  assert.match(migration, /jel\.sales_invoice_item_id AS line_id/);
  assert.match(migration, /coa\.code = '5100'/);
  assert.match(migration, /je\.is_posted = true/);
  assert.match(migration, /NOT COALESCE\(je\.is_reversed, false\)/);
  assert.match(migration, /WHEN r\.posted_item_cogs IS NOT NULL THEN r\.posted_item_cogs/);
  assert.match(migration, /'posted_item_cogs'/);
});
