import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const { Pool } = pg;

const PG_CONFIG = {
  host: process.env.PGHOST || '/tmp',
  port: 54329,
  database: 'test_sales_profitability_hotfix',
  user: process.env.USER || 'Kunal',
};

function runPsqlFile(filePath, db = 'test_sales_profitability_hotfix') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlCommand(sql, db = 'test_sales_profitability_hotfix') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Sales Profitability Hotfix & Expense Attribution Integrity', () => {
  let pool;
  let customerId;
  let productIdA;
  let productIdB;
  let batchIdA;
  let batchIdB;
  let challanId;
  let soId;
  let invoiceId;
  let cancelledInvoiceId;
  let creditNoteId;

  test.before(async () => {
    // 1. Reset database and run all migrations including the hotfix
    runPsqlCommand('DROP DATABASE IF EXISTS test_sales_profitability_hotfix;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_sales_profitability_hotfix;', 'postgres');

    const migrations = [
      'tests/fixtures/production-schema-baseline.sql',
      'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql',
      'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql',
      'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql',
      'supabase/migrations/20261030150000_complete_credit_note_and_sales_return_accounting.sql',
      'supabase/migrations/20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql',
      'supabase/migrations/20261030180000_sales_and_credit_note_final_completion.sql',
      'supabase/migrations/20261030190000_unified_party_settlement_and_voucher_upgrade.sql',
      'supabase/migrations/20261030200000_hotfix_sales_profitability_unallocated_expenses.sql'
    ];

    for (const mig of migrations) {
      runPsqlFile(path.join(rootDir, mig));
    }

    pool = new Pool(PG_CONFIG);

    // Verify baseline table has NO product_id column in finance_expenses
    const feCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'finance_expenses' AND column_name = 'product_id';
    `);
    assert.equal(feCols.rows.length, 0, 'finance_expenses MUST NOT have a product_id column');

    // 2. Setup Seed Data
    const custRes = await pool.query(`
      INSERT INTO public.customers (company_name) 
      VALUES ('PT SEJAHTERA ABADI') RETURNING id;
    `);
    customerId = custRes.rows[0].id;

    const prodResA = await pool.query(`
      INSERT INTO public.products (product_name, product_code, unit)
      VALUES ('Corn Starch Premium 25kg', 'CSP-25', 'kg') RETURNING id;
    `);
    productIdA = prodResA.rows[0].id;

    const prodResB = await pool.query(`
      INSERT INTO public.products (product_name, product_code, unit)
      VALUES ('Tapioca Starch Grade A', 'TSG-01', 'kg') RETURNING id;
    `);
    productIdB = prodResB.rows[0].id;

    const batchResA = await pool.query(`
      INSERT INTO public.batches (product_id, batch_number, current_stock, cost_per_unit, landed_cost_per_unit, is_active)
      VALUES ($1, 'BATCH-2026-A1', 10000, 8000, 8500, true) RETURNING id;
    `, [productIdA]);
    batchIdA = batchResA.rows[0].id;

    const batchResB = await pool.query(`
      INSERT INTO public.batches (product_id, batch_number, current_stock, cost_per_unit, landed_cost_per_unit, is_active)
      VALUES ($1, 'BATCH-2026-B1', 5000, 9000, 9500, true) RETURNING id;
    `, [productIdB]);
    batchIdB = batchResB.rows[0].id;

    const soRes = await pool.query(`
      INSERT INTO public.sales_orders (so_number, customer_id, order_date, total_amount, status)
      VALUES ('SO-2026-001', $1, '2026-06-15', 50000000, 'approved') RETURNING id;
    `, [customerId]);
    soId = soRes.rows[0].id;

    const dcRes = await pool.query(`
      INSERT INTO public.delivery_challans (challan_number, customer_id, sales_order_id, challan_date, approval_status)
      VALUES ('DC-2026-001', $1, $2, '2026-06-16', 'approved') RETURNING id;
    `, [customerId, soId]);
    challanId = dcRes.rows[0].id;

    const dciResA = await pool.query(`
      INSERT INTO public.delivery_challan_items (challan_id, product_id, batch_id, quantity)
      VALUES ($1, $2, $3, 2000) RETURNING id;
    `, [challanId, productIdA, batchIdA]);
    const dcItemIdA = dciResA.rows[0].id;

    // 3. Sales Invoice (Posted, 2000 kg @ Rp 12,000 = Rp 24,000,000)
    const invRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, sales_order_id, invoice_date, 
        subtotal, total_amount, document_status, is_draft
      )
      VALUES ('INV-2026-001', $1, $2, '2026-06-17', 24000000, 26640000, 'posted', false) RETURNING id;
    `, [customerId, soId]);
    invoiceId = invRes.rows[0].id;

    const siiResA = await pool.query(`
      INSERT INTO public.sales_invoice_items (
        invoice_id, delivery_challan_item_id, product_id, batch_id, quantity, unit_price
      )
      VALUES ($1, $2, $3, $4, 2000, 12000) RETURNING id;
    `, [invoiceId, dcItemIdA, productIdA, batchIdA]);
    const invItemIdA = siiResA.rows[0].id;

    // Authoritative COGS for the invoice line (2000 kg * 8500 = Rp 17,000,000)
    const jeRes = await pool.query(`
      INSERT INTO public.journal_entries (
        entry_number, entry_date, description, source_module, reference_id, is_posted
      )
      VALUES ('JE-COGS-001', '2026-06-17', 'COGS for INV-2026-001', 'sales_cogs', $1, true) RETURNING id;
    `, [invoiceId]);

    const cogsAccountId = (await pool.query(`SELECT id FROM chart_of_accounts WHERE code = '5100';`)).rows[0].id;
    const invAccountId = (await pool.query(`SELECT id FROM chart_of_accounts WHERE code = '1130';`)).rows[0].id;

    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit)
      VALUES ($1, $2, 17000000, 0), ($1, $3, 0, 17000000);
    `, [jeRes.rows[0].id, cogsAccountId, invAccountId]);

    // 4. Cancelled Invoice (Should be excluded from sales and tracked separately)
    const cancelRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, sales_order_id, invoice_date, 
        subtotal, total_amount, document_status, is_draft, notes
      )
      VALUES ('INV-2026-CANCELLED', $1, $2, '2026-06-20', 10000000, 11100000, 'cancelled', false, '[CANCELLED] Customer request') RETURNING id;
    `, [customerId, soId]);
    cancelledInvoiceId = cancelRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.sales_invoice_items (
        invoice_id, product_id, batch_id, quantity, unit_price
      )
      VALUES ($1, $2, $3, 1000, 10000);
    `, [cancelledInvoiceId, productIdA, batchIdA]);

    // 5. Approved Credit Note Return (Return 200 kg @ Rp 12,000 = Rp 2,400,000 revenue reduction, 200 * 8500 = Rp 1,700,000 COGS reversal)
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, original_invoice_id, customer_id, credit_note_date,
        subtotal, total_amount, status
      )
      VALUES ('CN-2026-001', $1, $2, '2026-06-25', 2400000, 2664000, 'approved') RETURNING id;
    `, [invoiceId, customerId]);
    creditNoteId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
      )
      VALUES ($1, $2, $3, $4, 200, 12000, 'saleable');
    `, [creditNoteId, invItemIdA, productIdA, batchIdA]);

    const jeCnRes = await pool.query(`
      INSERT INTO public.journal_entries (
        entry_number, entry_date, description, source_module, reference_id, is_posted
      )
      VALUES ('JE-CN-001', '2026-06-25', 'Credit Note COGS Reversal', 'credit_note_cogs', $1, true) RETURNING id;
    `, [creditNoteId]);

    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, debit, credit)
      VALUES ($1, $2, 1700000, 0), ($1, $3, 0, 1700000);
    `, [jeCnRes.rows[0].id, invAccountId, cogsAccountId]);

    // 6. Finance Expenses Setup:
    // a) DC-Allocated Sales Expense (Rp 500,000) - delivery_challan_id set
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, delivery_challan_id
      )
      VALUES ('2026-06-18', 'delivery_sales', 500000, 'approved', $1);
    `, [challanId]);

    // b) True Unallocated Sales Expense 1 (Rp 300,000) - general marketing
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, description
      )
      VALUES ('2026-06-19', 'marketing_advertising', 300000, 'approved', 'General digital marketing campaigns');
    `);

    // c) True Unallocated Sales Expense 2 (Rp 200,000) - sales distribution
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, description
      )
      VALUES ('2026-06-22', 'sales_distribution', 200000, 'approved', 'Distribution courier samples');
    `);

    // d) Unapproved sales expense (Rp 999,000) - MUST be excluded because pending_approval
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, description
      )
      VALUES ('2026-06-23', 'delivery_sales', 999000, 'pending_approval', 'Pending delivery slip');
    `);

    // e) Non-sales operations expense (Rp 4,000,000) - MUST be excluded from sales expenses
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, description
      )
      VALUES ('2026-06-24', 'office_admin', 4000000, 'approved', 'Office supplies');
    `);

    // f) Batch landed cost expense (Rp 1,500,000) - MUST be excluded from sales expenses (it belongs to landed cost/COGS)
    await pool.query(`
      INSERT INTO public.finance_expenses (
        expense_date, expense_category, amount, approval_status, batch_id, description
      )
      VALUES ('2026-06-10', 'delivery_sales', 1500000, 'approved', $1, 'Freight for inbound raw material batch');
    `, [batchIdA]);
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  test('1. get_sales_profitability_summary runs cleanly without fe.product_id error', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    assert.ok(res.rows.length === 1, 'Summary RPC must return one row');
    const data = res.rows[0].data;
    assert.ok(data.company, 'Data must have company summary');
    assert.ok(Array.isArray(data.products), 'Data must have products array');
    assert.ok(Array.isArray(data.monthly), 'Data must have monthly array');
  });

  test('2. Unallocated sales expenses calculation: exactly Rp 500,000 (300k marketing + 200k distribution)', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    const company = res.rows[0].data.company;
    
    // Expected unallocated = 300,000 + 200,000 = 500,000
    assert.equal(Number(company.unallocated_sales_expenses), 500000, 'Unallocated sales expenses must equal 500,000');
  });

  test('3. Allocated sales expenses are NOT double-counted in unallocated', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    const company = res.rows[0].data.company;
    const products = res.rows[0].data.products;

    // The DC expense of 500,000 is allocated to Product A
    const prodA = products.find(p => p.product_id === productIdA);
    assert.ok(prodA, 'Product A must be present in product list');
    assert.equal(Number(prodA.sales_expenses), 500000, 'Product A allocated sales expense must equal 500,000');

    // Total company sales expenses = allocated (500k) + unallocated (500k) = 1,000,000
    assert.equal(Number(company.sales_expenses), 1000000, 'Total company sales expenses must equal 1,000,000 (allocated + unallocated)');
  });

  test('4. Inbound batch landed costs and admin expenses are strictly excluded from sales expenses', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    const company = res.rows[0].data.company;

    // We inserted 1,500,000 batch expense and 4,000,000 admin expense and 999,000 pending expense
    // If any of these were incorrectly counted, total sales expenses would exceed 1,000,000
    assert.equal(Number(company.sales_expenses), 1000000, 'Batch, admin and pending expenses must not leak into sales expenses');
  });

  test('5. Cancelled invoices are strictly excluded from reportable sales and tracked in disclosure', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    const data = res.rows[0].data;
    const company = data.company;
    const cancelled = data.cancelled_invoices;

    // Gross sales should only include posted invoice (Rp 24,000,000), NOT cancelled invoice (Rp 10,000,000)
    assert.equal(Number(company.gross_sales), 24000000, 'Gross sales must be 24,000,000 (excluding cancelled invoice)');

    // Cancelled invoice disclosure must report 1 cancelled invoice of Rp 10,000,000 subtotal and Rp 11,100,000 total
    assert.equal(cancelled.count, 1, 'Cancelled invoice count must be 1');
    assert.equal(Number(cancelled.subtotal), 10000000, 'Cancelled subtotal must be 10,000,000');
    assert.equal(Number(cancelled.total_amount), 11100000, 'Cancelled total_amount must be 11,100,000');
    assert.equal(Number(cancelled.total_qty), 1000, 'Cancelled quantity must be 1000 kg');
  });

  test('6. Credit Note returns and COGS reversals reduce net sales and net product cost', async () => {
    const res = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-01-01'::date, '2026-12-31'::date) AS data;
    `);
    const company = res.rows[0].data.company;

    // Return revenue = Rp 2,400,000
    assert.equal(Number(company.sales_returns), 2400000, 'Sales returns must be 2,400,000');
    // Net sales = 24,000,000 - 2,400,000 = 21,600,000
    assert.equal(Number(company.net_sales), 21600000, 'Net sales must be 21,600,000');

    // Product cost (posted COGS) = 17,000,000
    assert.equal(Number(company.product_cost), 17000000, 'Gross product cost must be 17,000,000');
    // Return COGS reversal = 1,700,000
    assert.equal(Number(company.return_cogs), 1700000, 'Return COGS must be 1,700,000');
    // Net product cost = 17,000,000 - 1,700,000 = 15,300,000
    assert.equal(Number(company.net_product_cost), 15300000, 'Net product cost must be 15,300,000');

    // Gross profit = Net sales - Net product cost = 21,600,000 - 15,300,000 = 6,300,000
    assert.equal(Number(company.gross_profit), 6300000, 'Gross profit must be 6,300,000');

    // Net profit after sales expenses = 6,300,000 - 1,000,000 = 5,300,000
    assert.equal(Number(company.profit_after_sales_expenses), 5300000, 'Net profit after sales expenses must be 5,300,000');
    
    // Profit margin pct = 5,300,000 / 21,600,000 * 100 = 24.54%
    assert.equal(Number(company.profit_margin_pct), 24.54, 'Profit margin pct must be 24.54%');
  });

  test('7. Multiple date filter tests (empty range, single month, wide range)', async () => {
    // Empty range (2025)
    const resEmpty = await pool.query(`
      SELECT public.get_sales_profitability_summary('2025-01-01'::date, '2025-12-31'::date) AS data;
    `);
    const emptyComp = resEmpty.rows[0].data.company;
    assert.equal(Number(emptyComp.gross_sales), 0, '2025 gross sales must be 0');
    assert.equal(Number(emptyComp.sales_expenses), 0, '2025 sales expenses must be 0');
    assert.equal(Number(emptyComp.unallocated_sales_expenses), 0, '2025 unallocated expenses must be 0');

    // June 2026 only
    const resJune = await pool.query(`
      SELECT public.get_sales_profitability_summary('2026-06-01'::date, '2026-06-30'::date) AS data;
    `);
    const juneComp = resJune.rows[0].data.company;
    assert.equal(Number(juneComp.gross_sales), 24000000, 'June gross sales must be 24,000,000');
    assert.equal(Number(juneComp.sales_returns), 2400000, 'June sales returns must be 2,400,000');
    assert.equal(Number(juneComp.unallocated_sales_expenses), 500000, 'June unallocated sales expenses must be 500,000');
  });
});
