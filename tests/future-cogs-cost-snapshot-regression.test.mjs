import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/migrations/20260905200000_add_future_cogs_snapshots.sql', 'utf8'
);

test('future COGS snapshots are nullable and forward-only', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS cogs_unit_cost numeric\(15,2\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS cogs_total_cost numeric\(15,2\)/);
  assert.doesNotMatch(migration, /UPDATE public\.sales_invoice_items[\s\S]*WHERE[\s\S]*cogs_unit_cost IS NULL[\s\S]*FROM/);
});

test('COGS posting snapshots the exact existing effective cost and line total', () => {
  assert.match(migration, /COALESCE\(NULLIF\(b\.landed_cost_per_unit, 0\),\s*NULLIF\(b\.import_price, 0\),\s*NULLIF\(b\.cost_per_unit, 0\), 0\)/);
  assert.match(migration, /v_snapshot_unit_costs := array_append\(v_snapshot_unit_costs, v_item\.effective_cost\)/);
  assert.match(migration, /v_snapshot_total_costs := array_append\(v_snapshot_total_costs,[\s\S]*ROUND\(COALESCE\(v_item\.quantity, 0\) \* v_item\.effective_cost, 2\)/);
  assert.match(migration, /v_total_cogs := v_total_cogs \+ \(COALESCE\(v_item\.quantity, 0\) \* v_item\.effective_cost\)/);
});

test('batch revaluation after posting cannot rewrite the prior cost snapshot or COGS journal', () => {
  const postCogs = (line, effectiveBatchCost, existingJournal = null) => {
    if (existingJournal) return existingJournal;
    line.cogs_unit_cost = effectiveBatchCost;
    line.cogs_total_cost = line.quantity * effectiveBatchCost;
    return { total_debit: line.cogs_total_cost, total_credit: line.cogs_total_cost };
  };

  const postedLine = { quantity: 3, cogs_unit_cost: null, cogs_total_cost: null };
  const postedJournal = postCogs(postedLine, 100);
  const replenishedBatchUnitCost = 150;
  postCogs(postedLine, replenishedBatchUnitCost, postedJournal);

  assert.equal(postedLine.cogs_unit_cost, 100);
  assert.equal(postedLine.cogs_total_cost, 3 * 100);
  assert.equal(postedJournal.total_debit, 300);
  assert.equal(replenishedBatchUnitCost, 150);
  assert.notEqual(postedLine.cogs_unit_cost, replenishedBatchUnitCost);

  assert.match(migration, /BEGIN;/);
  assert.match(migration, /source_module = 'sales_invoice_cogs' AND reference_id = NEW\.id/);
  assert.match(migration, /IF v_existing_cogs_je_id IS NOT NULL THEN RETURN NEW; END IF;/);
  assert.match(migration, /IF v_total_cogs <= 0 THEN RETURN NEW; END IF;[\s\S]*UPDATE public\.sales_invoice_items sii[\s\S]*INSERT INTO public\.journal_entries/);
  assert.match(migration, /INSERT INTO public\.journal_entries/);
  assert.match(migration, /COMMIT;/);
  assert.doesNotMatch(migration, /UPDATE public\.batches|UPDATE public\.purchase_batch_cost_layers/);
});
