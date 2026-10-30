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
  database: 'test_voucher_concurrency_isolation',
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

function runPsqlFile(filePath, db = 'test_voucher_concurrency_isolation') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Multi-Connection Concurrency, Party Isolation & Security Verification', () => {
  let pool;
  let adminUserId;
  let testCustomerId;
  let testSupplierId;
  let bankAccountId;
  let coaBankId;
  let coaApId;
  let coaArId;
  let coaDiffId;
  let directorAId;
  let directorBId;
  let directorALoanAccId;
  let directorBLoanAccId;

  test.before(async () => {
    runPsqlCommand('DROP DATABASE IF EXISTS test_voucher_concurrency_isolation;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_voucher_concurrency_isolation;', 'postgres');

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

    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role)
      VALUES ($1, 'Admin Finance User', 'admin')
      ON CONFLICT (id) DO UPDATE SET role = 'admin';
    `, [adminUserId]);

    const coaRes = await pool.query(`
      SELECT id, code FROM public.chart_of_accounts
      WHERE code IN ('1102', '1110', '1120', '2110', '2140', '1160', '4200', '6910');
    `);
    const coaMap = new Map(coaRes.rows.map(r => [r.code, r.id]));
    coaBankId = coaMap.get('1102') || coaMap.get('1110');
    coaArId = coaMap.get('1120');
    coaApId = coaMap.get('2110');
    coaDiffId = coaMap.get('6910');

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

    const custRes = await pool.query(`
      INSERT INTO public.customers (company_name, email, is_active)
      VALUES ('PT Multi Kharisma Solusi', 'finance@multikharisma.com', true)
      RETURNING id;
    `);
    testCustomerId = custRes.rows[0].id;

    const suppRes = await pool.query(`
      INSERT INTO public.suppliers (company_name, supplier_code, email, is_active)
      VALUES ('PT TRANS EXIS JAYA', 'SUP-TEJ-CONCUR', 'finance@transexis.com', true)
      RETURNING id;
    `);
    testSupplierId = suppRes.rows[0].id;

    // Create 2 separate Director loan accounts and directors
    const dirLoanARes = await pool.query(`
      INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
      VALUES ('2105-A', 'Director Loan – Director Alpha', 'liability', 'credit', true)
      RETURNING id;
    `);
    directorALoanAccId = dirLoanARes.rows[0].id;

    const dirLoanBRes = await pool.query(`
      INSERT INTO public.chart_of_accounts (code, name, account_type, normal_balance, is_active)
      VALUES ('2105-B', 'Director Loan – Director Beta', 'liability', 'credit', true)
      RETURNING id;
    `);
    directorBLoanAccId = dirLoanBRes.rows[0].id;

    const dirARes = await pool.query(`
      INSERT INTO public.directors (full_name, loan_account_id)
      VALUES ('Director Alpha', $1)
      RETURNING id;
    `, [directorALoanAccId]);
    directorAId = dirARes.rows[0].id;

    const dirBRes = await pool.query(`
      INSERT INTO public.directors (full_name, loan_account_id)
      VALUES ('Director Beta', $1)
      RETURNING id;
    `, [directorBLoanAccId]);
    directorBId = dirBRes.rows[0].id;
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  // ----------------------------------------------------------------------------
  // Test 1: Concurrency - Simultaneous Posting of the Same Receipt Voucher
  // ----------------------------------------------------------------------------
  test('Concurrency 1: Simultaneous posting of the same receipt voucher via separate client connections', async () => {
    const rvRes = await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE,
          'party_type', 'customer',
          'customer_id', $1::text,
          'bank_account_id', $2::text,
          'amount', 15000000,
          'payment_method', 'bank_transfer',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    // Open two simultaneous independent client connections
    const client1 = new Client(PG_CONFIG);
    const client2 = new Client(PG_CONFIG);
    await client1.connect();
    await client2.connect();

    try {
      const results = await Promise.allSettled([
        client1.query(`SELECT public.post_receipt_voucher($1, $2);`, [rvId, adminUserId]),
        client2.query(`SELECT public.post_receipt_voucher($1, $2);`, [rvId, adminUserId])
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one simultaneous post must succeed');
      assert.equal(rejected.length, 1, 'The concurrent attempt must be rejected');
      assert.match(rejected[0].reason.message, /already posted/i, 'Rejected call must indicate already posted');

      // Verify exactly one journal entry was created
      const jeRes = await pool.query(`
        SELECT count(*) as count FROM public.journal_entries
        WHERE source_module = 'receipt' AND reference_id = $1;
      `, [rvId]);
      assert.equal(parseInt(jeRes.rows[0].count, 10), 1, 'Exactly one journal entry created');
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  // ----------------------------------------------------------------------------
  // Test 2: Concurrency - Simultaneous Posting of the Same Payment Voucher
  // ----------------------------------------------------------------------------
  test('Concurrency 2: Simultaneous posting of the same payment voucher via separate client connections', async () => {
    const pvRes = await pool.query(`
      SELECT public.save_payment_voucher_with_allocations(
        NULL,
        public.next_payment_voucher_number(CURRENT_DATE),
        CURRENT_DATE,
        $1,
        'bank_transfer',
        $2,
        'REF-CONCUR-PV',
        8000000,
        0,
        NULL,
        'Supplier advance concurrent post test',
        'IDR',
        1,
        8000000,
        0,
        $3,
        '[]'::jsonb,
        NULL,
        'supplier_advance',
        'supplier'
      ) as id;
    `, [testSupplierId, bankAccountId, adminUserId]);
    const pvId = pvRes.rows[0].id;

    const client1 = new Client(PG_CONFIG);
    const client2 = new Client(PG_CONFIG);
    await client1.connect();
    await client2.connect();

    try {
      const results = await Promise.allSettled([
        client1.query(`SELECT public.post_payment_voucher($1, $2);`, [pvId, adminUserId]),
        client2.query(`SELECT public.post_payment_voucher($1, $2);`, [pvId, adminUserId])
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Exactly one post payment voucher must succeed');
      assert.equal(rejected.length, 1, 'Concurrent post payment voucher must be rejected');
      assert.match(rejected[0].reason.message, /already posted/i, 'Rejected call must indicate already posted');

      const jeRes = await pool.query(`
        SELECT count(*) as count FROM public.journal_entries
        WHERE source_module = 'payment' AND reference_id = $1;
      `, [pvId]);
      assert.equal(parseInt(jeRes.rows[0].count, 10), 1, 'Exactly one journal entry created');
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  // ----------------------------------------------------------------------------
  // Test 3: Concurrency - Simultaneous Allocations Exceeding Sales Invoice Total
  // ----------------------------------------------------------------------------
  test('Concurrency 3: Row locking on sales invoice prevents concurrent overallocation', async () => {
    // Create sales invoice for Rp 10,000,000
    const invRes = await pool.query(`
      INSERT INTO public.sales_invoices (
        invoice_number, invoice_date, customer_id, total_amount, paid_amount, balance_amount,
        payment_status, document_status, is_draft
      ) VALUES (
        'INV-CONCUR-001', CURRENT_DATE, $1, 10000000, 0, 10000000,
        'pending', 'posted', false
      ) RETURNING id;
    `, [testCustomerId]);
    const invoiceId = invRes.rows[0].id;

    // Create Receipt 1 for Rp 8,000,000
    const r1Res = await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE,
          'party_type', 'customer',
          'customer_id', $1::text,
          'bank_account_id', $2::text,
          'amount', 8000000,
          'payment_method', 'bank_transfer',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId]);
    const rv1Id = r1Res.rows[0].id;

    // Create Receipt 2 for Rp 8,000,000
    const r2Res = await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE,
          'party_type', 'customer',
          'customer_id', $1::text,
          'bank_account_id', $2::text,
          'amount', 8000000,
          'payment_method', 'bank_transfer',
          'created_by', $3::text
        ),
        '[]'::jsonb
      ) as id;
    `, [testCustomerId, bankAccountId, adminUserId]);
    const rv2Id = r2Res.rows[0].id;

    // Try allocating 8,000,000 from both vouchers simultaneously to the 10,000,000 invoice
    const client1 = new Client(PG_CONFIG);
    const client2 = new Client(PG_CONFIG);
    await client1.connect();
    await client2.connect();

    try {
      const results = await Promise.allSettled([
        client1.query(`
          INSERT INTO public.voucher_allocations (receipt_voucher_id, sales_invoice_id, allocated_amount, voucher_type)
          VALUES ($1, $2, 8000000, 'receipt');
        `, [rv1Id, invoiceId]),
        client2.query(`
          INSERT INTO public.voucher_allocations (receipt_voucher_id, sales_invoice_id, allocated_amount, voucher_type)
          VALUES ($1, $2, 8000000, 'receipt');
        `, [rv2Id, invoiceId])
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'Only one allocation can succeed within invoice limit');
      assert.equal(rejected.length, 1, 'The overallocating transaction must be blocked/rejected');
      assert.match(rejected[0].reason.message, /exceeds sales invoice total amount/i);
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  // ----------------------------------------------------------------------------
  // Test 4: Director Identity Balance Isolation
  // ----------------------------------------------------------------------------
  test('Director isolation: get_party_balance_summary strictly isolates balances between Director Alpha and Director Beta', async () => {
    // Director Alpha contributes Rp 5,000,000 (Cr Loan Acc A)
    const jeARes = await pool.query(`
      INSERT INTO public.journal_entries (
        entry_number, entry_date, source_module, description, total_debit, total_credit, is_posted
      ) VALUES (
        'JE-DIR-ALPHA', CURRENT_DATE, 'general', 'Director Alpha Loan Contribution', 5000000, 5000000, true
      ) RETURNING id;
    `);
    const jeAId = jeARes.rows[0].id;
    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, payee_id)
      VALUES ($1, 1, $2, 5000000, 0, $3);
    `, [jeAId, coaBankId, directorAId]);
    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, payee_id)
      VALUES ($1, 2, $2, 0, 5000000, $3);
    `, [jeAId, directorALoanAccId, directorAId]);

    // Director Beta contributes Rp 12,000,000 (Cr Loan Acc B)
    const jeBRes = await pool.query(`
      INSERT INTO public.journal_entries (
        entry_number, entry_date, source_module, description, total_debit, total_credit, is_posted
      ) VALUES (
        'JE-DIR-BETA', CURRENT_DATE, 'general', 'Director Beta Loan Contribution', 12000000, 12000000, true
      ) RETURNING id;
    `);
    const jeBId = jeBRes.rows[0].id;
    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, payee_id)
      VALUES ($1, 1, $2, 12000000, 0, $3);
    `, [jeBId, coaBankId, directorBId]);
    await pool.query(`
      INSERT INTO public.journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, payee_id)
      VALUES ($1, 2, $2, 0, 12000000, $3);
    `, [jeBId, directorBLoanAccId, directorBId]);

    // Query balance for Director Alpha
    const balARes = await pool.query(`
      SELECT public.get_party_balance_summary('director', $1) as summary;
    `, [directorAId]);
    const summaryA = balARes.rows[0].summary;

    // Query balance for Director Beta
    const balBRes = await pool.query(`
      SELECT public.get_party_balance_summary('director', $1) as summary;
    `, [directorBId]);
    const summaryB = balBRes.rows[0].summary;

    assert.equal(summaryA.net_balance, 5000000, 'Director Alpha balance must be exactly 5,000,000, NOT combined');
    assert.equal(summaryA.balance_direction, 'debit');
    assert.equal(summaryB.net_balance, 12000000, 'Director Beta balance must be exactly 12,000,000, NOT combined');
    assert.equal(summaryB.balance_direction, 'debit');
  });

  // ----------------------------------------------------------------------------
  // Test 5: Rejection of Negative Settlement Discounts
  // ----------------------------------------------------------------------------
  test('Discount validation: Negative settlement discounts are strictly rejected', async () => {
    // 1. Payment voucher with negative settlement discount
    await assert.rejects(
      pool.query(`
        SELECT public.save_payment_voucher_with_allocations(
          NULL, 'PV-TEST-NEG', CURRENT_DATE, $1::uuid, 'bank_transfer', $2::uuid, NULL,
          1000000, 0, NULL, 'Negative discount test', 'IDR', 1, 1000000, 0, $3::uuid,
          '[]'::jsonb, NULL, 'general', 'supplier', NULL, 'outstanding_balance',
          -500, 'Invalid negative discount', NULL, NULL
        );
      `, [testSupplierId, bankAccountId, adminUserId]),
      /Settlement discount cannot be negative/i
    );

    // 2. Receipt voucher with negative settlement discount
    await assert.rejects(
      pool.query(`
        SELECT public.save_receipt_voucher_with_allocations(
          NULL,
          jsonb_build_object(
            'voucher_date', CURRENT_DATE,
            'party_type', 'customer',
            'customer_id', $1::text,
            'bank_account_id', $2::text,
            'amount', 1000000,
            'settlement_discount', -250,
            'adjustment_reason', 'Negative discount',
            'created_by', $3::text
          ),
          '[]'::jsonb
        );
      `, [testCustomerId, bankAccountId, adminUserId]),
      /Settlement discount cannot be negative/i
    );

    // 3. Receipt voucher with missing adjustment reason when discount != 0
    await assert.rejects(
      pool.query(`
        SELECT public.save_receipt_voucher_with_allocations(
          NULL,
          jsonb_build_object(
            'voucher_date', CURRENT_DATE,
            'party_type', 'customer',
            'customer_id', $1::text,
            'bank_account_id', $2::text,
            'amount', 1000000,
            'settlement_discount', 500,
            'adjustment_reason', '',
            'created_by', $3::text
          ),
          '[]'::jsonb
        );
      `, [testCustomerId, bankAccountId, adminUserId]),
      /Adjustment reason is mandatory when settlement discount/i
    );
  });

  // ----------------------------------------------------------------------------
  // Test 6: Rejection of Unsupported Party Types
  // ----------------------------------------------------------------------------
  test('Party validation: Unsupported party types are strictly rejected', async () => {
    await assert.rejects(
      pool.query(`
        SELECT public.save_payment_voucher_with_allocations(
          NULL, 'PV-TEST-PARTY', CURRENT_DATE, $1::uuid, 'bank_transfer', $2::uuid, NULL,
          1000000, 0, NULL, 'Bad party type test', 'IDR', 1, 1000000, 0, $3::uuid,
          '[]'::jsonb, NULL, 'general', 'alien', NULL, 'outstanding_balance',
          0, NULL, NULL, NULL
        );
      `, [testSupplierId, bankAccountId, adminUserId]),
      /Unsupported party type alien/i
    );

    await assert.rejects(
      pool.query(`
        SELECT public.save_receipt_voucher_with_allocations(
          NULL,
          jsonb_build_object(
            'voucher_date', CURRENT_DATE,
            'party_type', 'martian',
            'customer_id', $1::text,
            'bank_account_id', $2::text,
            'amount', 1000000,
            'created_by', $3::text
          ),
          '[]'::jsonb
        );
      `, [testCustomerId, bankAccountId, adminUserId]),
      /Unsupported party type martian/i
    );
  });

  // ----------------------------------------------------------------------------
  // Test 7: PT TRANS EXIS JAYA Supplier Refund Full Accounting Simulation
  // ----------------------------------------------------------------------------
  test('PT TRANS EXIS JAYA scenario: Rp 1,666,000 refund + Rp 3,000 write-off closes Rp 1,669,000 advance with balanced journals', async () => {
    // Dedicated supplier for PT TRANS EXIS JAYA refund scenario
    const tejRes = await pool.query(`
      INSERT INTO public.suppliers (company_name, supplier_code, email, is_active)
      VALUES ('PT TRANS EXIS JAYA REFUND', 'SUP-TEJ-REF', 'refund@transexis.com', true)
      RETURNING id;
    `);
    const refundSupplierId = tejRes.rows[0].id;

    // 1. Establish an unallocated payment voucher advance of Rp 1,669,000 to PT TRANS EXIS JAYA
    const pvRes = await pool.query(`
      SELECT public.save_payment_voucher_with_allocations(
        NULL,
        'PV-TEJ-ADV',
        CURRENT_DATE,
        $1,
        'bank_transfer',
        $2,
        'ADV-TRANS-EXIS',
        1669000,
        0,
        NULL,
        'Advance payment to PT TRANS EXIS JAYA',
        'IDR',
        1,
        1669000,
        0,
        $3,
        '[]'::jsonb,
        NULL,
        'supplier_advance',
        'supplier'
      ) as id;
    `, [refundSupplierId, bankAccountId, adminUserId]);
    const pvId = pvRes.rows[0].id;
    await pool.query(`SELECT public.post_payment_voucher($1, $2);`, [pvId, adminUserId]);

    // Verify supplier summary before refund: net_balance is -1,669,000 (credit/advance position)
    const beforeBal = (await pool.query(`
      SELECT public.get_party_balance_summary('supplier', $1) as summary;
    `, [refundSupplierId])).rows[0].summary;
    assert.equal(beforeBal.unallocated_advances, 1669000, 'Supplier advance of 1,669,000 recorded');
    assert.equal(beforeBal.net_balance, -1669000, 'Net supplier advance position is credit 1,669,000');

    // 2. PT TRANS EXIS JAYA refunds Rp 1,666,000 into Bank, Rp 3,000 difference written off to 6910
    const rvRes = await pool.query(`
      SELECT public.save_receipt_voucher_with_allocations(
        NULL,
        jsonb_build_object(
          'voucher_date', CURRENT_DATE,
          'party_type', 'supplier',
          'supplier_id', $1::text,
          'bank_account_id', $2::text,
          'amount', 1666000,
          'payment_method', 'bank_transfer',
          'payment_purpose', 'supplier_refund',
          'settlement_against', 'outstanding_balance',
          'settlement_discount', 3000,
          'adjustment_reason', 'Bank charge & rounding difference on refund',
          'adjustment_account_id', $3::text,
          'created_by', $4::text
        ),
        '[]'::jsonb
      ) as id;
    `, [refundSupplierId, bankAccountId, coaDiffId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    // Post the receipt voucher
    await pool.query(`SELECT public.post_receipt_voucher($1, $2);`, [rvId, adminUserId]);

    // 3. Verify Journal Entries created
    const jeRes = await pool.query(`
      SELECT id, entry_number, total_debit, total_credit
      FROM public.journal_entries
      WHERE source_module = 'receipt' AND reference_id = $1;
    `, [rvId]);
    assert.equal(jeRes.rows.length, 1, 'Exactly one journal entry created for refund');
    const je = jeRes.rows[0];
    assert.equal(parseFloat(je.total_debit), 1669000, 'Total debit must be 1,669,000 (1,666,000 bank + 3,000 diff)');
    assert.equal(parseFloat(je.total_credit), 1669000, 'Total credit must be 1,669,000 (clearing AP 2110)');
    assert.equal(parseFloat(je.total_debit), parseFloat(je.total_credit), 'Journal entry must be mathematically balanced');

    // Verify individual journal entry lines
    const jelRes = await pool.query(`
      SELECT jel.line_number, coa.code, jel.debit, jel.credit, jel.supplier_id
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [je.id]);
    assert.equal(jelRes.rows.length, 3, 'Must have 3 lines: Bank Dr, Adjustment Dr, AP 2110 Cr');

    // Line 1: Dr Bank 1,666,000
    assert.equal(jelRes.rows[0].code, '1102');
    assert.equal(parseFloat(jelRes.rows[0].debit), 1666000);
    assert.equal(parseFloat(jelRes.rows[0].credit), 0);

    // Line 2: Dr Adjustment 3,000
    assert.equal(jelRes.rows[1].code, '6910');
    assert.equal(parseFloat(jelRes.rows[1].debit), 3000);
    assert.equal(parseFloat(jelRes.rows[1].credit), 0);

    // Line 3: Cr AP (2110) 1,669,000 with supplier_id attached
    assert.equal(jelRes.rows[2].code, '2110');
    assert.equal(parseFloat(jelRes.rows[2].debit), 0);
    assert.equal(parseFloat(jelRes.rows[2].credit), 1669000);
    assert.equal(jelRes.rows[2].supplier_id, refundSupplierId, 'Supplier ID must be stamped on AP line for party ledger');

    // Verify GL Account 2110 balance for this supplier is now 0
    const glRes = await pool.query(`
      SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0) as net_ap
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.supplier_id = $1 AND coa.code = '2110';
    `, [refundSupplierId]);
    assert.equal(parseFloat(glRes.rows[0].net_ap), 0, 'General Ledger 2110 position for supplier must be exactly 0.00');
  });
});
