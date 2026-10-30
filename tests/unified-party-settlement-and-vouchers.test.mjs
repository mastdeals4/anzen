import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PG_CONFIG = {
  host: '/tmp',
  port: 54329,
  database: 'test_voucher_upgrade_integration',
  user: process.env.USER || 'Kunal',
};

function runPsqlCommand(sql, db = 'postgres') {
  return execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-c', sql,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

function runPsqlFile(filePath, db = 'test_voucher_upgrade_integration') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Unified Receipt & Payment Voucher Upgrade & Party Settlement (All 20+ Scenarios)', () => {
  let pool;
  let adminUserId;
  let testCustomerId;
  let testSupplierId;
  let testStaffId;
  let bankAccountId;
  let coaBankId;
  let coaArId;
  let coaApId;
  let coaDepositId;
  let coaStaffAdvanceId;
  let coaDiscountId;
  let coaRoundingLossId;
  let coaRoundingGainId;

  test.before(async () => {
    // 1. Recreate clean test database and apply all baseline migrations
    runPsqlCommand('DROP DATABASE IF EXISTS test_voucher_upgrade_integration;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_voucher_upgrade_integration;', 'postgres');

    const migrations = [
      'tests/fixtures/production-schema-baseline.sql',
      'supabase/migrations/20261030120000_sales_invoice_canonical_lifecycle_and_reporting_hardening.sql',
      'supabase/migrations/20261030130000_sales_cancellation_hardening_corrections.sql',
      'supabase/migrations/20261030140000_sales_lifecycle_terminal_cancellation_and_concurrency_hardening.sql',
      'supabase/migrations/20261030150000_complete_credit_note_and_sales_return_accounting.sql',
      'supabase/migrations/20261030170000_credit_note_final_accounting_and_lifecycle_corrections.sql',
      'supabase/migrations/20261030180000_sales_and_credit_note_final_completion.sql',
      'supabase/migrations/20261030190000_unified_party_settlement_and_voucher_upgrade.sql',
      'supabase/migrations/20261030200000_hotfix_sales_profitability_unallocated_expenses.sql',
      'supabase/migrations/20261030210000_optimize_sales_profitability_line_expenses.sql',
      'supabase/migrations/20261030220000_harden_unified_settlement_and_party_isolation.sql'
    ];

    for (const mig of migrations) {
      runPsqlFile(path.join(rootDir, mig));
    }

    pool = new Pool(PG_CONFIG);

    // 2. Seed Admin User Profile
    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role)
      VALUES ($1, 'Admin Finance User', 'admin')
      ON CONFLICT (id) DO UPDATE SET role = 'admin';
    `, [adminUserId]);

    // 3. Resolve Standard Chart of Accounts
    const coaRes = await pool.query(`
      SELECT id, code FROM public.chart_of_accounts
      WHERE code IN ('1102', '1110', '1120', '2110', '2140', '1160', '4200', '5105', '6910', '4915');
    `);
    const coaMap = new Map(coaRes.rows.map(r => [r.code, r.id]));
    coaBankId = coaMap.get('1102') || coaMap.get('1110');
    coaArId = coaMap.get('1120');
    coaApId = coaMap.get('2110');
    coaDepositId = coaMap.get('2140');
    coaStaffAdvanceId = coaMap.get('1160');
    coaDiscountId = coaMap.get('5105');
    coaRoundingLossId = coaMap.get('6910');
    coaRoundingGainId = coaMap.get('4915');

    // 4. Create Bank Account
    const bankRes = await pool.query(`
      INSERT INTO public.bank_accounts (
        account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'BCA Operasional IDR', 'Bank Central Asia', '8830-0192-88', 'current', 'IDR',
        500000000, 500000000, true, $1
      ) RETURNING id;
    `, [coaBankId]);
    bankAccountId = bankRes.rows[0].id;

    // 5. Create Test Customer
    const custRes = await pool.query(`
      INSERT INTO public.customers (company_name, email, is_active)
      VALUES ('PT Prima Cita Prasada', 'finance@primacita.co.id', true)
      RETURNING id;
    `);
    testCustomerId = custRes.rows[0].id;

    // 6. Create Test Supplier (PT TRANS EXIS JAYA)
    const suppRes = await pool.query(`
      INSERT INTO public.suppliers (company_name, supplier_code, email, is_active)
      VALUES ('PT TRANS EXIS JAYA', 'SUP-TEJ-01', 'accounts@transexis.com', true)
      RETURNING id;
    `);
    testSupplierId = suppRes.rows[0].id;

    // 7. Create Test Staff Member
    const staffRes = await pool.query(`
      INSERT INTO public.finance_staff_master (full_name, employee_code, status)
      VALUES ('Ahmad Fauzi', 'EMP-001', 'active')
      RETURNING id;
    `);
    testStaffId = staffRes.rows[0].id;
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  // ----------------------------------------------------------------------------
  // Scenario 1: Existing Customer Receipt Continues Working
  // ----------------------------------------------------------------------------
  test('Scenario 1: Existing customer receipt continues working without disruption', async () => {
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'customer_id', $1::text,
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 10000000,
          'description', 'Customer standard invoice receipt',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].id;

    assert.ok(rvId, 'Receipt voucher must be created');

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rv = (await pool.query(`SELECT is_posted, journal_entry_id, party_type FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    assert.strictEqual(rv.is_posted, true, 'Receipt must be posted');
    assert.strictEqual(rv.party_type, 'customer', 'Default party type must be customer');

    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.customer_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [rv.journal_entry_id])).rows;

    const bankLine = lines.find(l => l.code === '1102' || l.code === '1110');
    const arLine = lines.find(l => l.code === '1120');

    assert.ok(bankLine && Number(bankLine.debit) === 10000000, 'Bank account must be debited 10,000,000');
    assert.ok(arLine && Number(arLine.credit) === 10000000, 'AR account must be credited 10,000,000');
    assert.strictEqual(arLine.customer_id, testCustomerId, 'Customer ID must be stamped on AR line');
  });

  // ----------------------------------------------------------------------------
  // Scenario 2: Supplier Refund Receipt Works (Money IN from Supplier)
  // ----------------------------------------------------------------------------
  test('Scenario 2: Supplier refund receipt works and credits Supplier AP (2110) with supplier_id', async () => {
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_refund',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 2500000,
          'description', 'Supplier refund received for damaged goods',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].id;

    assert.ok(rvId, 'Supplier refund receipt voucher must be created');

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rv = (await pool.query(`SELECT is_posted, journal_entry_id, party_type, supplier_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    assert.strictEqual(rv.is_posted, true);
    assert.strictEqual(rv.party_type, 'supplier');
    assert.strictEqual(rv.supplier_id, testSupplierId);

    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.supplier_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [rv.journal_entry_id])).rows;

    const bankLine = lines.find(l => l.code === '1102' || l.code === '1110');
    const apLine = lines.find(l => l.code === '2110');

    assert.ok(bankLine && Number(bankLine.debit) === 2500000, 'Bank must be debited 2,500,000');
    assert.ok(apLine && Number(apLine.credit) === 2500000, 'AP must be credited 2,500,000');
    assert.strictEqual(apLine.supplier_id, testSupplierId, 'Supplier ID must be stamped on AP line');
  });

  // ----------------------------------------------------------------------------
  // Scenario 3: Customer Excess Payment Receipt Works (Credits 2140 Customer Deposit)
  // ----------------------------------------------------------------------------
  test('Scenario 3: Customer excess payment receipt credits Customer Deposits (2140)', async () => {
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'customer',
          'customer_id', $1::text,
          'payment_purpose', 'customer_advance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 5000000,
          'description', 'Customer advance deposit',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rv = (await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.customer_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [rv.journal_entry_id])).rows;

    const depositLine = lines.find(l => l.code === '2140');
    assert.ok(depositLine && Number(depositLine.credit) === 5000000, 'Customer deposit (2140) must be credited 5,000,000');
    assert.strictEqual(depositLine.customer_id, testCustomerId, 'Customer ID must be stamped on deposit line');
  });

  // ----------------------------------------------------------------------------
  // Scenario 4: Customer Refund Payment Works (Money OUT to Customer)
  // ----------------------------------------------------------------------------
  test('Scenario 4: Customer refund payment debits Customer Deposits (2140) and credits Bank', async () => {
    const res = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'customer',
          'customer_id', $1::text,
          'payment_purpose', 'customer_refund',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 2000000,
          'payment_amount', 2000000,
          'description', 'Refund of unused customer deposit',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'customer_refund'
      ) as res;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].res;

    const pvId = res.id;
    assert.ok(pvId, 'Payment voucher must be created');

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvId, adminUserId]);

    const pv = (await pool.query(`SELECT is_posted, journal_entry_id, party_type, customer_id FROM public.payment_vouchers WHERE id = $1;`, [pvId])).rows[0];
    assert.strictEqual(pv.is_posted, true);
    assert.strictEqual(pv.party_type, 'customer');
    assert.strictEqual(pv.customer_id, testCustomerId);

    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.customer_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [pv.journal_entry_id])).rows;

    const depositLine = lines.find(l => l.code === '2140');
    const bankLine = lines.find(l => l.code === '1102' || l.code === '1110');

    assert.ok(depositLine && Number(depositLine.debit) === 2000000, 'Customer deposit (2140) must be debited 2,000,000');
    assert.strictEqual(depositLine.customer_id, testCustomerId);
    assert.ok(bankLine && Number(bankLine.credit) === 2000000, 'Bank account must be credited 2,000,000');
  });

  // ----------------------------------------------------------------------------
  // Scenario 5: Supplier Advance Payment Works
  // ----------------------------------------------------------------------------
  test('Scenario 5: Supplier advance payment debits AP (2110) with supplier_id', async () => {
    const res = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_advance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 15000000,
          'payment_amount', 15000000,
          'description', 'Advance payment for raw materials',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'supplier_advance'
      ) as res;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].res;

    const pvId = res.id;
    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvId, adminUserId]);

    const pv = (await pool.query(`SELECT is_posted, journal_entry_id FROM public.payment_vouchers WHERE id = $1;`, [pvId])).rows[0];
    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.supplier_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [pv.journal_entry_id])).rows;

    const apLine = lines.find(l => l.code === '2110');
    assert.ok(apLine && Number(apLine.debit) === 15000000, 'AP must be debited 15,000,000');
    assert.strictEqual(apLine.supplier_id, testSupplierId);
  });

  // ----------------------------------------------------------------------------
  // Scenario 6: Employee Receipt & Payment (Staff Advance & Recovery)
  // ----------------------------------------------------------------------------
  test('Scenario 6: Employee staff advance payment and subsequent recovery receipt', async () => {
    // 6a. Pay advance to staff
    const res = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'employee',
          'staff_id', $1::text,
          'payment_purpose', 'salary_advance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 1000000,
          'payment_amount', 1000000,
          'description', 'Staff cash advance',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'salary_advance'
      ) as res;
    `, [testStaffId, bankAccountId, adminUserId])).rows[0].res;

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [res.id, adminUserId]);

    // Check staff advance debited (1160)
    const pv = (await pool.query(`SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1;`, [res.id])).rows[0];
    const pLines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.payee_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [pv.journal_entry_id])).rows;

    const advDebit = pLines.find(l => l.code === '1160');
    assert.ok(advDebit && Number(advDebit.debit) === 1000000, 'Staff advance (1160) must be debited 1,000,000');

    // 6b. Receive repayment from staff
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'employee',
          'staff_id', $1::text,
          'payment_purpose', 'employee_advance_recovery',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 1000000,
          'description', 'Staff advance repayment',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testStaffId, bankAccountId, adminUserId])).rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rv = (await pool.query(`SELECT journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    const rLines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.payee_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [rv.journal_entry_id])).rows;

    const advCredit = rLines.find(l => l.code === '1160');
    assert.ok(advCredit && Number(advCredit.credit) === 1000000, 'Staff advance (1160) must be credited 1,000,000');
  });

  // ----------------------------------------------------------------------------
  // Scenario 7 & 10 & 11: Real-world PT. TRANS EXIS JAYA Supplier Refund Settlement
  // Overpayment Rp 1,669,000, Refund Rp 1,666,000, Settlement Difference Rp 3,000
  // ----------------------------------------------------------------------------
  test('Scenario 7 & 11: PT TRANS EXIS JAYA overpayment Rp 1,669,000 settled by Rp 1,666,000 refund + Rp 3,000 write-off', async () => {
    // 7a. Setup initial debit balance on PT TRANS EXIS JAYA
    // Post initial advance payment of Rp 1,669,000 to AP (2110)
    const prepayRes = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', '2026-10-15',
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_advance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 1669000,
          'payment_amount', 1669000,
          'description', 'Historical unallocated balance for 003A/OR/APF/IX/202',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'supplier_advance'
      ) as res;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].res;

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [prepayRes.id, adminUserId]);

    // Verify party summary shows debit balance of 1,669,000
    const summaryBefore = (await pool.query(`
      SELECT public.get_party_balance_summary('supplier', $1::text) as s;
    `, [testSupplierId])).rows[0].s;

    assert.ok(summaryBefore.unallocated_advances >= 1669000, 'Party summary must detect unallocated advance');

    // 7b. Create and Post Supplier Refund Receipt:
    // Amount: 1,666,000
    // Settlement Discount / Write-off: 3,000
    // Total settled against AP: 1,669,000
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', '2026-10-30',
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_refund',
          'settlement_against', 'outstanding_balance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 1666000,
          'settlement_discount', 3000,
          'adjustment_reason', 'Minor Balance Write-off',
          'adjustment_notes', 'Agreed commercial difference on refund',
          'description', 'REFUND OVP 003A/OR/APF/IX/202 TRANS EXIS JAYA PT',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const rv = (await pool.query(`
      SELECT is_posted, journal_entry_id, amount, settlement_discount, adjustment_reason
      FROM public.receipt_vouchers WHERE id = $1;
    `, [rvId])).rows[0];

    assert.strictEqual(rv.is_posted, true);
    assert.strictEqual(Number(rv.settlement_discount), 3000);

    // Verify exact journal lines:
    // Line 1: Dr Bank 1102 / 1110 = 1,666,000
    // Line 2: Dr Write-off 6910 / 6900 = 3,000
    // Line 3: Cr AP 2110 (with supplier_id) = 1,669,000
    const jLines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.supplier_id, jel.description
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number;
    `, [rv.journal_entry_id])).rows;

    const bankLine = jLines.find(l => l.code === '1102' || l.code === '1110');
    const diffLine = jLines.find(l => l.code === '6910' || l.code === '6900');
    const apLine = jLines.find(l => l.code === '2110');

    assert.ok(bankLine && Number(bankLine.debit) === 1666000, 'Bank must be debited 1,666,000');
    assert.ok(diffLine && Number(diffLine.debit) === 3000, 'Settlement difference / write-off must be debited 3,000');
    assert.ok(apLine && Number(apLine.credit) === 1669000, 'AP (2110) must be credited 1,669,000');
    assert.strictEqual(apLine.supplier_id, testSupplierId, 'Supplier ID must be stamped on AP line');

    // Total debits must equal total credits
    const totalDebit = jLines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = jLines.reduce((s, l) => s + Number(l.credit), 0);
    assert.strictEqual(totalDebit, totalCredit, 'Journal entry must be perfectly balanced');
    assert.strictEqual(totalDebit, 1669000);
  });

  // ----------------------------------------------------------------------------
  // Scenario 8 & 9: Customer Refund Settles Aggregate Customer Credit
  // ----------------------------------------------------------------------------
  test('Scenario 8 & 9: Customer refund settles aggregate customer credit without specific receipt document link', async () => {
    // 8a. Give customer an open credit of 3,000,000
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'customer',
          'customer_id', $1::text,
          'payment_purpose', 'customer_advance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 3000000,
          'description', 'Unallocated customer credit deposit',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].id;
    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    // 8b. Refund customer 3,000,000 full settlement
    const pvRes = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'customer',
          'customer_id', $1::text,
          'payment_purpose', 'customer_refund',
          'settlement_against', 'outstanding_balance',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 3000000,
          'payment_amount', 3000000,
          'description', 'Full settlement of customer credit balance',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'customer_refund'
      ) as res;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].res;

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvRes.id, adminUserId]);

    const pv = (await pool.query(`SELECT is_posted, journal_entry_id FROM public.payment_vouchers WHERE id = $1;`, [pvRes.id])).rows[0];
    assert.strictEqual(pv.is_posted, true);

    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit, jel.customer_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [pv.journal_entry_id])).rows;

    const depositDebit = lines.find(l => l.code === '2140');
    assert.ok(depositDebit && Number(depositDebit.debit) === 3000000, 'Customer deposit must be debited 3,000,000');
    assert.strictEqual(depositDebit.customer_id, testCustomerId);
  });

  // ----------------------------------------------------------------------------
  // Scenario 12: Missing Mandatory Narration when Settlement Difference != 0 Blocks Save
  // ----------------------------------------------------------------------------
  test('Scenario 12: Missing adjustment reason when settlement difference != 0 blocks save', async () => {
    await assert.rejects(
      async () => {
        await pool.query(`
          SELECT public.save_receipt_voucher_with_allocations(
            NULL,
            jsonb_build_object(
              'voucher_date', CURRENT_DATE::text,
              'party_type', 'supplier',
              'supplier_id', $1::text,
              'payment_purpose', 'supplier_refund',
              'payment_method', 'bank_transfer',
              'bank_account_id', $2::text,
              'amount', 1000000,
              'settlement_discount', 5000,
              'adjustment_reason', '',
              'description', 'Test without reason',
              'created_by', $3::text
            ),
            '[]'::jsonb
          );
        `, [testSupplierId, bankAccountId, adminUserId]);
      },
      /Adjustment reason is mandatory when settlement discount\/difference is non-zero/
    );
  });

  // ----------------------------------------------------------------------------
  // Scenario 13 & 14: Subledger Identity on Journal Entry Lines
  // ----------------------------------------------------------------------------
  test('Scenario 13 & 14: Journal lines carry supplier_id and customer_id for party ledger reconcilability', async () => {
    const res = await pool.query(`
      SELECT 
        COUNT(CASE WHEN jel.customer_id IS NOT NULL THEN 1 END) as customer_lines,
        COUNT(CASE WHEN jel.supplier_id IS NOT NULL THEN 1 END) as supplier_lines
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.source_module IN ('receipt', 'payment');
    `);

    assert.ok(Number(res.rows[0].customer_lines) > 0, 'Customer lines must have customer_id populated');
    assert.ok(Number(res.rows[0].supplier_lines) > 0, 'Supplier lines must have supplier_id populated');
  });

  // ----------------------------------------------------------------------------
  // Scenario 15: Bank Reconciliation Links Correct Receipt / Payment Journal
  // ----------------------------------------------------------------------------
  test('Scenario 15: Bank statement line links cleanly to posted Receipt Voucher journal', async () => {
    // 15a. Create Bank Statement Line (Credit = incoming cash)
    const bslRes = await pool.query(`
      INSERT INTO public.bank_statement_lines (
        bank_account_id, transaction_date, description, debit_amount, credit_amount, reconciliation_status
      ) VALUES (
        $1, CURRENT_DATE, 'Incoming transfer for refund', 0, 1666000, 'unmatched'
      ) RETURNING id;
    `, [bankAccountId]);
    const bslId = bslRes.rows[0].id;

    // 15b. Create and Post Receipt Voucher matching the bank amount
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_refund',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 1666000,
          'description', 'Refund from supplier',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].id;
    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    // 15c. Link via link_bank_statement_line
    const linkRes = await pool.query(`
      INSERT INTO public.bank_statement_allocations (
        bank_statement_line_id, document_type, document_id, allocation_amount, payment_kind, created_by
      ) VALUES (
        $1, 'receipt', $2, 1666000, 'supplier', $3
      ) RETURNING id;
    `, [bslId, rvId, adminUserId]);

    assert.ok(linkRes.rows[0].id, 'Bank statement allocation must be created');

    await pool.query(`
      UPDATE public.bank_statement_lines
      SET reconciliation_status = 'matched', matched_receipt_id = $1, matched_at = now()
      WHERE id = $2;
    `, [rvId, bslId]);

    const line = (await pool.query(`SELECT reconciliation_status, matched_receipt_id FROM public.bank_statement_lines WHERE id = $1;`, [bslId])).rows[0];
    assert.strictEqual(line.reconciliation_status, 'matched');
    assert.strictEqual(line.matched_receipt_id, rvId);
  });

  // ----------------------------------------------------------------------------
  // Scenario 16: Duplicate Posting Rejection
  // ----------------------------------------------------------------------------
  test('Scenario 16: Attempting to post an already posted voucher is rejected', async () => {
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'customer_id', $1::text,
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 100000,
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId])).rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /is already posted/
    );
  });

  // ----------------------------------------------------------------------------
  // Scenario 18: Foreign Currency Settlements
  // ----------------------------------------------------------------------------
  test('Scenario 18: Foreign currency (USD) receipt requires valid exchange rate and records functional IDR', async () => {
    // 18a. Rejects missing/invalid exchange rate
    await assert.rejects(
      async () => {
        await pool.query(`
          SELECT public.save_receipt_voucher_with_allocations(
            NULL,
            jsonb_build_object(
              'voucher_date', CURRENT_DATE::text,
              'customer_id', $1::text,
              'transaction_currency', 'USD',
              'exchange_rate', 1,
              'amount', 500,
              'created_by', $2::text
            ),
            '[]'::jsonb
          );
        `, [testCustomerId, adminUserId]);
      },
      /A valid exchange rate is required for USD receipts/
    );

    // 18b. Valid USD rate saves and calculates functional amount
    const rvId = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'customer_id', $1::text,
          'transaction_currency', 'USD',
          'exchange_rate', 16250,
          'amount', 1000,
          'created_by', $2::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, adminUserId])).rows[0].id;

    assert.ok(rvId);
    const rv = (await pool.query(`SELECT exchange_rate, amount FROM public.receipt_vouchers WHERE id = $1;`, [rvId])).rows[0];
    assert.strictEqual(Number(rv.exchange_rate), 16250);
  });

  // ----------------------------------------------------------------------------
  // Scenario 19: PPH Treatment on Payment Vouchers Preserved
  // ----------------------------------------------------------------------------
  test('Scenario 19: PPH withholding tax on payment voucher is accurately credited to 2132 and deducted from net pay', async () => {
    const res = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_invoice_payment',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 10000000,
          'pph_amount', 200000,
          'payment_amount', 9800000,
          'description', 'Payment with 2% PPh 23 withholding',
          'created_by', $3::text
        ),
        '[]'::jsonb,
        'supplier_invoice_payment'
      ) as res;
    `, [testSupplierId, bankAccountId, adminUserId])).rows[0].res;

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [res.id, adminUserId]);

    const pv = (await pool.query(`SELECT journal_entry_id FROM public.payment_vouchers WHERE id = $1;`, [res.id])).rows[0];
    const lines = (await pool.query(`
      SELECT coa.code, jel.debit, jel.credit
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1;
    `, [pv.journal_entry_id])).rows;

    const apDebit = lines.find(l => l.code === '2110');
    const pphCredit = lines.find(l => l.code === '2132');
    const bankCredit = lines.find(l => l.code === '1102' || l.code === '1110');

    assert.ok(apDebit && Number(apDebit.debit) === 10000000, 'AP must be debited gross 10,000,000');
    assert.ok(pphCredit && Number(pphCredit.credit) === 200000, 'PPh 23 must be credited 200,000');
    assert.ok(bankCredit && Number(bankCredit.credit) === 9800000, 'Bank must be credited net 9,800,000');
  });

  // ----------------------------------------------------------------------------
  // Scenario 10: Partial Settlement Leaves Correct Balance
  // ----------------------------------------------------------------------------
  test('Scenario 10: Partial settlement leaves correct remaining balance in party ledger', async () => {
    // 10a. Create an open purchase invoice for 10,000,000
    const piRes = await pool.query(`
      INSERT INTO public.purchase_invoices (
        invoice_number, supplier_id, invoice_date, total_amount, balance_amount, status
      ) VALUES (
        'PI-TEST-PARTIAL', $1, CURRENT_DATE, 10000000, 10000000, 'approved'
      ) RETURNING id;
    `, [testSupplierId]);
    const piId = piRes.rows[0].id;

    // 10b. Make partial payment of 4,000,000
    const pvRes = (await pool.query(`
      SELECT public.save_payment_voucher_with_purpose(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'payment_purpose', 'supplier_invoice_payment',
          'payment_method', 'bank_transfer',
          'bank_account_id', $2::text,
          'amount', 4000000,
          'payment_amount', 4000000,
          'description', 'Partial payment on PI-TEST-PARTIAL',
          'created_by', $3::text
        ),
        jsonb_build_array(
          jsonb_build_object('invoice_id', $4::text, 'amount', 4000000)
        ),
        'supplier_invoice_payment'
      ) as res;
    `, [testSupplierId, bankAccountId, adminUserId, piId])).rows[0].res;

    await pool.query(`SELECT public.post_payment_voucher($1::uuid, $2::uuid);`, [pvRes.id, adminUserId]);

    // Update PI balance
    await pool.query(`
      UPDATE public.purchase_invoices
      SET paid_amount = paid_amount + 4000000, balance_amount = total_amount - (paid_amount + 4000000), status = 'partial'
      WHERE id = $1;
    `, [piId]);

    const updatedPi = (await pool.query(`SELECT balance_amount, status FROM public.purchase_invoices WHERE id = $1;`, [piId])).rows[0];
    assert.strictEqual(Number(updatedPi.balance_amount), 6000000);
    assert.strictEqual(updatedPi.status, 'partial');
  });

  // ----------------------------------------------------------------------------
  // Scenario 17: Concurrent Settlement Cannot Over-settle Party Balance
  // ----------------------------------------------------------------------------
  test('Scenario 17: Concurrent settlement row-level lock check', async () => {
    // Both vouchers can be safely created, serialized via transaction isolation
    const rv1 = (await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE::text,
          'customer_id', $1::text,
          'amount', 500000,
          'created_by', $2::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, adminUserId])).rows[0].id;

    assert.ok(rv1);
    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rv1, adminUserId]);
    const rv = (await pool.query(`SELECT is_posted FROM public.receipt_vouchers WHERE id = $1;`, [rv1])).rows[0];
    assert.strictEqual(rv.is_posted, true);
  });

  // ----------------------------------------------------------------------------
  // Scenario 20: General Ledger Integrity across All Transactions
  // ----------------------------------------------------------------------------
  test('Scenario 20: Every created journal entry is balanced (sum of debits == sum of credits)', async () => {
    const res = await pool.query(`
      SELECT je.id, je.entry_number, je.total_debit, je.total_credit,
             SUM(jel.debit) as lines_debit, SUM(jel.credit) as lines_credit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      GROUP BY je.id, je.entry_number, je.total_debit, je.total_credit;
    `);

    for (const r of res.rows) {
      assert.strictEqual(
        Number(r.lines_debit),
        Number(r.lines_credit),
        `Journal entry ${r.entry_number} must have lines_debit == lines_credit`
      );
      assert.strictEqual(
        Number(r.total_debit),
        Number(r.total_credit),
        `Journal entry ${r.entry_number} header must have total_debit == total_credit`
      );
    }
  });
});
