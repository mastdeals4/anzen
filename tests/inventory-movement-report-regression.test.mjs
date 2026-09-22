#!/usr/bin/env node
/**
 * tests/inventory-movement-report-regression.test.mjs
 * 
 * Regression test for historical inventory movement reporting.
 * Verifies that public.inventory_v1_movement_report(p_date_from, p_date_to):
 * 1. Correctly reports MCC PH-101 (Opening 2000, In 0, Out 900, Closing 1100, Current Stock 0)
 * 2. Correctly reports MCC PH-102 (Opening 2000, In 0, Out 1000, Closing 1000, Current Stock 0)
 * 3. Incorporates all 14 legacy delivery challan products totaling 27,970 units
 * 4. Preserves database invariants (zero stock mutation, GL 1130, GL 5100, FIFO untouched)
 */

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

function runSql(sql) {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: '/Users/Kunal/Documents/anzen-main',
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
}

console.log('====================================================================');
console.log('REGRESSION TEST: INVENTORY MOVEMENT REPORTING');
console.log('====================================================================\n');

// 1. Run the report for 2026-01-01 to 2026-08-31
console.log('1. Executing public.inventory_v1_movement_report for 2026-01-01 to 2026-08-31...');
const rows = runSql(`
  SELECT * FROM public.inventory_v1_movement_report('2026-01-01'::date, '2026-08-31'::date);
`);
console.log(`   Retrieved ${rows.length} product rows.\n`);

const rowMap = new Map(rows.map(r => [r.product_code, r]));

// 2. Verify MCC PH-101 (PROD-0009)
console.log('2. Verifying MCC PH-101 (PROD-0009)...');
const ph101 = rowMap.get('PROD-0009');
assert(ph101, 'PROD-0009 must exist in report');
console.log('   Actual row:', {
  opening: ph101.opening,
  in: ph101.in_qty,
  out: ph101.out_qty,
  closing: ph101.closing,
  current_stock: ph101.current_stock
});
assert.equal(Number(ph101.opening), 2000, 'MCC PH-101 Opening must be 2000');
assert.equal(Number(ph101.in_qty), 0, 'MCC PH-101 In must be 0');
assert.equal(Number(ph101.out_qty), 900, 'MCC PH-101 Out must be 900');
assert.equal(Number(ph101.closing), 1100, 'MCC PH-101 Closing must be 1100');
assert.equal(Number(ph101.current_stock), 0, 'MCC PH-101 Current Stock must be 0');
console.log('   ✅ PASS: MCC PH-101 report matches required semantics.\n');

// 3. Verify MCC PH-102 (PROD-0010)
console.log('3. Verifying MCC PH-102 (PROD-0010)...');
const ph102 = rowMap.get('PROD-0010');
assert(ph102, 'PROD-0010 must exist in report');
console.log('   Actual row:', {
  opening: ph102.opening,
  in: ph102.in_qty,
  out: ph102.out_qty,
  closing: ph102.closing,
  current_stock: ph102.current_stock
});
assert.equal(Number(ph102.opening), 2000, 'MCC PH-102 Opening must be 2000');
assert.equal(Number(ph102.in_qty), 0, 'MCC PH-102 In must be 0');
assert.equal(Number(ph102.out_qty), 1000, 'MCC PH-102 Out must be 1000');
assert.equal(Number(ph102.closing), 1000, 'MCC PH-102 Closing must be 1000');
assert.equal(Number(ph102.current_stock), 0, 'MCC PH-102 Current Stock must be 0');
console.log('   ✅ PASS: MCC PH-102 report matches required semantics.\n');

// 4. Verify 14 Affected Products with Legacy Delivery Challans
console.log('4. Verifying the 14 affected products with legacy delivery_challans...');
const legacyDcs = runSql(`
  SELECT 
    p.product_code,
    p.product_name,
    count(it.id) as count,
    abs(sum(it.quantity)) as legacy_dc_out
  FROM inventory_transactions it
  CROSS JOIN inventory_engine_certification c
  JOIN products p ON p.id = it.product_id
  LEFT JOIN inventory_historical_movement_classifications h ON h.transaction_id = it.id
  WHERE it.created_at < c.enforcement_started_at
    AND it.transaction_type = 'delivery_challan'
    AND it.transaction_date BETWEEN '2026-01-01' AND '2026-08-31'
  GROUP BY p.product_code, p.product_name
  ORDER BY p.product_code;
`);

assert.equal(legacyDcs.length, 14, 'Must identify exactly 14 products with legacy delivery challans');
const totalLegacyDcQty = legacyDcs.reduce((s, r) => s + Number(r.legacy_dc_out), 0);
console.log(`   Found ${legacyDcs.length} products with legacy delivery challans totaling ${totalLegacyDcQty} units.`);
assert.equal(totalLegacyDcQty, 27970, 'Total omitted legacy DC outbound quantity must be exactly 27,970');

for (const p of legacyDcs) {
  const reportRow = rowMap.get(p.product_code);
  assert(reportRow, `Product ${p.product_code} must be present in movement report`);
  assert(Number(reportRow.out_qty) >= Number(p.legacy_dc_out), `Product ${p.product_code} Out must be at least legacy DC quantity`);
}
console.log('   ✅ PASS: All 14 legacy delivery challan products (27,970 units) are accounted for.\n');

// 5. Verify Database Invariants Remain Untouched
console.log('5. Verifying accounting & inventory invariants remain completely untouched...');

// GL 1130
const gl1130 = runSql(`
  SELECT ROUND(SUM(jel.debit - jel.credit), 2) as balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '1130' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
`)[0].balance;
assert.equal(Number(gl1130), 2178329160.75, 'GL 1130 invariant must remain Rp 2,178,329,160.75');

// GL 5100
const gl5100 = runSql(`
  SELECT ROUND(SUM(jel.debit - jel.credit), 2) as balance
  FROM journal_entry_lines jel
  JOIN journal_entries je ON je.id = jel.journal_entry_id
  JOIN chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '5100' AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
`)[0].balance;
assert.equal(Number(gl5100), 5751942819.75, 'GL 5100 invariant must remain Rp 5,751,942,819.75');

// Pure FIFO ending inventory
const fifoValuation = runSql(`
  SELECT ROUND(SUM(b.current_stock * pbcl.final_functional_unit_cost), 2) as valuation
  FROM batches b
  JOIN purchase_batch_cost_layers pbcl ON pbcl.batch_id = b.id
  WHERE b.is_active = true AND b.current_stock > 0;
`)[0].valuation;
assert.equal(Number(fifoValuation), 2228709083.60, 'FIFO valuation must remain Rp 2,228,709,083.60');

console.log(`   GL 1130 Active: Rp ${Number(gl1130).toLocaleString('id-ID')}`);
console.log(`   GL 5100 Active: Rp ${Number(gl5100).toLocaleString('id-ID')}`);
console.log(`   FIFO Valuation: Rp ${Number(fifoValuation).toLocaleString('id-ID')}`);
console.log('   ✅ PASS: All database balances, GL accounts, and FIFO layers are 100% UNCHANGED.\n');

console.log('====================================================================');
console.log('ALL INVENTORY MOVEMENT REGRESSION ASSERTIONS PASSED SUCCESSFULLY!');
console.log('====================================================================');
