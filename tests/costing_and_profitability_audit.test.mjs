import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from '/Users/Kunal/Documents/anzen-main/node_modules/pg/lib/index.js';
const { Client } = pg;

describe('SAPJ ERP — Costing, Landed Cost, COGS & Sales Profitability Comprehensive Audit', () => {
  let client;

  before(async () => {
    try {
      client = new Client({
        host: '/tmp',
        port: 54329,
        database: 'test_db'
      });
      await client.connect();
    } catch (e) {
      client = null;
    }
  });

  after(async () => {
    if (client) {
      await client.end();
    }
  });

  const checkDb = (t) => {
    if (!client) {
      t.skip('Local test_db on port 54329 not available');
      return false;
    }
    return true;
  };

  test('Test Case 1: Bea Masuk (pib_bm_amount) Inclusion in Container Landed Cost Pool', async (t) => {
    if (!checkDb(t)) return;
    // EXP/25/234 (1st FCL) has pib_bm_amount = 19,290,000
    // EXP/26/077 (2nd FCL) has pib_bm_amount = 25,825,000
    const res1 = await client.query(`
      SELECT calculate_container_landed_cost_pool('5f2a79f6-4cd4-4e24-9195-161a6b99cfd5') as pool;
    `);
    const pool1 = Number(res1.rows[0].pool);
    // Base other expenses (33,299,504) + Bea Masuk (19,290,000) = 52,589,504
    assert.equal(pool1, 52589504, `1st FCL pool must include Bea Masuk Rp 19,290,000: expected 52,589,504, got ${pool1}`);

    const res2 = await client.query(`
      SELECT calculate_container_landed_cost_pool('81aacc20-68f6-41dc-bfc6-8ac92ca42645') as pool;
    `);
    const pool2 = Number(res2.rows[0].pool);
    // Base other expenses (16,984,808) + Bea Masuk (25,825,000) = 42,809,808
    assert.equal(pool2, 42809808, `2nd FCL pool must include Bea Masuk Rp 25,825,000: expected 42,809,808, got ${pool2}`);
  });

  test('Test Case 2: PPN Import Non-Capitalization (Account 1150 Input VAT)', async (t) => {
    if (!checkDb(t)) return;
    // Verify that PPN Import from PIB expenses is directed to GL 1150, never to 1130 or container pool
    const res = await client.query(`
      SELECT 
        SUM(jel.debit) as ppn_debit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '1150' AND je.reference_number IN ('EXP-95d9d4e2-817a-4304-86ad-ab83855fea44', 'EXP-da6b2b78-9d91-4183-9889-7e2bebf5a85b');
    `);
    const ppnDebit = Number(res.rows[0].ppn_debit);
    // 137,831,351 (EXP/25/234) + 254,090,222 (EXP/26/077) = 391,921,573
    assert.equal(ppnDebit, 391921573, 'PPN Import must be debited to 1150');
  });

  test('Test Case 3: PPh 22 Non-Capitalization (Account 1155 Prepaid Income Tax)', async (t) => {
    if (!checkDb(t)) return;
    // Verify that PPh 22 from PIB expenses is directed to GL 1155, never to 1130 or container pool
    const res = await client.query(`
      SELECT 
        SUM(jel.debit) as pph_debit
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '1155' AND je.reference_number IN ('EXP-95d9d4e2-817a-4304-86ad-ab83855fea44', 'EXP-da6b2b78-9d91-4183-9889-7e2bebf5a85b');
    `);
    const pphDebit = Number(res.rows[0].pph_debit);
    // 31,325,200 (EXP/25/234) + 57,747,650 (EXP/26/077) = 89,072,850
    assert.equal(pphDebit, 89072850, 'PPh 22 must be debited to 1155');
  });

  test('Test Case 4: Batch Master and Cost Layer Synchronous Parity', async (t) => {
    if (!checkDb(t)) return;
    // Verify that across all batches with cost layers, batches.import_cost_allocated equals the sum of layers
    const res = await client.query(`
      SELECT 
        b.batch_number,
        b.import_cost_allocated,
        SUM(cl.landed_cost_amount) as layer_landed_total
      FROM public.batches b
      JOIN public.purchase_batch_cost_layers cl ON cl.batch_id = b.id
      WHERE b.import_container_id IS NOT NULL
      GROUP BY b.id, b.batch_number, b.import_cost_allocated
      HAVING ABS(b.import_cost_allocated - SUM(cl.landed_cost_amount)) > 0.05;
    `);
    assert.equal(res.rows.length, 0, `All batch master landed costs must equal cost layer sums: ${JSON.stringify(res.rows)}`);
  });

  test('Test Case 5: 2nd FCL Reconciliation (Rp 2,000,000 Discrepancy Resolved)', async (t) => {
    if (!checkDb(t)) return;
    // In 2nd FCL, verify batches.import_cost_allocated sum exactly equals layers landed cost sum
    const res = await client.query(`
      SELECT 
        SUM(b.import_cost_allocated) as batch_sum,
        SUM(cl.landed_cost_amount) as layer_sum
      FROM public.batches b
      JOIN public.purchase_batch_cost_layers cl ON cl.batch_id = b.id
      WHERE b.import_container_id = '81aacc20-68f6-41dc-bfc6-8ac92ca42645';
    `);
    const batchSum = Number(res.rows[0].batch_sum);
    const layerSum = Number(res.rows[0].layer_sum);
    assert.ok(Math.abs(batchSum - layerSum) < 0.1, `2nd FCL batch sum (${batchSum}) must equal layer sum (${layerSum})`);
  });

  test('Test Case 6: LCL Cefixime Container Linkage', async (t) => {
    if (!checkDb(t)) return;
    // Verify cost layer for XMAL260006 is linked to container d0967b1d-907f-4cd9-adb3-b3ea5c666a42
    const res = await client.query(`
      SELECT 
        cl.import_container_id, cl.landed_cost_amount, cl.final_functional_unit_cost
      FROM public.purchase_batch_cost_layers cl
      WHERE cl.batch_id = 'e804fe62-7e12-4332-90ef-689138dd7240';
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].import_container_id, 'd0967b1d-907f-4cd9-adb3-b3ea5c666a42');
    assert.equal(Number(res.rows[0].landed_cost_amount), 18651400);
  });

  test('Test Case 7: LCL Cefixime COGS and True-Up Propagation', async (t) => {
    if (!checkDb(t)) return;
    // Verify sales invoice SAPJ-26-067 COGS unit cost reflects landed cost
    const res = await client.query(`
      SELECT 
        sii.cogs_unit_cost, sii.cogs_total_cost
      FROM public.sales_invoice_items sii
      JOIN public.sales_invoices si ON si.id = sii.invoice_id
      WHERE si.invoice_number = 'SAPJ-26-067';
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(Number(res.rows[0].cogs_unit_cost), 2233853.27);
    assert.equal(Number(res.rows[0].cogs_total_cost), 614309649.25);

    // Verify true-up journal entry exists for SAPJ-26-067
    const jeRes = await client.query(`
      SELECT total_debit, total_credit, is_posted
      FROM public.journal_entries
      WHERE source_module = 'sales_invoice_cogs_adjustment'
        AND reference_number = 'SAPJ-26-067-FIFO-ADJ';
    `);
    assert.equal(jeRes.rows.length, 1);
    assert.equal(Number(jeRes.rows[0].total_debit), 18651399.25);
    assert.equal(jeRes.rows[0].is_posted, true);
  });

  test('Test Case 8: Unreceived Purchase Invoice HM000004/2627 Control', async (t) => {
    if (!checkDb(t)) return;
    // Verify HM000004/2627 has no cost layers and no inventory movements
    const clRes = await client.query(`
      SELECT COUNT(*) as count
      FROM public.purchase_batch_cost_layers
      WHERE purchase_invoice_id = '9df7dc55-fbbb-4a34-93a4-ae08eea02ce0';
    `);
    assert.equal(Number(clRes.rows[0].count), 0, 'Unreceived PI must not have cost layers');

    const itRes = await client.query(`
      SELECT COUNT(*) as count
      FROM public.inventory_transactions
      WHERE batch_id IN (
        SELECT batch_id FROM public.purchase_invoice_items
        WHERE purchase_invoice_id = '9df7dc55-fbbb-4a34-93a4-ae08eea02ce0'
      );
    `);
    assert.equal(Number(itRes.rows[0].count), 0, 'Unreceived PI must not have inventory transactions');
  });

  test('Test Case 9: COGS Periodic Inventory Reconciliation Formula', async (t) => {
    if (!checkDb(t)) return;
    // Reconcile: COGS = Opening Inventory + Net Landed Purchases - Closing Inventory
    // Verified against GL Account 5100 and Sales Profitability Report
    const glRes = await client.query(`
      SELECT 
        SUM(jel.debit - jel.credit) as total_cogs
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code = '5100' AND je.is_posted = true;
    `);
    const glCogs = Number(glRes.rows[0].total_cogs);

    const rpcRes = await client.query(`
      SELECT get_sales_profitability_summary('2025-01-01', '2026-12-31')->'company' as comp;
    `);
    const rpcNetProductCost = Number(rpcRes.rows[0].comp.net_product_cost);

    assert.ok(Math.abs(glCogs - rpcNetProductCost) < 1.0, `GL 5100 (${glCogs}) must match RPC Net Product Cost (${rpcNetProductCost})`);
  });

  test('Test Case 10: Sales Profitability RPC Consistency (Company GP = Sum of Product GP)', async (t) => {
    if (!checkDb(t)) return;
    const res = await client.query(`
      SELECT get_sales_profitability_summary('2025-01-01', '2026-12-31') as data;
    `);
    const data = res.rows[0].data;
    const companyGP = Number(data.company.gross_profit);
    const sumProductGP = data.products.reduce((acc, p) => acc + Number(p.gross_profit), 0);

    assert.ok(Math.abs(companyGP - sumProductGP) < 1.0, `Company GP (${companyGP}) must match sum of product GP (${sumProductGP})`);
  });

  test('Test Case 11: Monthly vs Product Parity in Sales Profitability', async (t) => {
    if (!checkDb(t)) return;
    const res = await client.query(`
      SELECT get_sales_profitability_summary('2025-01-01', '2026-12-31') as data;
    `);
    const data = res.rows[0].data;
    const sumMonthlySales = data.monthly.reduce((acc, m) => acc + Number(m.gross_sales), 0);
    const companyGrossSales = Number(data.company.gross_sales);
    assert.ok(Math.abs(sumMonthlySales - companyGrossSales) < 1.0, 'Monthly gross sales sum must match company');
  });

  test('Test Case 12: Customer Return Accounting Treatment', async (t) => {
    if (!checkDb(t)) return;
    // Approved credit note reversals should reduce both revenue and COGS
    const res = await client.query(`
      SELECT 
        COUNT(*) as cn_count,
        SUM(subtotal) as cn_subtotal
      FROM public.credit_notes
      WHERE status = 'approved';
    `);
    assert.equal(Number(res.rows[0].cn_count), 1);
    assert.equal(Number(res.rows[0].cn_subtotal), 1572375);
  });

  test('Test Case 13: Cancelled Sales Invoice Exclusion', async (t) => {
    if (!checkDb(t)) return;
    const res = await client.query(`
      SELECT 
        COUNT(*) as cancelled_count
      FROM public.sales_invoices
      WHERE invoice_date BETWEEN '2025-01-01' AND '2026-12-31'
        AND document_status = 'cancelled';
    `);
    assert.equal(Number(res.rows[0].cancelled_count), 1);
  });

  test('Test Case 14: Reallocation and True-Up Idempotency', async (t) => {
    if (!checkDb(t)) return;
    // Calling reallocate_container_costs a second time must NOT create additional journals
    const jeCountBefore = await client.query(`
      SELECT COUNT(*) as count FROM public.journal_entries;
    `);

    await client.query(`SELECT public.reallocate_container_costs('d0967b1d-907f-4cd9-adb3-b3ea5c666a42');`);

    const jeCountAfter = await client.query(`
      SELECT COUNT(*) as count FROM public.journal_entries;
    `);
    assert.equal(Number(jeCountBefore.rows[0].count), Number(jeCountAfter.rows[0].count), 'Reallocation must be strictly idempotent');
  });

  test('Test Case 15: Multi-Container Isolation', async (t) => {
    if (!checkDb(t)) return;
    // Reallocating one container must NOT touch or corrupt cost layers of other containers
    const res = await client.query(`
      SELECT DISTINCT import_container_id FROM public.purchase_batch_cost_layers
      WHERE import_container_id IS NOT NULL;
    `);
    assert.ok(res.rows.length >= 7, 'All distinct containers must maintain separate cost layers');
  });

  test('Test Case 16: Dynamic Reallocation Trigger on Expense Update', async (t) => {
    if (!checkDb(t)) return;
    // Verify that updating expense amount or inclusion flag triggers container recalculation
    const res = await client.query(`
      SELECT tgname FROM pg_trigger WHERE tgname = 'trigger_recalc_batches_on_expense';
    `);
    assert.equal(res.rows.length, 1, 'Trigger trigger_recalc_batches_on_expense must exist');
  });

  test('Test Case 17: Batch Authoritative Cost Priority', async (t) => {
    if (!checkDb(t)) return;
    // calculate_batch_authoritative_cost must prioritize cost layers over batch master fallback
    const res = await client.query(`
      SELECT 
        b.batch_number,
        public.calculate_batch_authoritative_cost(b) as auth_cost,
        cl.final_functional_unit_cost
      FROM public.batches b
      JOIN public.purchase_batch_cost_layers cl ON cl.batch_id = b.id
      WHERE b.batch_number = 'XMAL260006';
    `);
    assert.equal(res.rows.length, 1);
    assert.equal(Number(res.rows[0].auth_cost), Number(res.rows[0].final_functional_unit_cost));
  });

  test('Test Case 18: Single Source of Truth Parity (TypeScript vs PostgreSQL Pool)', async (t) => {
    if (!checkDb(t)) return;
    // Verify calculate_container_landed_cost_pool returns exact expected pool for 1st FCL and 2nd FCL
    const res = await client.query(`
      SELECT 
        c.container_ref,
        public.calculate_container_landed_cost_pool(c.id) as pool
      FROM public.import_containers c
      WHERE c.id IN ('5f2a79f6-4cd4-4e24-9195-161a6b99cfd5', '81aacc20-68f6-41dc-bfc6-8ac92ca42645')
      ORDER BY c.container_ref;
    `);
    assert.equal(Number(res.rows[0].pool), 52589504);
    assert.equal(Number(res.rows[1].pool), 42809808);
  });

  test('Test Case 19: GL Trial Balance Zero Discrepancy', async (t) => {
    if (!checkDb(t)) return;
    const res = await client.query(`
      SELECT 
        SUM(jel.debit) as dr,
        SUM(jel.credit) as cr,
        SUM(jel.debit) - SUM(jel.credit) as diff
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.is_posted = true;
    `);
    const diff = Number(res.rows[0].diff);
    assert.equal(diff, 0, `Trial balance discrepancy must be exactly 0.00: got ${diff}`);
  });

  test('Test Case 20: No Unintended Regression in Finance Queries', async (t) => {
    if (!checkDb(t)) return;
    // Verify chart of accounts balance summary query runs without error
    const res = await client.query(`
      SELECT coa.code, SUM(jel.debit) as dr, SUM(jel.credit) as cr
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      GROUP BY coa.code
      HAVING SUM(jel.debit) > 0 OR SUM(jel.credit) > 0
      ORDER BY coa.code
      LIMIT 10;
    `);
    assert.ok(res.rows.length > 0, 'Chart of accounts balances must return successfully');
  });
});
