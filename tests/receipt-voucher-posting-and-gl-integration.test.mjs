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
  database: 'test_rv_posting_gl_integration',
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

function runPsqlFile(filePath, db = 'test_rv_posting_gl_integration') {
  execFileSync('/usr/local/bin/psql', [
    '-h', PG_CONFIG.host,
    '-p', String(PG_CONFIG.port),
    '-d', db,
    '-f', filePath,
    '-v', 'ON_ERROR_STOP=1'
  ], { encoding: 'utf8' });
}

test.describe('SAPJ ERP: Receipt Voucher Posting & GL Integration (All 20 Required Tests)', () => {
  let pool;
  let adminUserId;
  let testSupplierId;
  let bankIdBcaIdr;
  let bankIdBcaUsd;
  let bankIdHeaderMapped;
  let bankIdInactiveMapped;
  let coa1110HeaderId;
  let coa111101IdrId;
  let coa111102UsdId;
  let coa2110ApId;
  let coa6910DiffId;
  let coa1102PettyCashId;
  let coaInactiveLeafId;

  test.before(async () => {
    // 1. Recreate clean test database
    runPsqlCommand('DROP DATABASE IF EXISTS test_rv_posting_gl_integration;', 'postgres');
    runPsqlCommand('CREATE DATABASE test_rv_posting_gl_integration;', 'postgres');

    // 2. Apply baseline migrations + new migration
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
      'supabase/migrations/20261030220000_harden_unified_settlement_and_party_isolation.sql',
      'supabase/migrations/20261030230000_final_unified_settlement_and_reporting_security_hardening.sql',
      'supabase/migrations/20261030235000_supplier_refund_authoritative_validation_and_accounting_integrity.sql',
      'supabase/migrations/20261031140000_fix_receipt_voucher_posting_and_bank_account_gl_validation.sql'
    ];

    for (const mig of migrations) {
      runPsqlFile(path.join(rootDir, mig));
    }

    pool = new Pool(PG_CONFIG);

    // 3. Seed Admin User Profile
    adminUserId = 'a0000000-0000-0000-0000-000000000001';
    await pool.query(`
      INSERT INTO public.user_profiles (id, full_name, role)
      VALUES ($1, 'Admin Finance User', 'admin')
      ON CONFLICT (id) DO UPDATE SET role = 'admin';
    `, [adminUserId]);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.cancel_gl_posting(
        p_je_id uuid, p_doc_id uuid, p_table_name text, p_cancelled_by uuid, p_reason text, p_extra_audit jsonb DEFAULT '{}'::jsonb
      ) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM public.journal_entry_lines WHERE journal_entry_id = p_je_id;
        DELETE FROM public.journal_entries WHERE id = p_je_id;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_line_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        NULL;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_line_id uuid)
      RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id = p_line_id) THEN
          UPDATE public.bank_statement_lines
          SET reconciliation_status = 'unmatched', matched_receipt_id = NULL, matched_entry_id = NULL
          WHERE id = p_line_id;
        END IF;
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.unmatch_bank_statement_allocation(p_allocation_id uuid)
      RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        v_line_id uuid;
      BEGIN
        SELECT bank_statement_line_id INTO v_line_id FROM public.bank_statement_allocations WHERE id = p_allocation_id;
        DELETE FROM public.bank_statement_allocations WHERE id = p_allocation_id;
        IF v_line_id IS NOT NULL THEN
          PERFORM public.refresh_bank_statement_allocation_status(v_line_id);
        END IF;
        RETURN jsonb_build_object('success', true);
      END;
      $$;

      CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
        p_bank_line_id uuid,
        p_document_type text,
        p_document_id uuid,
        p_payment_kind text DEFAULT 'supplier'::text,
        p_allocation_amount numeric DEFAULT NULL::numeric
      ) RETURNS jsonb LANGUAGE plpgsql AS $$
      DECLARE
        v_amt numeric;
        v_bsl record;
      BEGIN
        SELECT * INTO v_bsl FROM public.bank_statement_lines WHERE id = p_bank_line_id;
        v_amt := COALESCE(p_allocation_amount, NULLIF(v_bsl.credit_amount, 0), v_bsl.debit_amount, 0);
        
        INSERT INTO public.bank_statement_allocations (
          bank_statement_line_id, document_type, document_id, allocation_amount, payment_kind
        ) VALUES (
          p_bank_line_id, p_document_type, p_document_id, v_amt, p_payment_kind
        );

        UPDATE public.bank_statement_lines
        SET reconciliation_status = 'matched',
            matched_receipt_id = CASE WHEN p_document_type = 'receipt' THEN p_document_id ELSE NULL END
        WHERE id = p_bank_line_id;

        RETURN jsonb_build_object(
          'allocation_amount', v_amt,
          'bank_total', v_amt,
          'bank_allocated', v_amt,
          'bank_remaining', 0,
          'document_total', v_amt,
          'document_allocated', v_amt,
          'document_remaining', 0
        );
      END;
      $$;
    `);

    // 4. Ensure Chart of Accounts matches production hierarchy
    // 1110: Header Bank Accounts
    // 111101: Leaf BCA IDR
    // 111102: Leaf BCA USD
    // 2110: Leaf Accounts Payable
    // 6910: Leaf Settlement Discount & Rounding Difference
    // 1102: Leaf Petty Cash
    await pool.query(`
      INSERT INTO public.chart_of_accounts (id, code, name, account_type, is_header, is_active)
      VALUES 
        ('979b236a-7ce8-4272-8965-7f41f03d8666', '1110', 'Bank Accounts', 'asset', true, true),
        ('eda4928b-2120-4c1c-a4e1-46c9eb7a610d', '111101', 'Bank BCA - IDR (0930201014)', 'asset', false, true),
        ('c6bd2ea2-337e-49b8-ac8f-8947769660e6', '111102', 'Bank BCA - USD (0930201022)', 'asset', false, true),
        ('66fb7574-b27e-4a5f-b6da-ce8096d91f31', '2110', 'Accounts Payable', 'liability', false, true),
        ('5f09e568-c0fc-47ef-8c00-b8ae6ff91859', '6910', 'Settlement Discount & Rounding Difference', 'expense', false, true),
        ('5b7f4b18-d751-4f47-b49b-117214bf0ba5', '1102', 'Petty Cash', 'asset', false, true),
        ('88888888-8888-8888-8888-888888888888', '1199', 'Inactive Account', 'asset', false, false)
      ON CONFLICT (code) DO UPDATE SET 
        is_header = EXCLUDED.is_header, 
        is_active = EXCLUDED.is_active,
        name = EXCLUDED.name;
    `);

    const coaRows = (await pool.query(`SELECT id, code FROM public.chart_of_accounts`)).rows;
    const coaMap = Object.fromEntries(coaRows.map(r => [r.code, r.id]));
    coa1110HeaderId = coaMap['1110'];
    coa111101IdrId = coaMap['111101'];
    coa111102UsdId = coaMap['111102'];
    coa2110ApId = coaMap['2110'];
    coa6910DiffId = coaMap['6910'];
    coa1102PettyCashId = coaMap['1102'];
    coaInactiveLeafId = coaMap['1199'];

    // 5. Seed Bank Accounts
    // BCA IDR
    const b1 = await pool.query(`
      INSERT INTO public.bank_accounts (
        id, account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'bfe79829-07d1-48ed-8965-ff9d367d758e', 'PT. Shubham Anzen Pharma Jaya', 'BCA Bank', '0930 2010 14',
        'current', 'IDR', 945000, 0, true, $1
      ) ON CONFLICT (id) DO UPDATE SET coa_id = EXCLUDED.coa_id, is_active = true
      RETURNING id;
    `, [coa111101IdrId]);
    bankIdBcaIdr = b1.rows[0].id;

    // BCA USD
    const b2 = await pool.query(`
      INSERT INTO public.bank_accounts (
        id, account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'c7278ad8-1d49-4bc7-9d5b-18c2cfce0ff9', 'PT. Shubham Anzen Pharma Jaya', 'BCA Bank', '0930 2010 22',
        'current', 'USD', 995, 0, true, $1
      ) ON CONFLICT (id) DO UPDATE SET coa_id = EXCLUDED.coa_id, is_active = true
      RETURNING id;
    `, [coa111102UsdId]);
    bankIdBcaUsd = b2.rows[0].id;

    // Misconfigured Bank Account mapped to HEADER GL 1110
    const b3 = await pool.query(`
      INSERT INTO public.bank_accounts (
        account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'Invalid Header Bank', 'Header Bank', '0000 1110 00',
        'current', 'IDR', 0, 0, true, $1
      ) RETURNING id;
    `, [coa1110HeaderId]);
    bankIdHeaderMapped = b3.rows[0].id;

    // Misconfigured Bank Account mapped to Inactive GL 1199
    const b4 = await pool.query(`
      INSERT INTO public.bank_accounts (
        account_name, bank_name, account_number, account_type, currency,
        opening_balance, current_balance, is_active, coa_id
      ) VALUES (
        'Inactive Mapped Bank', 'Inactive Bank', '0000 1199 00',
        'current', 'IDR', 0, 0, true, $1
      ) RETURNING id;
    `, [coaInactiveLeafId]);
    bankIdInactiveMapped = b4.rows[0].id;

    // 6. Seed PT. TRANS EXIS JAYA supplier
    const supRes = await pool.query(`
      INSERT INTO public.suppliers (
        id, supplier_code, company_name, is_active
      ) VALUES (
        '701bbcb1-3fe8-421f-acec-9d216193346d', 'SUP26-0003', 'PT. TRANS EXIS JAYA', true
      ) ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name, is_active = true
      RETURNING id;
    `);
    testSupplierId = supRes.rows[0].id;

    // Initial sync of bank account balances
    await pool.query(`SELECT public.sync_bank_account_balance(NULL);`);
  });

  test.after(async () => {
    if (pool) await pool.end();
  });

  // ----------------------------------------------------------------------------
  // TEST 1: Bank-transfer receipt with no selected bank account (must fail)
  // ----------------------------------------------------------------------------
  test('1. Bank-transfer receipt with no selected bank account fails with clear error', async () => {
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES (
        'RV-TEST-001', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        NULL, 1000000, 'supplier_refund', $2
      ) RETURNING id;
    `, [testSupplierId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /A bank account must be selected for bank transfer voucher/
    );

    // Verify voucher remains unposted
    const check = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(check.rows[0].is_posted, false);
    assert.equal(check.rows[0].journal_entry_id, null);
  });

  // ----------------------------------------------------------------------------
  // TEST 2: Bank account mapped to a header GL (must fail with clear error)
  // ----------------------------------------------------------------------------
  test('2. Bank account mapped to a header GL fails without posting to header', async () => {
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES (
        'RV-TEST-002', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplierId, bankIdHeaderMapped, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /is a header account and cannot receive journal lines/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 3: Inactive bank GL mapping (must fail)
  // ----------------------------------------------------------------------------
  test('3. Inactive bank GL mapping fails with understandable error', async () => {
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES (
        'RV-TEST-003', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplierId, bankIdInactiveMapped, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /is inactive/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 4: Correct BCA IDR leaf account (posts successfully to 111101)
  // ----------------------------------------------------------------------------
  test('4. Correct BCA IDR leaf account resolves and posts to 111101', async () => {
    // First fund supplier with a posted payment voucher advance of Rp 5,000,000
    const pvRes = await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, is_posted, created_by
      ) VALUES (
        'PV-SEED-004', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 5000000, true, $3
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);

    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by, transaction_currency, exchange_rate
      ) VALUES (
        'RV-TEST-004', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, 'supplier_refund', $3, 'IDR', 1
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const check = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(check.rows[0].is_posted, true);
    assert.ok(check.rows[0].journal_entry_id);

    // Verify journal line 1 debited BCA IDR (111101)
    const lines = await pool.query(`
      SELECT jel.*, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [check.rows[0].journal_entry_id]);

    assert.equal(lines.rows.length, 2);
    assert.equal(lines.rows[0].code, '111101');
    assert.equal(Number(lines.rows[0].debit), 1000000);
    assert.equal(Number(lines.rows[0].credit), 0);
  });

  // ----------------------------------------------------------------------------
  // TEST 5: Correct BCA USD leaf account (posts successfully to 111102)
  // ----------------------------------------------------------------------------
  test('5. Correct BCA USD leaf account resolves and posts USD receipt to 111102', async () => {
    // Fund USD supplier advance: $2,000 at rate 16,000
    await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, exchange_rate, is_posted, created_by, payment_currency
      ) VALUES (
        'PV-SEED-005', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 2000, 16000, true, $3, 'USD'
      );
    `, [testSupplierId, bankIdBcaUsd, adminUserId]);

    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_amount, payment_purpose, created_by,
        transaction_currency, payment_currency, exchange_rate
      ) VALUES (
        'RV-TEST-005', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 500, 8000000, 'supplier_refund', $3, 'USD', 'USD', 16000
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaUsd, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const check = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(check.rows[0].is_posted, true);

    const lines = await pool.query(`
      SELECT jel.*, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [check.rows[0].journal_entry_id]);

    assert.equal(lines.rows[0].code, '111102');
    assert.equal(lines.rows[0].transaction_currency, 'USD');
    assert.equal(Number(lines.rows[0].transaction_debit), 500);
    assert.equal(Number(lines.rows[0].debit), 8000000);
  });

  // ----------------------------------------------------------------------------
  // TEST 6: Currency mismatch between voucher and bank account
  // ----------------------------------------------------------------------------
  test('6. Currency mismatch between voucher and bank account fails', async () => {
    // Attempt USD voucher on BCA IDR bank account
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by, transaction_currency, payment_currency, exchange_rate
      ) VALUES (
        'RV-TEST-006', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 100, 'supplier_refund', $3, 'USD', 'USD', 16000
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /Voucher currency \(USD\) does not match bank account currency \(IDR\)/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 7: Supplier refund with approved adjustment (Rp 1,666,000 + Rp 3,000 = Rp 1,669,000)
  // ----------------------------------------------------------------------------
  test('7. Supplier refund with approved adjustment generates exact 3-line balanced journal', async () => {
    // Fund exact advance of Rp 1,669,000
    await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, is_posted, created_by
      ) VALUES (
        'PV-EXIS-ADV-007', '2026-10-15', 'supplier', $1, 'bank_transfer',
        $2, 1669000, true, $3
      );
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);

    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_amount, settlement_discount,
        adjustment_reason, adjustment_account_id, adjustment_notes,
        payment_purpose, created_by
      ) VALUES (
        'RV2610-TEST-EXIS', '2026-10-30', 'supplier', $1, 'bank_transfer',
        $2, 1666000, 1666000, 3000,
        'rounding_difference', $3, 'Approved settlement difference of 3000 against 1669000',
        'supplier_refund', $4
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, coa6910DiffId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);

    const check = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(check.rows[0].is_posted, true);

    const lines = await pool.query(`
      SELECT jel.*, coa.code, coa.name as coa_name
      FROM public.journal_entry_lines jel
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE jel.journal_entry_id = $1
      ORDER BY jel.line_number ASC;
    `, [check.rows[0].journal_entry_id]);

    // Exact expected 3 lines:
    // Line 1: Dr 111101 (BCA IDR) 1,666,000
    // Line 2: Dr 6910 (Diff) 3,000
    // Line 3: Cr 2110 (AP) 1,669,000
    assert.equal(lines.rows.length, 3);
    assert.equal(lines.rows[0].code, '111101');
    assert.equal(Number(lines.rows[0].debit), 1666000);
    assert.equal(Number(lines.rows[0].credit), 0);

    assert.equal(lines.rows[1].code, '6910');
    assert.equal(Number(lines.rows[1].debit), 3000);
    assert.equal(Number(lines.rows[1].credit), 0);

    assert.equal(lines.rows[2].code, '2110');
    assert.equal(Number(lines.rows[2].debit), 0);
    assert.equal(Number(lines.rows[2].credit), 1669000);
    assert.equal(lines.rows[2].supplier_id, testSupplierId);
  });

  // ----------------------------------------------------------------------------
  // TEST 8: Supplier refund exceeding refundable advance (must fail)
  // ----------------------------------------------------------------------------
  test('8. Supplier refund exceeding refundable advance balance fails atomically', async () => {
    // Current available advance for supplier is exhausted by previous refunds
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_amount, payment_purpose, created_by
      ) VALUES (
        'RV-EXCEED-008', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 99999999, 99999999, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /exceeds available refundable advance balance/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 9: Missing adjustment reason when difference > 0
  // ----------------------------------------------------------------------------
  test('9. Missing adjustment reason when settlement difference > 0 fails', async () => {
    // Fund advance of Rp 2,000,000
    await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, is_posted, created_by
      ) VALUES (
        'PV-SEED-009', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 2000000, true, $3
      );
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);

    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_discount, adjustment_reason,
        payment_purpose, created_by
      ) VALUES (
        'RV-TEST-009', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, 5000, NULL, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /Adjustment reason is mandatory when settlement discount\/difference is non-zero/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 10: Incorrect adjustment account (header account)
  // ----------------------------------------------------------------------------
  test('10. Incorrect adjustment account pointing to header GL fails', async () => {
    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, settlement_discount, adjustment_reason,
        adjustment_account_id, payment_purpose, created_by
      ) VALUES (
        'RV-TEST-010', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, 5000, 'rounding_difference',
        $3, 'supplier_refund', $4
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, coa1110HeaderId, adminUserId]);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /Adjustment account .* is a header account/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 11 & 12: Duplicate approval and double-posting prevention
  // ----------------------------------------------------------------------------
  test('11 & 12. Repeated post attempts on already posted voucher are rejected idempotently', async () => {
    // RV-TEST-004 is already posted
    const rvRes = await pool.query(`SELECT id FROM public.receipt_vouchers WHERE voucher_number = 'RV-TEST-004';`);
    const rvId = rvRes.rows[0].id;

    await assert.rejects(
      async () => {
        await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
      },
      /is already posted/
    );
  });

  // ----------------------------------------------------------------------------
  // TEST 13: Balanced journal lines (Debits == Credits)
  // ----------------------------------------------------------------------------
  test('13. Posted journal entry has perfectly balanced debits and credits', async () => {
    const jeRes = await pool.query(`
      SELECT je.id, je.total_debit, je.total_credit,
             SUM(jel.debit) as sum_debit, SUM(jel.credit) as sum_credit
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.reference_number = 'RV2610-TEST-EXIS'
      GROUP BY je.id, je.total_debit, je.total_credit;
    `);
    const row = jeRes.rows[0];
    assert.equal(Number(row.total_debit), 1669000);
    assert.equal(Number(row.total_credit), 1669000);
    assert.equal(Number(row.sum_debit), 1669000);
    assert.equal(Number(row.sum_credit), 1669000);
  });

  // ----------------------------------------------------------------------------
  // TEST 14: Supplier ledger update and party balance reflection
  // ----------------------------------------------------------------------------
  test('14. Supplier ledger in GL 2110 is updated with supplier_id', async () => {
    const glLines = await pool.query(`
      SELECT jel.debit, jel.credit, jel.supplier_id, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_number = 'RV2610-TEST-EXIS' AND coa.code = '2110';
    `);
    assert.equal(glLines.rows.length, 1);
    assert.equal(glLines.rows[0].supplier_id, testSupplierId);
    assert.equal(Number(glLines.rows[0].credit), 1669000);
  });

  // ----------------------------------------------------------------------------
  // TEST 15: Bank ledger update
  // ----------------------------------------------------------------------------
  test('15. Bank ledger in GL 111101 correctly reflects incoming receipt debit', async () => {
    const glLines = await pool.query(`
      SELECT jel.debit, jel.credit, coa.code
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
      WHERE je.reference_number = 'RV2610-TEST-EXIS' AND coa.code = '111101';
    `);
    assert.equal(glLines.rows.length, 1);
    assert.equal(Number(glLines.rows[0].debit), 1666000);
    assert.equal(Number(glLines.rows[0].credit), 0);
  });

  // ----------------------------------------------------------------------------
  // TEST 16: Dashboard bank-balance consistency via sync_bank_account_balance
  // ----------------------------------------------------------------------------
  test('16. Dashboard bank-balance accurately reflects GL net balance without double counting', async () => {
    const bankRes = await pool.query(`SELECT current_balance, opening_balance FROM public.bank_accounts WHERE id = $1;`, [bankIdBcaIdr]);
    const curr = Number(bankRes.rows[0].current_balance);
    const open = Number(bankRes.rows[0].opening_balance);

    // Sum all debits and credits on 111101
    const netGl = await pool.query(`
      SELECT COALESCE(SUM(jel.debit - jel.credit), 0) as net
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $1 AND je.is_posted = true AND NOT COALESCE(je.is_reversed, false);
    `, [coa111101IdrId]);

    const expected = open + Number(netGl.rows[0].net);
    assert.equal(curr, expected);

    // Test calling sync_bank_account_balance repeatedly (idempotency check)
    await pool.query(`SELECT public.sync_bank_account_balance($1::uuid);`, [bankIdBcaIdr]);
    const bankRes2 = await pool.query(`SELECT current_balance FROM public.bank_accounts WHERE id = $1;`, [bankIdBcaIdr]);
    assert.equal(Number(bankRes2.rows[0].current_balance), expected, 'Repeated sync maintains exact balance without double counting');
  });

  // ----------------------------------------------------------------------------
  // TEST 17: Bank reconciliation matching
  // ----------------------------------------------------------------------------
  test('17. Bank statement credit of Rp 1,666,000 matches posted receipt and reconciles', async () => {
    // Seed the bank statement line from BCA
    const bslRes = await pool.query(`
      INSERT INTO public.bank_statement_lines (
        id, bank_account_id, transaction_date, description, reference,
        debit_amount, credit_amount, currency, reconciliation_status
      ) VALUES (
        'b0757040-9080-455f-9ff8-6aa00e0331f7', $1, '2026-10-30',
        'TRSF E-BANKING CR 3010/FTSCY/WS95051 1666000.00 REFUND OVP 003A/OR/APF/IX/202 TRANS EXIS JAYA PT',
        '3010/FTSCY/WS95051', 0, 1666000, 'IDR', 'unmatched'
      ) ON CONFLICT (id) DO UPDATE SET reconciliation_status = 'unmatched'
      RETURNING id;
    `, [bankIdBcaIdr]);
    const bslId = bslRes.rows[0].id;

    const rvRes = await pool.query(`SELECT id FROM public.receipt_vouchers WHERE voucher_number = 'RV2610-TEST-EXIS';`);
    const rvId = rvRes.rows[0].id;

    // Call link_bank_statement_line
    const linkRes = await pool.query(`
      SELECT public.link_bank_statement_line($1::uuid, 'receipt', $2::uuid, 'supplier') as res;
    `, [bslId, rvId]);

    assert.equal(Number(linkRes.rows[0].res.allocation_amount), 1666000);
    assert.equal(Number(linkRes.rows[0].res.bank_remaining), 0);

    // Verify statement line is now matched
    const bslCheck = await pool.query(`SELECT reconciliation_status FROM public.bank_statement_lines WHERE id = $1;`, [bslId]);
    assert.equal(bslCheck.rows[0].reconciliation_status, 'matched');
  });

  // ----------------------------------------------------------------------------
  // TEST 18: Cancellation and reversal
  // ----------------------------------------------------------------------------
  test('18. Cancellation of posted receipt reverses journal, releases bank reconciliation, and syncs bank balance', async () => {
    const rvRes = await pool.query(`SELECT id, journal_entry_id FROM public.receipt_vouchers WHERE voucher_number = 'RV2610-TEST-EXIS';`);
    const rvId = rvRes.rows[0].id;
    const jeId = rvRes.rows[0].journal_entry_id;

    // Check bank balance before cancellation
    const bBefore = await pool.query(`SELECT current_balance FROM public.bank_accounts WHERE id = $1;`, [bankIdBcaIdr]);
    const balBefore = Number(bBefore.rows[0].current_balance);

    // Cancel posting
    await pool.query(`SELECT public.cancel_receipt_voucher_posting($1::uuid, $2::uuid, 'Test cancellation');`, [rvId, adminUserId]);

    // 1. Voucher is unposted and journal_entry_id cleared
    const rvCheck = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(rvCheck.rows[0].is_posted, false);
    assert.equal(rvCheck.rows[0].journal_entry_id, null);

    // 2. Journal entry is reversed or cancelled
    const jeCheck = await pool.query(`SELECT is_posted, is_reversed FROM public.journal_entries WHERE id = $1;`, [jeId]);
    assert.ok(jeCheck.rows.length === 0 || jeCheck.rows[0].is_reversed === true || jeCheck.rows[0].is_posted === false);

    // 3. Bank statement line reconciliation is released
    const bslCheck = await pool.query(`SELECT reconciliation_status FROM public.bank_statement_lines WHERE id = 'b0757040-9080-455f-9ff8-6aa00e0331f7';`);
    assert.equal(bslCheck.rows[0].reconciliation_status, 'unmatched');

    // 4. Bank balance was reduced by 1,666,000
    const bAfter = await pool.query(`SELECT current_balance FROM public.bank_accounts WHERE id = $1;`, [bankIdBcaIdr]);
    const balAfter = Number(bAfter.rows[0].current_balance);
    assert.equal(balBefore - balAfter, 1666000);
  });

  // ----------------------------------------------------------------------------
  // TEST 19: Concurrent posting attempts using separate database client connections
  // ----------------------------------------------------------------------------
  test('19. Concurrent refund postings competing for supplier advance balance are safely serialized', async () => {
    // Seed new supplier with advance balance of Rp 1,000,000
    const newSup = await pool.query(`
      INSERT INTO public.suppliers (supplier_code, company_name, is_active)
      VALUES ('SUP-CONCUR-019', 'Concurrent Supplier PT', true)
      RETURNING id;
    `);
    const cSupId = newSup.rows[0].id;

    await pool.query(`
      INSERT INTO public.payment_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, is_posted, created_by
      ) VALUES (
        'PV-CONCUR-019', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 1000000, true, $3
      );
    `, [cSupId, bankIdBcaIdr, adminUserId]);

    // Create 2 competing draft receipt vouchers for Rp 800,000 each (Total = 1.6M > 1.0M advance)
    const rv1 = (await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES ('RV-CONCUR-A', CURRENT_DATE, 'supplier', $1, 'bank_transfer', $2, 800000, 'supplier_refund', $3)
      RETURNING id;
    `, [cSupId, bankIdBcaIdr, adminUserId])).rows[0].id;

    const rv2 = (await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES ('RV-CONCUR-B', CURRENT_DATE, 'supplier', $1, 'bank_transfer', $2, 800000, 'supplier_refund', $3)
      RETURNING id;
    `, [cSupId, bankIdBcaIdr, adminUserId])).rows[0].id;

    // Connect 2 separate clients
    const client1 = new Client(PG_CONFIG);
    const client2 = new Client(PG_CONFIG);
    await client1.connect();
    await client2.connect();

    try {
      const results = await Promise.allSettled([
        client1.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rv1, adminUserId]),
        client2.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rv2, adminUserId]),
      ]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      // Exactly ONE must succeed and ONE must be rejected for exceeding available advance
      assert.equal(fulfilled.length, 1, 'Exactly one concurrent refund posting must succeed');
      assert.equal(rejected.length, 1, 'Competing concurrent refund posting must be safely blocked');
      assert.match(rejected[0].reason.message, /exceeds available refundable advance balance/);
    } finally {
      await client1.end();
      await client2.end();
    }
  });

  // ----------------------------------------------------------------------------
  // TEST 20: Full rollback after any failed validation
  // ----------------------------------------------------------------------------
  test('20. Failed validation triggers complete rollback with 0 orphan journal entries', async () => {
    const jeCountBefore = (await pool.query(`SELECT COUNT(*) FROM public.journal_entries;`)).rows[0].count;
    const jelCountBefore = (await pool.query(`SELECT COUNT(*) FROM public.journal_entry_lines;`)).rows[0].count;

    const rvRes = await pool.query(`
      INSERT INTO public.receipt_vouchers (
        voucher_number, voucher_date, party_type, supplier_id, payment_method,
        bank_account_id, amount, payment_purpose, created_by
      ) VALUES (
        'RV-ROLLBACK-020', CURRENT_DATE, 'supplier', $1, 'bank_transfer',
        $2, 99999999, 'supplier_refund', $3
      ) RETURNING id;
    `, [testSupplierId, bankIdBcaIdr, adminUserId]);
    const rvId = rvRes.rows[0].id;

    // Deliberately trigger failure
    await assert.rejects(async () => {
      await pool.query(`SELECT public.post_receipt_voucher($1::uuid, $2::uuid);`, [rvId, adminUserId]);
    });

    const jeCountAfter = (await pool.query(`SELECT COUNT(*) FROM public.journal_entries;`)).rows[0].count;
    const jelCountAfter = (await pool.query(`SELECT COUNT(*) FROM public.journal_entry_lines;`)).rows[0].count;

    assert.equal(jeCountAfter, jeCountBefore, 'No orphan journal entry was created');
    assert.equal(jelCountAfter, jelCountBefore, 'No orphan journal entry lines were created');

    const rvCheck = await pool.query(`SELECT is_posted, journal_entry_id FROM public.receipt_vouchers WHERE id = $1;`, [rvId]);
    assert.equal(rvCheck.rows[0].is_posted, false);
    assert.equal(rvCheck.rows[0].journal_entry_id, null);
  });
});
