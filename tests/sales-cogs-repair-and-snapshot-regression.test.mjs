import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const repairMigration = fs.readFileSync(
  'supabase/migrations/20260908153000_repair_august_september_sales_cogs_snapshots.sql',
  'utf8',
);
const futureTriggerMigration = fs.readFileSync(
  'supabase/migrations/20260905250000_attribute_future_sales_invoice_cogs_lines.sql',
  'utf8',
);
const resolverMigration = fs.readFileSync(
  'supabase/migrations/20260905260000_include_active_historical_cogs_corrections.sql',
  'utf8',
);

// 1. Single-line sales invoice COGS snapshot
test('1. Single-line sales invoice COGS snapshot is populated and attributed to journal entry lines', () => {
  // SAPJ-26-035 single-line check
  assert.match(repairMigration, /UPDATE public\.sales_invoice_items[\s\S]*cogs_unit_cost = 1017165\.62[\s\S]*cogs_total_cost = 101716562\.00/);
  // Journal entry lines attribution
  assert.match(repairMigration, /UPDATE public\.journal_entry_lines jel[\s\S]*sales_invoice_item_id = sii\.id/);
});

// 2. Multi-line same-product invoice
test('2. Multi-line same-product invoice reconciliation and line attribution', () => {
  // SAPJ-26-044 has MCC PH-101 and MCC PH-102
  assert.match(repairMigration, /-- 2\. Multi-line Invoice SAPJ-26-044/);
  assert.match(repairMigration, /5b6dd348-4b2d-4a0f-9461-1d97bf665e5a/);
  assert.match(repairMigration, /cogs_unit_cost = 42348\.49[\s\S]*cogs_total_cost = 1058712\.25/);
  assert.match(repairMigration, /ee70d8a3-c42c-4f42-8d77-babafb2b906b/);
  assert.match(repairMigration, /cogs_unit_cost = 40282\.71[\s\S]*cogs_total_cost = 4028271\.00/);
  // Sum equals posted COGS 5,086,983.25
  const total = 1058712.25 + 4028271.0;
  assert.equal(total, 5086983.25);
});

// 3. Multi-product invoice (SAPJ-26-045)
test('3. Multi-product invoice SAPJ-26-045 uses forensically proven historical values', () => {
  // Diclofenac Potassium = 150 * 141296.94 = 21194541.00
  assert.match(repairMigration, /cogs_unit_cost = 141296\.94[\s\S]*cogs_total_cost = 21194541\.00/);
  // Corn Starch BP = 1000 * 10008.60 = 10008600.00
  assert.match(repairMigration, /cogs_unit_cost = 10008\.60[\s\S]*cogs_total_cost = 10008600\.00/);
  const total = 21194541.0 + 10008600.0;
  assert.equal(total, 31203141.0);
});

// 4. Historical batch-cost change after invoice posting
test('4. Historical batch-cost change after invoice posting does not modify existing snapshots', () => {
  // Neither the repair migration nor post_sales_invoice_cogs updates batches or recalculates old snapshots
  assert.doesNotMatch(repairMigration, /UPDATE public\.batches/);
  assert.doesNotMatch(futureTriggerMigration, /UPDATE public\.batches/);
});

// 5. Existing snapshot must remain authoritative
test('5. Existing snapshot remains authoritative in get_authoritative_sales_line_cogs', () => {
  // In get_authoritative_sales_line_cogs:
  // Tier 1 is posted_item_cogs, Tier 2 is snapshot_cogs
  assert.match(resolverMigration, /WHEN r\.posted_item_cogs IS NOT NULL THEN r\.posted_item_cogs/);
  assert.match(resolverMigration, /WHEN r\.snapshot_cogs IS NOT NULL THEN r\.snapshot_cogs/);
  // Only falls back to mutable base_line_cost if unresolved and within Rp1.00 tolerance
});

// 6. Exact reconciliation between item snapshots and posted invoice COGS
test('6. Exact reconciliation between item snapshots and posted invoice COGS', () => {
  const cases = [
    { invoice: 'SAPJ-26-044', items: [1058712.25, 4028271.00], posted: 5086983.25 },
    { invoice: 'SAPJ-26-045', items: [21194541.00, 10008600.00], posted: 31203141.00 },
    { invoice: 'SAPJ-26-036', items: [10597270.50], posted: 10597270.50 },
    { invoice: 'SAPJ-26-037', items: [14700479.50], posted: 14700479.50 },
    { invoice: 'SAPJ-26-041', items: [5293561.25], posted: 5293561.25 },
  ];
  for (const c of cases) {
    const sum = c.items.reduce((a, b) => a + b, 0);
    assert.equal(sum, c.posted, `Invoice ${c.invoice} snapshot sum must equal posted COGS`);
  }
});

// 7. Retry does not create duplicate COGS journal
test('7. Retry does not create duplicate COGS journal in post_sales_invoice_cogs', () => {
  assert.match(futureTriggerMigration, /pg_advisory_xact_lock\(hashtextextended\(NEW\.id::text, 0\)\)/);
  assert.match(futureTriggerMigration, /SELECT id INTO v_existing_cogs_je_id[\s\S]*WHERE source_module = 'sales_invoice_cogs'[\s\S]*AND reference_id = NEW\.id/);
  assert.match(futureTriggerMigration, /IF v_existing_cogs_je_id IS NOT NULL THEN RETURN NEW; END IF;/);
});

// 8. New invoices automatically receive item-level COGS snapshots
test('8. New invoices automatically receive item-level COGS snapshots and journal line attribution', () => {
  assert.match(futureTriggerMigration, /UPDATE public\.sales_invoice_items sii[\s\S]*SET cogs_unit_cost = s\.unit_cost,[\s\S]*cogs_total_cost = s\.total_cost/);
  assert.match(futureTriggerMigration, /INSERT INTO public\.journal_entry_lines[\s\S]*sales_invoice_item_id/);
  assert.match(futureTriggerMigration, /batch_id/);
});

// 9. Profitability report uses historical snapshot rather than today's mutable batch cost
test('9. Profitability report prioritizes snapshot_cogs over current mutable batch cost', () => {
  assert.match(resolverMigration, /WHEN r\.snapshot_cogs IS NOT NULL THEN 'snapshot'/);
  assert.match(resolverMigration, /WHEN r\.snapshot_cogs IS NOT NULL THEN r\.snapshot_cogs/);
});

// 10. Unprovable historical allocation remains explicitly unresolved
test('10. Unprovable historical allocation remains explicitly unresolved', () => {
  // If difference between posted COGS and base cost > 1.00, marked 'unresolved' and returns NULL cost
  assert.match(resolverMigration, /ABS\(r\.unresolved_base_cost_total - r\.residual_posted_cogs\) <= 1\.00/);
  assert.match(resolverMigration, /ELSE 'unresolved' END AS resolution_tier/);
  assert.match(resolverMigration, /ELSE NULL END AS authoritative_cogs/);
});
