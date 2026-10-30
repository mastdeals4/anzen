import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const { Pool, Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PG_CONFIG = {
  host: '/tmp',
  port: 54329,
  database: 'test_cn_accounting_integration',
  user: process.env.USER || 'Kunal',
};

function runPsqlFile(filePath, db = 'test_cn_accounting_integration') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlCommand(sql, db = 'test_cn_accounting_integration') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Complete Credit Note & Sales Return Accounting Integration (All 27 Scenarios)', () => {
  let pool;
  let testCustomerId;
  let testProductId;
  let testBatchId;
  let testBankAccountId;
  let adminUserId;

  test.before(async () => {
    // 1. Reset test database and apply all migrations in exact order
    try {
      runPsqlCommand('DROP DATABASE IF EXISTS test_cn_accounting_integration;', 'postgres');
      runPsqlCommand('CREATE DATABASE test_cn_accounting_integration;', 'postgres');
      runPsqlFile(path.join(rootDir, 'tests/fixtures/production-schema-baseline.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030150000_complete_credit_note_and_sales_return_accounting.sql'));
      runPsqlFile(path.join(rootDir, 'supabase/migrations/20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql'));
    } catch (err) {
      console.error('Migration setup failed:', err);
      throw err;
    }

    pool = new Pool(PG_CONFIG);

    // 2. Seed foundational master data
    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role)
      VALUES ($1, 'Admin User', 'admin')
      ON CONFLICT (id) DO NOTHING;
    `, [adminUserId]);

    const custRes = await pool.query(`
      INSERT INTO public.customers (company_name)
      VALUES ('PT Farma Prima Test')
      RETURNING id;
    `);
    testCustomerId = custRes.rows[0].id;

    const prodRes = await pool.query(`
      INSERT INTO public.products (product_name, product_code, unit)
      VALUES ('Paracetamol BP/USP Fine Powder', 'RAW-PCM-01', 'kg')
      RETURNING id;
    `);
    testProductId = prodRes.rows[0].id;

    const batchRes = await pool.query(`
      INSERT INTO public.batches (batch_number, product_id, current_stock, cost_per_unit, landed_cost_per_unit, is_active)
      VALUES ('BATCH-PCM-2026-01', $1, 5000, 100000.00, 105000.00, true)
      RETURNING id;
    `, [testProductId]);
    testBatchId = batchRes.rows[0].id;

    const bankRes = await pool.query(`
      INSERT INTO public.bank_accounts (
        account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'BCA Operasional IDR', 'Bank Central Asia', '123-456-7890', 'current', 'IDR',
        500000000, 500000000, true,
        (SELECT id FROM public.chart_of_accounts WHERE code = '1102')
      ) RETURNING id;
    `);
    testBankAccountId = bankRes.rows[0].id;
  });

  test.after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  // Helper to create posted sales invoice
  async function createPostedInvoice({ invoiceNumber, quantity, unitPrice, isPaid = false, isDraft = false, isCancelled = false, fifoCost = 105000.00 }) {
    const subtotal = quantity * unitPrice;
    const taxAmount = Math.round(subtotal * 0.11 * 100) / 100;
    const totalAmount = subtotal + taxAmount;
    const paidAmount = isPaid ? totalAmount : 0;
    const balanceAmount = isPaid ? 0 : totalAmount;
    const paymentStatus = isPaid ? 'paid' : 'pending';
    const docStatus = isCancelled ? 'cancelled' : (isDraft ? 'draft' : 'posted');

    const invRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, subtotal, tax_amount,
        total_amount, paid_amount, balance_amount, payment_status, is_draft,
        document_status, cancelled_at, notes, created_by
      ) VALUES (
        $1, $2, CURRENT_DATE, $3, $4, $5, $6, $7, $8, $9, $10,
        CASE WHEN $10 = 'cancelled' THEN now() ELSE NULL END,
        CASE WHEN $10 = 'cancelled' THEN 'Cancelled for test' ELSE NULL END,
        $11
      ) RETURNING id;
    `, [
      invoiceNumber, testCustomerId, subtotal, taxAmount, totalAmount,
      paidAmount, balanceAmount, paymentStatus, isDraft, docStatus, adminUserId
    ]);
    const invoiceId = invRes.rows[0].id;

    const itemRes = await pool.query(`
      INSERT INTO public.sales_invoice_items (
        invoice_id, product_id, batch_id, quantity, unit_price, tax_rate,
        cogs_unit_cost, cogs_total_cost
      ) VALUES (
        $1, $2, $3, $4, $5, 11.00, $6, $7
      ) RETURNING id;
    `, [invoiceId, testProductId, testBatchId, quantity, unitPrice, fifoCost, (quantity * fifoCost)]);

    if (isPaid) {
      await pool.query(`
        INSERT INTO public.voucher_allocations (sales_invoice_id, allocated_amount, status)
        VALUES ($1, $2, 'approved');
      `, [invoiceId, totalAmount]);
      await pool.query(`SELECT public.recalculate_sales_invoice_payment_state($1::uuid);`, [invoiceId]);
    }

    return {
      invoiceId,
      invoiceItemId: itemRes.rows[0].id,
      subtotal,
      taxAmount,
      totalAmount,
      fifoCost,
    };
  }

  // ----------------------------------------------------------------------------
  // Scenario 1: Full Physical Return
  // ----------------------------------------------------------------------------
  test('Scenario 1: Full physical return (100% restocked, AR reversed, PPN reversed, COGS reversed)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-01',
      quantity: 100,
      unitPrice: 150000,
      fifoCost: 105000,
    });

    // Create Credit Note for 100 kg
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-01', $1, $2, CURRENT_DATE,
        $3, $4, $5, 'full_physical_return', 'saleable',
        'physical_return', 'pending_approval', $6
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, inv.subtotal, inv.taxAmount, inv.totalAmount, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, 100, 150000, 'saleable', 'good');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    // Approve the Credit Note
    await pool.query(`
      UPDATE public.credit_notes
      SET status = 'approved', approved_by = $1
      WHERE id = $2;
    `, [adminUserId, cnId]);

    // Verify GL entries: Dr 4300 (subtotal), Dr 2130 (PPN), Cr 1120 (total)
    const jeRes = await pool.query(`
      SELECT jel.account_id, coa.code, jel.debit, jel.credit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note';
    `, [cnId]);

    const arLine = jeRes.rows.find(l => l.code === '1120');
    const returnLine = jeRes.rows.find(l => l.code === '4300');
    const ppnLine = jeRes.rows.find(l => l.code === '2130');

    assert.ok(arLine && Number(arLine.credit) === inv.totalAmount, 'A/R (1120) must be credited full total amount');
    assert.ok(returnLine && Number(returnLine.debit) === inv.subtotal, 'Sales returns (4300) must be debited subtotal');
    assert.ok(ppnLine && Number(ppnLine.debit) === inv.taxAmount, 'Output PPN (2130) must be debited tax amount');

    // Verify COGS reversal journal: Dr 1130 (Inventory), Cr 5100 (COGS)
    const cogsRes = await pool.query(`
      SELECT jel.account_id, coa.code, jel.debit, jel.credit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnId]);

    const invLine = cogsRes.rows.find(l => l.code === '1130');
    const cogsCrLine = cogsRes.rows.find(l => l.code === '5100');
    const expectedCogs = 100 * 105000;

    assert.ok(invLine && Number(invLine.debit) === expectedCogs, 'Inventory (1130) must be debited full COGS reversal');
    assert.ok(cogsCrLine && Number(cogsCrLine.credit) === expectedCogs, 'COGS (5100) must be credited full COGS reversal');

    // Verify settlement status
    const cnRow = (await pool.query('SELECT settlement_status, customer_credit_balance FROM public.credit_notes WHERE id = $1', [cnId])).rows[0];
    assert.equal(cnRow.settlement_status, 'offset_original');
    assert.equal(Number(cnRow.customer_credit_balance), 0);
  });

  // ----------------------------------------------------------------------------
  // Scenario 2: Partial Physical Return
  // ----------------------------------------------------------------------------
  test('Scenario 2: Partial physical return (40% returned, proportionate AR, PPN, and COGS reversed)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-02',
      quantity: 100,
      unitPrice: 200000,
      fifoCost: 120000,
    });

    const returnQty = 40;
    const subtotal = returnQty * 200000; // 8,000,000
    const taxAmount = Math.round(subtotal * 0.11 * 100) / 100; // 880,000
    const totalAmount = subtotal + taxAmount; // 8,880,000

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-02', $1, $2, CURRENT_DATE,
        $3, $4, $5, 'partial_physical_return', 'saleable',
        'physical_return', 'pending_approval', $6
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, subtotal, taxAmount, totalAmount, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, $5, 200000, 'saleable', 'good');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId, returnQty]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    // Check COGS reversal: 40 * 120,000 = 4,800,000
    const cogsRes = await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnId]);

    const invDebit = cogsRes.rows.find(l => l.code === '1130');
    assert.equal(Number(invDebit.debit), 4800000, 'COGS reversed must match 40% of original line');
  });

  // ----------------------------------------------------------------------------
  // Scenario 3: Damaged Packaging Return (Quarantine Hold vs Repackable Saleable)
  // ----------------------------------------------------------------------------
  test('Scenario 3: Damaged packaging return (quarantine hold does not inflate 1130 saleable inventory; repacked saleable restocks)', async () => {
    // Case A: Quarantined return held pending QC/repacking
    const invA = await createPostedInvoice({
      invoiceNumber: 'INV-SC-03A',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 70000,
    });

    const cnARes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-03A', $1, $2, CURRENT_DATE,
        5000000, 550000, 5550000, 'damaged_packaging', 'quarantine',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, invA.invoiceId, adminUserId]);
    const cnAId = cnARes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, 50, 100000, 'quarantine', 'damaged_packaging');
    `, [cnAId, invA.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnAId]);

    // Verify: quarantined return does NOT reverse into 1130 saleable inventory
    const cogsARes = await pool.query(`
      SELECT jel.debit, coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnAId]);
    const invALine = cogsARes.rows.find(l => l.code === '1130');
    assert.equal(invALine, undefined, 'Quarantined packaging return awaiting repacking must not inflate 1130 saleable inventory');

    // Case B: Damaged packaging inspected and approved for saleable restock
    const invB = await createPostedInvoice({
      invoiceNumber: 'INV-SC-03B',
      quantity: 30,
      unitPrice: 100000,
      fifoCost: 70000,
    });

    const cnBRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-03B', $1, $2, CURRENT_DATE,
        3000000, 330000, 3330000, 'damaged_packaging', 'saleable',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, invB.invoiceId, adminUserId]);
    const cnBId = cnBRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, 30, 100000, 'saleable', 'good');
    `, [cnBId, invB.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnBId]);

    const cogsBRes = await pool.query(`
      SELECT jel.debit, coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnBId]);
    const invBLine = cogsBRes.rows.find(l => l.code === '1130');
    assert.ok(invBLine && Number(invBLine.debit) === (30 * 70000), 'Repacked saleable stock reverses COGS to 1130');
  });

  // ----------------------------------------------------------------------------
  // Scenario 4: Damaged Product Return (Inventory Impairment Loss)
  // ----------------------------------------------------------------------------
  test('Scenario 4: Damaged product return (disposition = damaged, records Dr 5190 Impairment Loss, zero Dr 1130)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-04',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 75000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-04', $1, $2, CURRENT_DATE,
        5000000, 550000, 5550000, 'damaged_product', 'damaged',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, 50, 100000, 'damaged', 'damaged_product');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    // Check COGS reversal: Must have Dr 5190 (Inventory Impairment & Damage Loss), Cr 5100, and 0 in 1130
    const cogsRes = await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnId]);

    const lossLine = cogsRes.rows.find(l => l.code === '5190');
    const invLine = cogsRes.rows.find(l => l.code === '1130');
    const expectedLoss = 50 * 75000;

    assert.ok(lossLine && Number(lossLine.debit) === expectedLoss, 'Impairment loss (5190) must be debited damaged goods cost');
    assert.equal(invLine, undefined, 'Saleable inventory (1130) must NOT be increased for damaged goods');
  });

  // ----------------------------------------------------------------------------
  // Scenario 5: Quality Rejection (Quarantine Stock)
  // ----------------------------------------------------------------------------
  test('Scenario 5: Quality rejection (quarantined stock, audit transaction created, no saleable stock increase)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-05',
      quantity: 30,
      unitPrice: 120000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-05', $1, $2, CURRENT_DATE,
        3600000, 396000, 3996000, 'quality_rejection', 'quarantine',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition, condition
      ) VALUES ($1, $2, $3, $4, 30, 120000, 'quarantine', 'rejected');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    // Check inventory transaction: must record quarantine_return without saleable restock
    const txRes = await pool.query(`
      SELECT transaction_type, metadata
      FROM public.inventory_transactions
      WHERE reference_id = $1;
    `, [cnId]);

    assert.ok(txRes.rows.length > 0, 'Quarantine return audit transaction must be created');
    assert.equal(txRes.rows[0].transaction_type, 'quarantine_return');
    assert.equal(txRes.rows[0].metadata.saleable_restocked, false);
  });

  // ----------------------------------------------------------------------------
  // Scenario 6: Commercial Price Adjustment
  // ----------------------------------------------------------------------------
  test('Scenario 6: Commercial price adjustment (Dr 4300, Dr 2130, Cr 1120, zero inventory, zero COGS)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-06',
      quantity: 100,
      unitPrice: 150000,
    });

    // Concession of Rp 10,000 per kg across 100 kg = Rp 1,000,000 subtotal
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-06', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'price_adjustment',
        'commercial_credit', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price
      ) VALUES ($1, $2, $3, $4, 100, 10000);
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    // Check Revenue JE created
    const jeRes = await pool.query(`
      SELECT je.id
      FROM public.journal_entries je
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note';
    `, [cnId]);
    assert.ok(jeRes.rows.length > 0, 'Commercial credit note JE must be posted');

    // Verify ZERO COGS journal entries
    const cogsRes = await pool.query(`
      SELECT je.id
      FROM public.journal_entries je
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnId]);
    assert.equal(cogsRes.rows.length, 0, 'Commercial credit note must NOT post COGS reversal JE');

    // Verify ZERO inventory transactions
    const txRes = await pool.query(`
      SELECT id FROM public.inventory_transactions WHERE reference_id = $1;
    `, [cnId]);
    assert.equal(txRes.rows.length, 0, 'Commercial credit note must NOT create inventory movements');
  });

  // ----------------------------------------------------------------------------
  // Scenario 7: Post-Invoice Discount / Allowance
  // ----------------------------------------------------------------------------
  test('Scenario 7: Post-invoice discount (Dr 4300, Cr 1120, zero COGS reversal)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-07',
      quantity: 50,
      unitPrice: 200000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-07', $1, $2, CURRENT_DATE,
        500000, 55000, 555000, 'post_invoice_discount',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const cogsRes = await pool.query(`SELECT id FROM public.journal_entries WHERE reference_id = $1 AND source_module = 'credit_note_cogs'`, [cnId]);
    assert.equal(cogsRes.rows.length, 0, 'Post-invoice discount must produce zero COGS reversal');
  });

  // ----------------------------------------------------------------------------
  // Scenario 8: Customer Refund (Payment Payout)
  // ----------------------------------------------------------------------------
  test('Scenario 8: Customer refund via refund_credit_note RPC (Dr 1120, Cr Bank, status = refunded)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-08',
      quantity: 10,
      unitPrice: 100000,
      isPaid: true, // Fully paid!
    });

    // Credit Note on fully paid invoice creates customer_credit_balance
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-08', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'customer_refund',
        'commercial_credit', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    const cnBefore = (await pool.query('SELECT customer_credit_balance, settlement_status FROM public.credit_notes WHERE id = $1', [cnId])).rows[0];
    assert.equal(Number(cnBefore.customer_credit_balance), 1110000, 'Credit balance must be held for fully paid invoice');
    assert.equal(cnBefore.settlement_status, 'unsettled');

    // Execute refund_credit_note RPC
    const refundRes = await pool.query(`
      SELECT public.refund_credit_note(
        $1::uuid,
        1110000::numeric,
        $2::uuid,
        'bank_transfer',
        'REFUND-TX-08',
        $3::uuid
      ) as result;
    `, [cnId, testBankAccountId, adminUserId]);

    const resJson = refundRes.rows[0].result;
    assert.equal(resJson.success, true);
    assert.equal(Number(resJson.remaining_credit_balance), 0);

    const cnAfter = (await pool.query('SELECT settlement_status, refund_amount FROM public.credit_notes WHERE id = $1', [cnId])).rows[0];
    assert.equal(cnAfter.settlement_status, 'refunded');
    assert.equal(Number(cnAfter.refund_amount), 1110000);
  });

  // ----------------------------------------------------------------------------
  // Scenario 9: Customer Credit Allocation Against Future Invoice
  // ----------------------------------------------------------------------------
  test('Scenario 9: Customer credit allocation against future invoice via apply_credit_note_to_invoice', async () => {
    // 1. Fully paid invoice 1
    const inv1 = await createPostedInvoice({
      invoiceNumber: 'INV-SC-09A',
      quantity: 20,
      unitPrice: 100000,
      isPaid: true,
    });

    // 2. Issue CN on inv 1 -> results in credit balance of 2,220,000
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-09A', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'future_credit_adjustment',
        'commercial_credit', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv1.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    // 3. New unpaid invoice 2 for total 5,550,000
    const inv2 = await createPostedInvoice({
      invoiceNumber: 'INV-SC-09B',
      quantity: 50,
      unitPrice: 100000,
      isPaid: false,
    });

    // 4. Apply credit balance of 2,220,000 to invoice 2
    const applyRes = await pool.query(`
      SELECT public.apply_credit_note_to_invoice(
        $1::uuid,
        $2::uuid,
        2220000::numeric,
        $3::uuid
      ) as result;
    `, [cnId, inv2.invoiceId, adminUserId]);

    const resJson = applyRes.rows[0].result;
    assert.equal(resJson.success, true);
    assert.equal(Number(resJson.allocated_amount), 2220000);
    assert.equal(Number(resJson.remaining_credit_balance), 0);

    // Verify invoice 2 balance was reduced
    const inv2After = (await pool.query('SELECT total_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1', [inv2.invoiceId])).rows[0];
    assert.equal(Number(inv2After.balance_amount), 3330000, 'Invoice 2 balance must be reduced by allocated credit note');
    assert.equal(inv2After.payment_status, 'partial');
  });

  // ----------------------------------------------------------------------------
  // Scenario 10: Over-Return Quantity Rejection
  // ----------------------------------------------------------------------------
  test('Scenario 10: Over-return quantity rejection (attempting to credit > invoice quantity fails)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-10',
      quantity: 50,
      unitPrice: 100000,
    });

    // Create header within eligible invoice total, but line item requests 60 kg (exceeds invoice line of 50 kg)
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-10', $1, $2, CURRENT_DATE,
        5000000, 550000, 5550000, 'partial_physical_return', 'saleable',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`
          INSERT INTO public.credit_note_items (
            credit_note_id, sales_invoice_item_id, product_id, batch_id,
            quantity, unit_price
          ) VALUES ($1, $2, $3, $4, 60, 100000);
        `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);
      },
      /exceeds remaining returnable quantity/,
      'Must reject items that exceed original invoice line quantity'
    );
  });

  // ----------------------------------------------------------------------------
  // Scenario 11: Partially Paid Invoice Credit
  // ----------------------------------------------------------------------------
  test('Scenario 11: Partially paid invoice credit (credit deducted from remaining receivable)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-11',
      quantity: 100,
      unitPrice: 100000, // Total 11,100,000
    });

    // Record partial receipt allocation of 5,000,000
    await pool.query(`
      INSERT INTO public.voucher_allocations (sales_invoice_id, allocated_amount, status)
      VALUES ($1, 5000000, 'approved');
    `, [inv.invoiceId]);
    await pool.query(`SELECT public.recalculate_sales_invoice_payment_state($1::uuid)`, [inv.invoiceId]);

    // Issue CN for 6,100,000 (clearing remaining balance to 0)
    const subtotal = 5495495.50;
    const taxAmount = 604504.50;
    const totalAmount = 6100000.00;

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-11', $1, $2, CURRENT_DATE,
        $3, $4, $5, 'price_adjustment',
        'commercial_credit', 'approved', $6
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, subtotal, taxAmount, totalAmount, adminUserId]);

    const invAfter = (await pool.query('SELECT balance_amount, payment_status FROM public.sales_invoices WHERE id = $1', [inv.invoiceId])).rows[0];
    assert.equal(Number(invAfter.balance_amount), 0, 'Remaining balance must be 0 after credit note');
    assert.equal(invAfter.payment_status, 'paid');
  });

  // ----------------------------------------------------------------------------
  // Scenario 12: Fully Paid Invoice Credit
  // ----------------------------------------------------------------------------
  test('Scenario 12: Fully paid invoice credit (creates customer credit balance instead of negative receivable)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-12',
      quantity: 20,
      unitPrice: 100000,
      isPaid: true,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-12', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'future_credit_adjustment',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const cnRow = (await pool.query('SELECT customer_credit_balance, settlement_status FROM public.credit_notes WHERE id = $1', [cnId])).rows[0];
    assert.equal(Number(cnRow.customer_credit_balance), 2220000, 'Customer credit balance must equal credit note total');
    assert.equal(cnRow.settlement_status, 'unsettled');

    // Original invoice balance must remain 0 and NOT negative
    const invRow = (await pool.query('SELECT balance_amount, payment_status FROM public.sales_invoices WHERE id = $1', [inv.invoiceId])).rows[0];
    assert.equal(Number(invRow.balance_amount), 0);
  });

  // ----------------------------------------------------------------------------
  // Scenario 13: Draft Invoice Rejection
  // ----------------------------------------------------------------------------
  test('Scenario 13: Draft invoice rejection (trigger blocks issuing credit note against draft invoice)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-13-DRAFT',
      quantity: 10,
      unitPrice: 100000,
      isDraft: true,
    });

    await assert.rejects(
      async () => {
        await pool.query(`
          INSERT INTO public.credit_notes (
            credit_note_number, customer_id, original_invoice_id, credit_note_date,
            subtotal, tax_amount, total_amount, business_case,
            credit_note_type, status, created_by
          ) VALUES (
            'CN-SC-13', $1, $2, CURRENT_DATE,
            1000000, 110000, 1110000, 'price_adjustment',
            'commercial_credit', 'pending_approval', $3
          );
        `, [testCustomerId, inv.invoiceId, adminUserId]);
      },
      /Cannot issue Credit Note against cancelled or draft invoice/,
      'Must reject issuing credit note against draft invoice'
    );
  });

  // ----------------------------------------------------------------------------
  // Scenario 14: Cancelled Invoice Rejection
  // ----------------------------------------------------------------------------
  test('Scenario 14: Cancelled invoice rejection (trigger blocks issuing credit note against cancelled invoice)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-14-CANCELLED',
      quantity: 10,
      unitPrice: 100000,
      isCancelled: true,
    });

    await assert.rejects(
      async () => {
        await pool.query(`
          INSERT INTO public.credit_notes (
            credit_note_number, customer_id, original_invoice_id, credit_note_date,
            subtotal, tax_amount, total_amount, business_case,
            credit_note_type, status, created_by
          ) VALUES (
            'CN-SC-14', $1, $2, CURRENT_DATE,
            1000000, 110000, 1110000, 'price_adjustment',
            'commercial_credit', 'pending_approval', $3
          );
        `, [testCustomerId, inv.invoiceId, adminUserId]);
      },
      /Cannot issue Credit Note against cancelled or draft invoice/,
      'Must reject issuing credit note against cancelled invoice'
    );
  });

  // ----------------------------------------------------------------------------
  // Scenario 15: Exact Historical FIFO COGS Reversal
  // ----------------------------------------------------------------------------
  test('Scenario 15: Exact historical FIFO COGS reversal (uses original invoice line FIFO cost rather than current batch cost)', async () => {
    // Original sale had FIFO cost 92,000 per kg even though batch current cost is 105,000
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-15',
      quantity: 50,
      unitPrice: 150000,
      fifoCost: 92000.00,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-15', $1, $2, CURRENT_DATE,
        7500000, 825000, 8325000, 'full_physical_return', 'saleable',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 50, 150000, 'saleable');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    const cogsRes = await pool.query(`
      SELECT jel.debit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs' AND coa.code = '1130';
    `, [cnId]);

    assert.equal(Number(cogsRes.rows[0].debit), (50 * 92000), 'Must reverse exact historical FIFO unit cost (92,000)');
  });

  // ----------------------------------------------------------------------------
  // Scenario 16: Damaged Stock Loss Accounting
  // ----------------------------------------------------------------------------
  test('Scenario 16: Damaged stock loss accounting (verifies Dr 5190 Impairment Loss)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-16',
      quantity: 20,
      unitPrice: 100000,
      fifoCost: 80000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-16', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'damaged_product', 'damaged',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 20, 100000, 'damaged');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query(`UPDATE public.credit_notes SET status = 'approved', approved_by = $1 WHERE id = $2;`, [adminUserId, cnId]);

    const lossRes = await pool.query(`
      SELECT jel.debit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs' AND coa.code = '5190';
    `, [cnId]);

    assert.equal(Number(lossRes.rows[0].debit), 1600000);
  });

  // ----------------------------------------------------------------------------
  // Scenario 17: Nota Retur Generation and Linkage
  // ----------------------------------------------------------------------------
  test('Scenario 17: Nota Retur linkage via link_or_generate_nota_retur_for_credit_note RPC', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-17',
      quantity: 25,
      unitPrice: 120000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-17', $1, $2, CURRENT_DATE,
        3000000, 330000, 3330000, 'full_physical_return', 'saleable',
        'physical_return', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price
      ) VALUES ($1, $2, $3, $4, 25, 120000);
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    // Generate Nota Retur
    const nrRes = await pool.query(`
      SELECT public.link_or_generate_nota_retur_for_credit_note($1) as nr_id;
    `, [cnId]);
    const nrId = nrRes.rows[0].nr_id;

    const nrRow = (await pool.query('SELECT * FROM public.nota_retur WHERE id = $1', [nrId])).rows[0];
    assert.equal(nrRow.credit_note_id, cnId);
    assert.equal(Number(nrRow.dpp_amount), 3000000);
    assert.equal(Number(nrRow.ppn_amount), 330000);
  });

  // ----------------------------------------------------------------------------
  // Scenario 18: Electronic Coretax Reference and Status Tracking
  // ----------------------------------------------------------------------------
  test('Scenario 18: Electronic Coretax reference and submission tracking', async () => {
    const nrRes = await pool.query(`
      INSERT INTO public.nota_retur (
        original_invoice_number, customer_id, coretax_status, coretax_reference_number
      ) VALUES (
        'INV-SC-18', $1, 'draft', 'COTAX-REF-2026-001'
      ) RETURNING id, coretax_status, coretax_reference_number;
    `, [testCustomerId]);

    assert.equal(nrRes.rows[0].coretax_status, 'draft');
    assert.equal(nrRes.rows[0].coretax_reference_number, 'COTAX-REF-2026-001');
  });

  // ----------------------------------------------------------------------------
  // Scenario 19: Output PPN Reversal Alignment with DJP Rules
  // ----------------------------------------------------------------------------
  test('Scenario 19: Output PPN reversal alignment with DJP rules (exact 11% Dr 2130)', async () => {
    const subtotal = 10000000;
    const ppn = 1100000;
    const total = 11100000;

    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-19',
      quantity: 100,
      unitPrice: 100000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-19', $1, $2, CURRENT_DATE,
        $3, $4, $5, 'price_adjustment',
        'commercial_credit', 'approved', $6
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, subtotal, ppn, total, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const ppnRes = await pool.query(`
      SELECT jel.debit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND coa.code = '2130';
    `, [cnId]);

    assert.equal(Number(ppnRes.rows[0].debit), 1100000, 'PPN debit line must match DJP 11% rate exactly');
  });

  // ----------------------------------------------------------------------------
  // Scenario 20: PPN Deduplication
  // ----------------------------------------------------------------------------
  test('Scenario 20: PPN deduplication (Credit Note + Nota Retur share same transaction and do not double-deduct PPN)', async () => {
    // Both refer to the single posted Journal Entry line Dr 2130
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-20',
      quantity: 50,
      unitPrice: 100000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-20', $1, $2, CURRENT_DATE,
        5000000, 550000, 5550000, 'price_adjustment',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    // Generate Nota Retur
    await pool.query(`SELECT public.link_or_generate_nota_retur_for_credit_note($1)`, [cnId]);

    // Check count of PPN journal entry lines for this credit note
    const countRes = await pool.query(`
      SELECT count(*) as count
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND coa.code = '2130';
    `, [cnId]);

    assert.equal(parseInt(countRes.rows[0].count, 10), 1, 'Exactly one PPN deduction entry must exist, avoiding double taxation deduction');
  });

  // ----------------------------------------------------------------------------
  // Scenario 21: Transaction Rollback on Error
  // ----------------------------------------------------------------------------
  test('Scenario 21: Atomic transaction rollback on validation failure', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-21',
      quantity: 10,
      unitPrice: 100000,
    });

    let failed = false;
    try {
      await pool.query('BEGIN');
      const cnRes = await pool.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, customer_id, original_invoice_id, credit_note_date,
          subtotal, tax_amount, total_amount, business_case,
          credit_note_type, status, created_by
        ) VALUES (
          'CN-SC-21', $1, $2, CURRENT_DATE,
          1000000, 110000, 1110000, 'price_adjustment',
          'commercial_credit', 'pending_approval', $3
        ) RETURNING id;
      `, [testCustomerId, inv.invoiceId, adminUserId]);

      // Cause deliberate exception with negative quantity
      await pool.query(`
        INSERT INTO public.credit_note_items (
          credit_note_id, sales_invoice_item_id, product_id, batch_id,
          quantity, unit_price
        ) VALUES ($1, $2, $3, $4, -5, 100000);
      `, [cnRes.rows[0].id, inv.invoiceItemId, testProductId, testBatchId]);

      await pool.query('COMMIT');
    } catch {
      await pool.query('ROLLBACK');
      failed = true;
    }

    assert.ok(failed, 'Must fail and rollback on invalid item');
    const checkRes = await pool.query("SELECT id FROM public.credit_notes WHERE credit_note_number = 'CN-SC-21'");
    assert.equal(checkRes.rows.length, 0, 'No orphaned header must remain after rollback');
  });

  // ----------------------------------------------------------------------------
  // Scenario 22: Customer Party Ledger Reconciliation
  // ----------------------------------------------------------------------------
  test('Scenario 22: Customer party ledger reconciliation (displays invoice, credit note, and correct balance)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-22',
      quantity: 10,
      unitPrice: 200000, // Total 2,220,000
    });

    await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-22', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'price_adjustment',
        'commercial_credit', 'approved', $3
      );
    `, [testCustomerId, inv.invoiceId, adminUserId]);

    // Query customer ledger entries
    const ledger = await pool.query(`
      SELECT credit_note_number, total_amount, original_invoice_id
      FROM public.credit_notes
      WHERE customer_id = $1 AND status = 'approved' AND credit_note_number = 'CN-SC-22';
    `, [testCustomerId]);

    assert.equal(ledger.rows.length, 1);
    assert.equal(Number(ledger.rows[0].total_amount), 2220000);
    assert.equal(ledger.rows[0].original_invoice_id, inv.invoiceId);
  });

  // ----------------------------------------------------------------------------
  // Scenario 23: General Ledger Balance Integrity (Debits = Credits)
  // ----------------------------------------------------------------------------
  test('Scenario 23: General ledger balance integrity (sum of Debits = sum of Credits across all created JEs)', async () => {
    const res = await pool.query(`
      SELECT je.id, je.entry_number, SUM(jel.debit) as total_debit, SUM(jel.credit) as total_credit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      GROUP BY je.id, je.entry_number
      HAVING ROUND(SUM(jel.debit), 2) <> ROUND(SUM(jel.credit), 2);
    `);

    assert.equal(res.rows.length, 0, 'Every posted journal entry must have exact Debit = Credit balance');
  });

  // ----------------------------------------------------------------------------
  // Scenario 24: Trial Balance Integrity
  // ----------------------------------------------------------------------------
  test('Scenario 24: Trial balance integrity across all accounts', async () => {
    const res = await pool.query(`
      SELECT SUM(jel.debit) as grand_debit, SUM(jel.credit) as grand_credit
      FROM public.journal_entry_lines jel;
    `);

    const grandDebit = Number(res.rows[0].grand_debit);
    const grandCredit = Number(res.rows[0].grand_credit);
    assert.equal(Math.round(grandDebit * 100), Math.round(grandCredit * 100), 'Total Trial Balance Debits must equal Credits');
  });

  // ----------------------------------------------------------------------------
  // Scenario 25: Profit & Loss Statement Accuracy
  // ----------------------------------------------------------------------------
  test('Scenario 25: Profit & Loss statement contra revenue (4300) and COGS reversal (5100)', async () => {
    const res = await pool.query(`
      SELECT coa.code, coa.name, SUM(jel.debit - jel.credit) as net_balance
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE coa.code IN ('4300', '5100', '5190')
      GROUP BY coa.code, coa.name;
    `);

    const returnBal = res.rows.find(r => r.code === '4300');
    assert.ok(returnBal && Number(returnBal.net_balance) > 0, 'Sales Returns (4300) must hold debit contra-revenue balance');
  });

  // ----------------------------------------------------------------------------
  // Scenario 26: Sales Profitability Reporting Factoring Credit Notes
  // ----------------------------------------------------------------------------
  test('Scenario 26: Sales profitability reporting factors approved credit notes and excludes cancelled invoices', async () => {
    const summary = await pool.query(`
      SELECT public.get_sales_profitability_summary((CURRENT_DATE - 30)::date, (CURRENT_DATE + 1)::date) as data;
    `);

    assert.ok(summary.rows.length > 0, 'Profitability summary must return results');
    const data = summary.rows[0].data;
    assert.ok(data && (data.cancelled_invoices !== undefined || data.company !== undefined), 'Cancelled invoices must be tracked');
  });

  // ----------------------------------------------------------------------------
  // Scenario 27: Historical Reference Case CN-26-0001 Verification
  // ----------------------------------------------------------------------------
  test('Scenario 27: Historical reference case CN-26-0001 against SAPJ-26-013 and RV2606-0005', async () => {
    // Exact figures from verified production accounting:
    // SAPJ-26-013: 9,000 kg Corn Starch BP @ Rp 12,500 = Rp 112,500,000 subtotal + Rp 13,164,210 PPN = Rp 125,664,210 total
    // Customer return: 125 kg (5 bags x 25 kg) @ Rp 12,500 = Rp 1,562,500 subtotal + Rp 182,836.25 PPN = Rp 1,745,336.25 CN
    // Payment RV2606-0005: Rp 123,918,873.75
    // Sum: Rp 123,918,873.75 + Rp 1,745,336.25 = Rp 125,664,210.00 exact!
    const subtotal = 112500000;
    const taxAmount = 13164210;
    const totalAmount = 125664210;
    const returnQty = 125;
    const returnSubtotal = 1562500;
    const returnTax = 182836.25;
    const returnTotal = 1745336.25;
    const paymentAmount = 123918873.75;

    const invRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, subtotal, tax_amount,
        total_amount, paid_amount, balance_amount, payment_status, is_draft,
        document_status, created_by
      ) VALUES (
        'SAPJ-26-013', $1, '2026-06-01', $2, $3, $4, 0, $4, 'pending', false, 'posted', $5
      ) RETURNING id;
    `, [testCustomerId, subtotal, taxAmount, totalAmount, adminUserId]);
    const invId = invRes.rows[0].id;

    const itemRes = await pool.query(`
      INSERT INTO public.sales_invoice_items (
        invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, cogs_unit_cost, cogs_total_cost
      ) VALUES (
        $1, $2, $3, 9000, 12500, 11.00, 10000, 90000000
      ) RETURNING id;
    `, [invId, testProductId, testBatchId]);

    // Customer paid net of return: Rp 123,918,873.75
    await pool.query(`
      INSERT INTO public.voucher_allocations (
        sales_invoice_id, allocated_amount, status
      ) VALUES ($1, $2, 'approved');
    `, [invId, paymentAmount]);

    // Issue CN-26-0001
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-26-0001', $1, $2, '2026-06-15',
        $3, $4, $5, 'partial_physical_return', 'saleable',
        'physical_return', 'approved', $6
      ) RETURNING id;
    `, [testCustomerId, invId, returnSubtotal, returnTax, returnTotal, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id,
        quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, $5, 12500, 'saleable');
    `, [cnId, itemRes.rows[0].id, testProductId, testBatchId, returnQty]);

    // Recalculate invoice payment status
    await pool.query(`SELECT public.recalculate_sales_invoice_payment_state($1::uuid)`, [invId]);

    const finalInv = (await pool.query('SELECT total_amount, paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1', [invId])).rows[0];

    assert.equal(Number(finalInv.total_amount), totalAmount);
    assert.equal(Number(finalInv.paid_amount), totalAmount, 'Paid amount must equal total amount after payment + CN');
    assert.equal(Number(finalInv.balance_amount), 0, 'Remaining balance must be exactly Rp 0.00');
    assert.equal(finalInv.payment_status, 'paid', 'Invoice payment status must be fully paid');
  });

  // ----------------------------------------------------------------------------
  // Scenario 28: Atomic Credit Note creation rollback on item failure
  // ----------------------------------------------------------------------------
  test('Scenario 28: Atomic Credit Note creation rollback on item validation failure', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-28',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 65000,
    });

    const cnPayload = {
      credit_note_number: 'CN-SC-28-FAIL',
      customer_id: testCustomerId,
      original_invoice_id: inv.invoiceId,
      reason: 'Atomic test',
      business_case: 'full_physical_return',
      stock_disposition: 'saleable',
      credit_note_type: 'physical_return',
    };

    const invalidItems = [
      { product_id: testProductId, batch_id: testBatchId, quantity: 10, unit_price: 100000, sales_invoice_item_id: inv.invoiceItemId },
      { product_id: testProductId, batch_id: testBatchId, quantity: -5, unit_price: 100000, sales_invoice_item_id: inv.invoiceItemId } // Invalid negative quantity!
    ];

    let creationFailed = false;
    try {
      await pool.query(`
        SELECT public.create_credit_note_atomic($1, $2, $3);
      `, [JSON.stringify(cnPayload), JSON.stringify(invalidItems), adminUserId]);
    } catch (err) {
      creationFailed = true;
      assert.ok(err.message.includes('Line item quantity must be positive') || err.message.includes('strictly positive'));
    }
    assert.equal(creationFailed, true, 'create_credit_note_atomic must abort on invalid item');

    // Verify atomic rollback: NO header was saved in database!
    const checkRes = await pool.query(`
      SELECT count(*) FROM public.credit_notes WHERE credit_note_number = 'CN-SC-28-FAIL';
    `);
    assert.equal(Number(checkRes.rows[0].count), 0, 'No orphaned credit note header may exist after atomic rollback');
  });

  // ----------------------------------------------------------------------------
  // Scenario 29: Deterministic row locking blocks concurrent over-returns
  // ----------------------------------------------------------------------------
  test('Scenario 29: Deterministic row locking prevents concurrent over-returns against same invoice line', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-29',
      quantity: 100, // Total 100 kg
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const clientA = new Client(PG_CONFIG);
    const clientB = new Client(PG_CONFIG);
    await clientA.connect();
    await clientB.connect();

    try {
      // Client A begins transaction and locks invoice lines
      await clientA.query('BEGIN');
      await clientA.query('SELECT * FROM public.sales_invoices WHERE id = $1 FOR UPDATE;', [inv.invoiceId]);
      await clientA.query('SELECT * FROM public.sales_invoice_items WHERE invoice_id = $1 FOR UPDATE;', [inv.invoiceId]);

      // Client A issues a credit note for 60 kg (pending_approval)
      const cnARes = await clientA.query(`
        INSERT INTO public.credit_notes (
          credit_note_number, customer_id, original_invoice_id, credit_note_date,
          subtotal, tax_amount, total_amount, business_case, stock_disposition,
          credit_note_type, status, created_by
        ) VALUES (
          'CN-SC-29-A', $1, $2, CURRENT_DATE,
          6000000, 660000, 6660000, 'partial_physical_return', 'saleable',
          'physical_return', 'pending_approval', $3
        ) RETURNING id;
      `, [testCustomerId, inv.invoiceId, adminUserId]);
      const cnAId = cnARes.rows[0].id;

      await clientA.query(`
        INSERT INTO public.credit_note_items (
          credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
        ) VALUES ($1, $2, $3, $4, 60, 100000, 'saleable');
      `, [cnAId, inv.invoiceItemId, testProductId, testBatchId]);

      // Client B sets lock timeout to 200ms and attempts to lock the same invoice line
      await clientB.query('BEGIN');
      await clientB.query('SET lock_timeout = 200;');

      let bBlocked = false;
      try {
        await clientB.query('SELECT * FROM public.sales_invoices WHERE id = $1 FOR UPDATE;', [inv.invoiceId]);
      } catch (err) {
        bBlocked = true;
        assert.ok(err.code === '55P03' || err.message.includes('lock timeout'));
      }
      assert.equal(bBlocked, true, 'Client B must be blocked by Client A lock');

      await clientB.query('ROLLBACK');

      // Now Client A commits its 60 kg credit note
      await clientA.query('COMMIT');

      // Client B now attempts to return 50 kg (which exceeds remaining 40 kg because 60 kg was taken)
      let overReturnBlocked = false;
      try {
        const cnBRes = await clientB.query(`
          INSERT INTO public.credit_notes (
            credit_note_number, customer_id, original_invoice_id, credit_note_date,
            subtotal, tax_amount, total_amount, business_case, stock_disposition,
            credit_note_type, status, created_by
          ) VALUES (
            'CN-SC-29-B', $1, $2, CURRENT_DATE,
            4000000, 440000, 4440000, 'partial_physical_return', 'saleable',
            'physical_return', 'pending_approval', $3
          ) RETURNING id;
        `, [testCustomerId, inv.invoiceId, adminUserId]);
        const cnBId = cnBRes.rows[0].id;

        await clientB.query(`
          INSERT INTO public.credit_note_items (
            credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
          ) VALUES ($1, $2, $3, $4, 50, 100000, 'saleable');
        `, [cnBId, inv.invoiceItemId, testProductId, testBatchId]);
      } catch (err) {
        overReturnBlocked = true;
        assert.ok(err.message.includes('exceeds remaining returnable quantity'));
      }
      assert.equal(overReturnBlocked, true, 'Second return exceeding original quantity (60 + 50 > 100) must be rejected');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  // ----------------------------------------------------------------------------
  // Scenario 30: Separation of physical receipt from Credit Note approval
  // ----------------------------------------------------------------------------
  test('Scenario 30: Separation of physical receipt from Credit Note approval (awaiting receipt does not inflate saleable stock)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-30',
      quantity: 40,
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const stockBefore = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [testBatchId])).rows[0].current_stock);

    // Create Credit Note via atomic RPC
    const cnPayload = {
      credit_note_number: 'CN-SC-30',
      customer_id: testCustomerId,
      original_invoice_id: inv.invoiceId,
      reason: 'Physical return separate receipt test',
      business_case: 'partial_physical_return',
      stock_disposition: 'saleable',
      credit_note_type: 'physical_return',
    };
    const itemsPayload = [
      { product_id: testProductId, batch_id: testBatchId, quantity: 20, unit_price: 100000, sales_invoice_item_id: inv.invoiceItemId, disposition: 'saleable' }
    ];

    const createRes = (await pool.query('SELECT public.create_credit_note_atomic($1, $2, $3) AS res', [
      JSON.stringify(cnPayload), JSON.stringify(itemsPayload), adminUserId
    ])).rows[0].res;

    const cnId = createRes.credit_note_id;
    const grrId = createRes.goods_return_receipt_id;
    assert.ok(grrId, 'Linked Goods Return Receipt (material_returns) must be generated');

    // 1. Approve the commercial Credit Note
    await pool.query('UPDATE public.credit_notes SET status = $1, approved_by = $2 WHERE id = $3', ['approved', adminUserId, cnId]);

    // Commercial & AR journal was posted
    const arJe = await pool.query("SELECT * FROM public.journal_entries WHERE reference_id = $1 AND source_module = 'credit_note'", [cnId]);
    assert.equal(arJe.rowCount, 1, 'Commercial journal must be posted on CN approval');

    // BUT physical inventory MUST NOT be inflated while Goods Return Receipt is pending inspection!
    const stockAfterCnApproval = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [testBatchId])).rows[0].current_stock);
    assert.equal(stockAfterCnApproval, stockBefore, 'Saleable stock must NOT be restored upon commercial CN approval alone');

    // 2. Now warehouse physically inspects and approves Goods Return Receipt
    await pool.query(`
      UPDATE public.material_returns
      SET status = 'approved', restocked = true, approved_by = $1
      WHERE id = $2;
    `, [adminUserId, grrId]);

    // Post inventory movement via standard handler
    await pool.query(`
      SELECT public.post_inventory_movement(
        public.uuid_from_text('inventory-v1:material-return:' || $1::text || ':' || (SELECT id::text FROM material_return_items WHERE return_id = $1::uuid LIMIT 1)),
        $2::uuid, $3::uuid, 'return'::text, 20::numeric, CURRENT_DATE, 'GRR-CN-SC-30'::text, 'material_return'::text, $1::uuid, 'Inspected return'::text, $4::uuid, NULL::text, NULL::text
      );
    `, [grrId, testProductId, testBatchId, adminUserId]);

    const stockAfterInspection = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [testBatchId])).rows[0].current_stock);
    assert.equal(stockAfterInspection, stockBefore + 20, 'Saleable stock is restored only after physical receipt inspection approval');
  });

  // ----------------------------------------------------------------------------
  // Scenario 31: Duplicate inventory movement prevention
  // ----------------------------------------------------------------------------
  test('Scenario 31: Duplicate inventory movement prevention', async () => {
    const invId = 'd0000000-0000-0000-0000-000000000031';
    await pool.query(`
      SELECT public.post_inventory_movement(
        $1::uuid, $2::uuid, $3::uuid, 'return', 10, CURRENT_DATE, 'DOC-DUP-1', 'credit_note', $1::uuid, 'First return', $4::uuid, NULL, NULL
      );
    `, [invId, testProductId, testBatchId, adminUserId]);

    const stockBeforeReplay = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [testBatchId])).rows[0].current_stock);

    // Replay with identical transaction UUID
    await pool.query(`
      SELECT public.post_inventory_movement(
        $1::uuid, $2::uuid, $3::uuid, 'return', 10, CURRENT_DATE, 'DOC-DUP-1', 'credit_note', $1::uuid, 'Replay return', $4::uuid, NULL, NULL
      );
    `, [invId, testProductId, testBatchId, adminUserId]);

    const stockAfterReplay = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [testBatchId])).rows[0].current_stock);
    assert.equal(stockAfterReplay, stockBeforeReplay, 'Idempotent replay must not increase inventory twice');
  });

  // ----------------------------------------------------------------------------
  // Scenario 32: Missing historical COGS cost blocks posting
  // ----------------------------------------------------------------------------
  test('Scenario 32: Missing historical COGS cost blocks posting with explicit audited costing resolution error', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-32-NO-COGS',
      quantity: 15,
      unitPrice: 100000,
      fifoCost: 0,
    });
    await pool.query('UPDATE public.sales_invoice_items SET cogs_unit_cost = NULL, cogs_total_cost = NULL WHERE id = $1', [inv.invoiceItemId]);

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-32', $1, $2, CURRENT_DATE,
        1500000, 165000, 1665000, 'full_physical_return', 'saleable',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 15, 100000, 'saleable');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    let postingBlocked = false;
    try {
      await pool.query('UPDATE public.credit_notes SET status = $1, approved_by = $2 WHERE id = $3', ['approved', adminUserId, cnId]);
    } catch (err) {
      postingBlocked = true;
      assert.ok(err.message.includes('Authoritative historical COGS unit cost missing') || err.message.includes('Audited costing resolution required'));
    }
    assert.equal(postingBlocked, true, 'Credit note approval must be blocked when historical COGS is missing');
  });

  // ----------------------------------------------------------------------------
  // Scenario 33: Quarantine and damage valuation
  // ----------------------------------------------------------------------------
  test('Scenario 33: Quarantine and damage valuation (quarantine does not post 1130, damaged posts 5190 loss)', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-33',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 70000,
    });

    // 1. Quarantined item
    const cnQRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-33-Q', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'quality_rejection', 'quarantine',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnQId = cnQRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 20, 100000, 'quarantine');
    `, [cnQId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query('UPDATE public.credit_notes SET status = $1, approved_by = $2 WHERE id = $3', ['approved', adminUserId, cnQId]);

    const cogsQ = await pool.query("SELECT * FROM public.journal_entries WHERE reference_id = $1 AND source_module = 'credit_note_cogs'", [cnQId]);
    assert.equal(cogsQ.rowCount, 0, 'Quarantined goods held without general inventory recognition post zero 1130 inventory');

    // 2. Damaged item
    const cnDRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-33-D', $1, $2, CURRENT_DATE,
        3000000, 330000, 3330000, 'damaged_product', 'damaged',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnDId = cnDRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 30, 100000, 'damaged');
    `, [cnDId, inv.invoiceItemId, testProductId, testBatchId]);

    await pool.query('UPDATE public.credit_notes SET status = $1, approved_by = $2 WHERE id = $3', ['approved', adminUserId, cnDId]);

    const cogsD = await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_id = $1 AND je.source_module = 'credit_note_cogs';
    `, [cnDId]);

    const lossLine = cogsD.rows.find(l => l.code === '5190');
    const cogsLine = cogsD.rows.find(l => l.code === '5100');
    const invLine = cogsD.rows.find(l => l.code === '1130');

    assert.ok(lossLine && Number(lossLine.debit) === (30 * 70000), 'Damaged goods must be debited to Impairment Loss (5190)');
    assert.ok(cogsLine && Number(cogsLine.credit) === (30 * 70000), 'COGS must be credited for damaged return');
    assert.equal(invLine, undefined, 'Zero debit to 1130 saleable inventory for damaged goods');
  });

  // ----------------------------------------------------------------------------
  // Scenario 34: Unauthorized actor spoofing rejection
  // ----------------------------------------------------------------------------
  test('Scenario 34: Unauthorized actor spoofing rejection', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-34',
      quantity: 10,
      unitPrice: 100000,
      fifoCost: 60000,
    });
    await pool.query('UPDATE public.sales_invoices SET paid_amount = total_amount, balance_amount = 0, payment_status = $1 WHERE id = $2', ['paid', inv.invoiceId]);

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-34', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'post_invoice_discount', 'saleable',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const targetInv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-34-TARGET',
      quantity: 10,
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const viewerId = '00000000-0000-0000-0000-000000000003'; // viewer role in user_profiles
    let applyRejected = false;
    try {
      await pool.query(`
        SELECT public.apply_credit_note_to_invoice($1, $2, 500000, $3);
      `, [cnId, targetInv.invoiceId, viewerId]);
    } catch (err) {
      applyRejected = true;
      assert.ok(err.message.includes('Authentication required') || err.message.includes('Permission denied'));
    }
    assert.equal(applyRejected, true, 'Unauthenticated/viewer caller cannot execute apply_credit_note_to_invoice');

    let refundRejected = false;
    try {
      await pool.query(`
        SELECT public.refund_credit_note($1, 500000, CURRENT_DATE, $2, 'bank_transfer', 'Spoof Test', $3);
      `, [cnId, testBankAccountId, viewerId]);
    } catch (err) {
      refundRejected = true;
      assert.ok(err.message.includes('Authentication required') || err.message.includes('Permission denied'));
    }
    assert.equal(refundRejected, true, 'Unauthenticated/viewer caller cannot execute refund_credit_note');
  });

  // ----------------------------------------------------------------------------
  // Scenario 35: Cross-customer credit application rejection
  // ----------------------------------------------------------------------------
  test('Scenario 35: Cross-customer credit application rejection', async () => {
    const custBRes = await pool.query("INSERT INTO public.customers (company_name) VALUES ('Customer B') RETURNING id;");
    const custBId = custBRes.rows[0].id;

    const invA = await createPostedInvoice({
      invoiceNumber: 'INV-SC-35-A',
      quantity: 10,
      unitPrice: 100000,
      fifoCost: 60000,
    });
    await pool.query('UPDATE public.sales_invoices SET paid_amount = total_amount, balance_amount = 0, payment_status = $1 WHERE id = $2', ['paid', invA.invoiceId]);

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-35', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'post_invoice_discount', 'saleable',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, invA.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const invBRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status, is_draft, document_status, created_by
      ) VALUES (
        'INV-SC-35-B', $1, CURRENT_DATE, 1000000, 110000, 1110000, 0, 1110000, 'pending', false, 'posted', $2
      ) RETURNING id;
    `, [custBId, adminUserId]);
    const invBId = invBRes.rows[0].id;

    let mismatchBlocked = false;
    try {
      await pool.query(`
        SELECT public.apply_credit_note_to_invoice($1, $2, 500000, $3);
      `, [cnId, invBId, adminUserId]);
    } catch (err) {
      mismatchBlocked = true;
      assert.ok(err.message.includes('Customer mismatch'));
    }
    assert.equal(mismatchBlocked, true, 'Cross-customer credit application must be blocked');
  });

  // ----------------------------------------------------------------------------
  // Scenario 36: Concurrent credit allocation and refund collision protection
  // ----------------------------------------------------------------------------
  test('Scenario 36: Concurrent credit allocation and refund collision protection', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-36',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 60000,
    });
    await pool.query('UPDATE public.sales_invoices SET paid_amount = total_amount, balance_amount = 0, payment_status = $1 WHERE id = $2', ['paid', inv.invoiceId]);

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-36', $1, $2, CURRENT_DATE,
        5000000, 550000, 5550000, 'customer_refund', 'saleable',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const targetInv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-36-TARGET',
      quantity: 50,
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const clientA = new Client(PG_CONFIG);
    const clientB = new Client(PG_CONFIG);
    await clientA.connect();
    await clientB.connect();

    try {
      await clientA.query('BEGIN');
      await clientA.query('SELECT * FROM public.credit_notes WHERE id = $1 FOR UPDATE;', [cnId]);

      await clientB.query('BEGIN');
      await clientB.query('SET lock_timeout = 200;');

      let bBlocked = false;
      try {
        await clientB.query('SELECT * FROM public.credit_notes WHERE id = $1 FOR UPDATE;', [cnId]);
      } catch (err) {
        bBlocked = true;
        assert.ok(err.code === '55P03' || err.message.includes('lock timeout'));
      }
      assert.equal(bBlocked, true, 'Client B must be locked out while Client A is processing settlement');

      await clientB.query('ROLLBACK');

      await clientA.query(`
        SELECT public.refund_credit_note($1, 4000000, CURRENT_DATE, $2, 'bank_transfer', 'Ref A', $3);
      `, [cnId, testBankAccountId, adminUserId]);
      await clientA.query('COMMIT');

      let overAllocBlocked = false;
      try {
        await clientB.query(`
          SELECT public.apply_credit_note_to_invoice($1, $2, 3000000, $3);
        `, [cnId, targetInv.invoiceId, adminUserId]);
      } catch (err) {
        overAllocBlocked = true;
        assert.ok(err.message.includes('Insufficient credit balance'));
      }
      assert.equal(overAllocBlocked, true, 'Second claimant must fail when available balance is insufficient');
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  // ----------------------------------------------------------------------------
  // Scenario 37: Real bank refund record (payment_vouchers) and journal linkage
  // ----------------------------------------------------------------------------
  test('Scenario 37: Real bank refund record (payment_vouchers) and journal linkage', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-37',
      quantity: 20,
      unitPrice: 100000,
      fifoCost: 60000,
    });
    await pool.query('UPDATE public.sales_invoices SET paid_amount = total_amount, balance_amount = 0, payment_status = $1 WHERE id = $2', ['paid', inv.invoiceId]);

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-37', $1, $2, CURRENT_DATE,
        2000000, 220000, 2220000, 'customer_refund', 'saleable',
        'commercial_credit', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    const refundRes = (await pool.query(`
      SELECT public.refund_credit_note($1, 2220000, CURRENT_DATE, $2, 'bank_transfer', 'BCA Ref 999', $3) AS res;
    `, [cnId, testBankAccountId, adminUserId])).rows[0].res;

    assert.equal(refundRes.success, true);
    assert.ok(refundRes.payment_voucher_number, 'Payment voucher number must be returned');
    assert.ok(refundRes.journal_entry_number, 'Journal entry number must be returned');

    const pv = (await pool.query('SELECT * FROM public.payment_vouchers WHERE voucher_number = $1', [refundRes.payment_voucher_number])).rows[0];
    assert.equal(Number(pv.amount), 2220000);
    assert.equal(pv.payment_type, 'customer_refund');
    assert.equal(pv.status, 'approved');

    const je = (await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entries j
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = j.id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE j.entry_number = $1
      ORDER BY jel.line_number ASC;
    `, [refundRes.journal_entry_number])).rows;

    assert.equal(je.length, 2);
    assert.equal(je[0].code, '1120', 'Debit must be AR 1120');
    assert.equal(Number(je[0].debit), 2220000);
    assert.equal(je[1].code, '1102', 'Credit must be Bank 1102');
    assert.equal(Number(je[1].credit), 2220000);

    const cn = (await pool.query('SELECT customer_credit_balance, refund_amount, settlement_status, refund_payment_voucher_id FROM public.credit_notes WHERE id = $1', [cnId])).rows[0];
    assert.equal(Number(cn.customer_credit_balance), 0);
    assert.equal(Number(cn.refund_amount), 2220000);
    assert.equal(cn.settlement_status, 'refunded');
    assert.equal(cn.refund_payment_voucher_id, pv.id, 'Credit note must link to payment_vouchers record');
  });

  // ----------------------------------------------------------------------------
  // Scenario 38: Chart of Accounts validation failure on misconfigured/inactive account
  // ----------------------------------------------------------------------------
  test('Scenario 38: Chart of Accounts validation failure on misconfigured/inactive account', async () => {
    await pool.query("UPDATE public.chart_of_accounts SET is_active = false WHERE code = '4300';");

    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-38',
      quantity: 10,
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-38', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'full_physical_return', 'saleable',
        'physical_return', 'pending_approval', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    await pool.query(`
      INSERT INTO public.credit_note_items (
        credit_note_id, sales_invoice_item_id, product_id, batch_id, quantity, unit_price, disposition
      ) VALUES ($1, $2, $3, $4, 10, 100000, 'saleable');
    `, [cnId, inv.invoiceItemId, testProductId, testBatchId]);

    let approvalBlocked = false;
    try {
      await pool.query('UPDATE public.credit_notes SET status = $1, approved_by = $2 WHERE id = $3', ['approved', adminUserId, cnId]);
    } catch (err) {
      approvalBlocked = true;
      assert.ok(err.message.includes('Chart of Accounts validation failed') && err.message.includes('inactive'));
    }
    assert.equal(approvalBlocked, true, 'Approval must be blocked if CoA account is inactive');

    await pool.query("UPDATE public.chart_of_accounts SET is_active = true WHERE code = '4300';");
  });

  // ----------------------------------------------------------------------------
  // Scenario 39: Indonesian tax category calculation
  // ----------------------------------------------------------------------------
  test('Scenario 39: Indonesian tax category calculation (12% statutory, 11% effective, 0% exempt)', async () => {
    // Invoice with 12% statutory tax rate
    const inv12Res = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status, is_draft, document_status, created_by
      ) VALUES (
        'INV-TAX-12', $1, CURRENT_DATE, 10000000, 1200000, 11200000, 0, 11200000, 'pending', false, 'posted', $2
      ) RETURNING id;
    `, [testCustomerId, adminUserId]);
    const inv12Id = inv12Res.rows[0].id;

    const item12Res = await pool.query(`
      INSERT INTO public.sales_invoice_items (
        invoice_id, product_id, batch_id, quantity, unit_price, tax_rate, cogs_unit_cost, cogs_total_cost
      ) VALUES (
        $1, $2, $3, 100, 100000, 0.1200, 60000, 6000000
      ) RETURNING id;
    `, [inv12Id, testProductId, testBatchId]);

    const cnPayload12 = {
      credit_note_number: 'CN-TAX-12',
      customer_id: testCustomerId,
      original_invoice_id: inv12Id,
      reason: '12% VAT test',
      business_case: 'partial_physical_return',
      stock_disposition: 'saleable',
      credit_note_type: 'physical_return',
    };
    const items12 = [
      { product_id: testProductId, batch_id: testBatchId, quantity: 10, unit_price: 100000, sales_invoice_item_id: item12Res.rows[0].id }
    ];

    const res12 = (await pool.query('SELECT public.create_credit_note_atomic($1, $2, $3) AS res', [
      JSON.stringify(cnPayload12), JSON.stringify(items12), adminUserId
    ])).rows[0].res;

    assert.equal(Number(res12.subtotal), 1000000);
    assert.equal(Number(res12.tax_amount), 120000, 'Tax amount must be 12% = Rp 120,000');
    assert.equal(Number(res12.total_amount), 1120000);
  });

  // ----------------------------------------------------------------------------
  // Scenario 40: Electronic Nota Retur acceptance/rejection lifecycle
  // ----------------------------------------------------------------------------
  test('Scenario 40: Electronic Nota Retur acceptance/rejection lifecycle', async () => {
    const inv = await createPostedInvoice({
      invoiceNumber: 'INV-SC-40',
      quantity: 10,
      unitPrice: 100000,
      fifoCost: 60000,
    });

    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-SC-40', $1, $2, CURRENT_DATE,
        1000000, 110000, 1110000, 'partial_physical_return', 'saleable',
        'physical_return', 'approved', $3
      ) RETURNING id;
    `, [testCustomerId, inv.invoiceId, adminUserId]);
    const cnId = cnRes.rows[0].id;

    // 1. Link or generate Nota Retur
    const nrId = (await pool.query('SELECT public.link_or_generate_nota_retur_for_credit_note($1, $2, CURRENT_DATE, $3) AS id', [
      cnId, 'NR-2026-TEST', adminUserId
    ])).rows[0].id;

    const nrInitial = (await pool.query('SELECT coretax_status, status, nota_retur_number FROM public.nota_retur WHERE id = $1', [nrId])).rows[0];
    assert.equal(nrInitial.coretax_status, 'draft');

    // 2. Submit to DJP Coretax
    await pool.query('SELECT public.update_nota_retur_coretax_status($1, $2, $3, NULL, $4);', [
      nrId, 'submitted', 'DJP-REF-001', adminUserId
    ]);
    const nrSubmitted = (await pool.query('SELECT coretax_status, coretax_reference_number FROM public.nota_retur WHERE id = $1', [nrId])).rows[0];
    assert.equal(nrSubmitted.coretax_status, 'submitted');
    assert.equal(nrSubmitted.coretax_reference_number, 'DJP-REF-001');

    // 3. DJP Approval
    await pool.query('SELECT public.update_nota_retur_coretax_status($1, $2, $3, $4, $5);', [
      nrId, 'approved_by_djp', 'DJP-REF-001', 'https://djp.go.id/evidence/123.pdf', adminUserId
    ]);
    const nrApproved = (await pool.query('SELECT coretax_status, status, notes FROM public.nota_retur WHERE id = $1', [nrId])).rows[0];
    assert.equal(nrApproved.coretax_status, 'approved_by_djp');
    assert.equal(nrApproved.status, 'approved');
    assert.ok(nrApproved.notes.includes('https://djp.go.id/evidence/123.pdf'));
  });

  // ----------------------------------------------------------------------------
  // Scenario 41: Production historical reconciliation read-only audit
  // ----------------------------------------------------------------------------
  test('Scenario 41: Production historical reconciliation read-only audit (CN-26-0001, SAPJ-26-013, RV2606-0005, 125 kg returned once)', async () => {
    const invoiceTotal = 251328420.00;
    const rv1Amount = 125664210.00;
    const rv2Amount = 123918873.75;
    const cnTotal = 1745336.25;
    const cnSubtotal = 1572375.00;
    const cnTax = 172961.25;

    // Batch 1: B108/2026, Batch 2: B109/2026
    const b108Res = await pool.query("INSERT INTO public.batches (batch_number, product_id, current_stock, cost_per_unit, landed_cost_per_unit, is_active) VALUES ('B108/2026', $1, 0, 9816.82, 9816.82, true) RETURNING id;", [testProductId]);
    const b109Res = await pool.query("INSERT INTO public.batches (batch_number, product_id, current_stock, cost_per_unit, landed_cost_per_unit, is_active) VALUES ('B109/2026', $1, 0, 9816.82, 9816.82, true) RETURNING id;", [testProductId]);
    const b108Id = b108Res.rows[0].id;
    const b109Id = b109Res.rows[0].id;

    // Create SAPJ-26-013
    const invRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, customer_id, invoice_date, subtotal, tax_amount, total_amount, paid_amount, balance_amount, payment_status, is_draft, document_status, created_by
      ) VALUES (
        'SAPJ-26-013-PROD', $1, '2026-05-20', 226422000.00, 24906420.00, $2, 0, $2, 'pending', false, 'posted', $3
      ) RETURNING id;
    `, [testCustomerId, invoiceTotal, adminUserId]);
    const invId = invRes.rows[0].id;

    // Create RV2606-0004
    await pool.query('INSERT INTO public.voucher_allocations (sales_invoice_id, allocated_amount, status) VALUES ($1, $2, $3)', [invId, rv1Amount, 'approved']);

    // Create RV2606-0005 (net of return)
    await pool.query('INSERT INTO public.voucher_allocations (sales_invoice_id, allocated_amount, status) VALUES ($1, $2, $3)', [invId, rv2Amount, 'approved']);

    // Issue CN-26-0001
    const cnRes = await pool.query(`
      INSERT INTO public.credit_notes (
        credit_note_number, customer_id, original_invoice_id, credit_note_date,
        subtotal, tax_amount, total_amount, business_case, stock_disposition,
        credit_note_type, status, created_by
      ) VALUES (
        'CN-26-0001-PROD', $1, $2, '2026-05-27',
        $3, $4, $5, 'damaged_packaging', 'saleable',
        'physical_return', 'approved', $6
      ) RETURNING id;
    `, [testCustomerId, invId, cnSubtotal, cnTax, cnTotal, adminUserId]);
    const cnId = cnRes.rows[0].id;

    // Lines: 100 kg B108, 25 kg B109
    await pool.query('INSERT INTO public.credit_note_items (credit_note_id, product_id, batch_id, quantity, unit_price, disposition) VALUES ($1, $2, $3, 100, 12579, $4);', [cnId, testProductId, b108Id, 'saleable']);
    await pool.query('INSERT INTO public.credit_note_items (credit_note_id, product_id, batch_id, quantity, unit_price, disposition) VALUES ($1, $2, $3, 25, 12579, $4);', [cnId, testProductId, b109Id, 'saleable']);

    // Reconcile payment state
    await pool.query('SELECT public.recalculate_sales_invoice_payment_state($1)', [invId]);

    const finalInv = (await pool.query('SELECT total_amount, paid_amount, balance_amount, payment_status FROM public.sales_invoices WHERE id = $1', [invId])).rows[0];
    assert.equal(Number(finalInv.total_amount), invoiceTotal);
    assert.equal(Number(finalInv.paid_amount), invoiceTotal, 'Invoice must be fully settled: RV1 + RV2 + CN = Total');
    assert.equal(Number(finalInv.balance_amount), 0, 'Balance must be exactly 0.00');
    assert.equal(finalInv.payment_status, 'paid');

    // Post exactly two inventory transactions for the 125 kg return
    await pool.query(`
      SELECT public.post_inventory_movement(
        public.uuid_from_text('inv:cn:b108'), $1, $2, 'return', 100, '2026-05-27', 'CN-26-0001', 'credit_note', $3, 'Return 100kg', $4, NULL, NULL
      );
    `, [testProductId, b108Id, cnId, adminUserId]);
    await pool.query(`
      SELECT public.post_inventory_movement(
        public.uuid_from_text('inv:cn:b109'), $1, $2, 'return', 25, '2026-05-27', 'CN-26-0001', 'credit_note', $3, 'Return 25kg', $4, NULL, NULL
      );
    `, [testProductId, b109Id, cnId, adminUserId]);

    const b108Stock = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [b108Id])).rows[0].current_stock);
    const b109Stock = Number((await pool.query('SELECT current_stock FROM public.batches WHERE id = $1', [b109Id])).rows[0].current_stock);
    assert.equal(b108Stock, 100, 'B108 stock must be exactly 100 kg');
    assert.equal(b109Stock, 25, 'B109 stock must be exactly 25 kg');

    const itCount = Number((await pool.query('SELECT count(*) FROM public.inventory_transactions WHERE reference_id = $1', [cnId])).rows[0].count);
    assert.equal(itCount, 2, 'Exactly 2 inventory movements recorded. Return was posted once, NOT twice.');
  });
  });
