import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;
const TEST_DIR = '/tmp/anzen_disposable_pph_audit_pg';
const TEST_PORT = 54399;

function runCmd(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString();
}

test('Disposable Real PostgreSQL Migration, Concurrency, and Filed-Period Audit', async (t) => {
  // Step 1: Clean and initialize disposable Postgres cluster
  if (existsSync(TEST_DIR)) {
    try {
      runCmd(`/usr/local/bin/pg_ctl -D ${TEST_DIR} stop -m immediate`);
    } catch (_) {}
    rmSync(TEST_DIR, { recursive: true, force: true });
  }

  runCmd(`/usr/local/bin/initdb -D ${TEST_DIR} --no-locale -E UTF8`);
  runCmd(`/usr/local/bin/pg_ctl -D ${TEST_DIR} -o "-p ${TEST_PORT}" -l ${TEST_DIR}/logfile start`);

  const client = new Client({
    host: 'localhost',
    port: TEST_PORT,
    user: process.env.USER || 'postgres',
    database: 'postgres',
  });
  await client.connect();

  try {
    // Step 2: Create prerequisite base tables for ERP schema
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
      END
      $$;

      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$ LANGUAGE sql STABLE;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'authenticated')::text;
      $$ LANGUAGE sql STABLE;

      CREATE TABLE IF NOT EXISTS public.user_profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        role text NOT NULL,
        full_name text
      );

      INSERT INTO public.user_profiles (id, role, full_name)
      VALUES 
        ('00000000-0000-0000-0000-000000000001', 'admin', 'Default Admin User'),
        ('00000000-0000-0000-0000-000000000002', 'viewer', 'Regular Viewer User')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE public.tax_periods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        fiscal_year INT NOT NULL,
        period_month INT NOT NULL,
        tax_type TEXT NOT NULL,
        period_start DATE,
        period_end DATE,
        pph_total NUMERIC(18,2) DEFAULT 0,
        status TEXT DEFAULT 'open',
        filing_status TEXT DEFAULT 'unfiled',
        filed_at TIMESTAMPTZ,
        payment_due_date DATE,
        filing_due_date DATE
      );

      CREATE TABLE public.tax_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tax_type TEXT NOT NULL,
        code TEXT NOT NULL
      );

      CREATE TABLE public.payment_vouchers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tax_period_id UUID REFERENCES public.tax_periods(id),
        voucher_date DATE,
        pph_amount NUMERIC(18,2) DEFAULT 0,
        pph_code_id UUID REFERENCES public.tax_codes(id),
        is_posted BOOLEAN DEFAULT true
      );

      CREATE TABLE public.tax_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tax_period_id UUID REFERENCES public.tax_periods(id),
        tax_type TEXT NOT NULL,
        amount NUMERIC(18,2) NOT NULL,
        historical_source_status TEXT
      );

      CREATE TABLE public.finance_payees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name TEXT NOT NULL,
        nik TEXT,
        npwp TEXT,
        business_role TEXT
      );

      CREATE TABLE public.suppliers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_name TEXT NOT NULL,
        npwp TEXT
      );

      CREATE TABLE public.bank_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bank_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        currency TEXT DEFAULT 'IDR'
      );

      CREATE TABLE public.finance_expenses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        voucher_number TEXT,
        expense_category TEXT NOT NULL,
        amount NUMERIC(18,2) NOT NULL,
        expense_date DATE NOT NULL,
        due_date DATE,
        description TEXT,
        payment_method TEXT,
        bank_account_id UUID REFERENCES public.bank_accounts(id),
        supplier_id UUID REFERENCES public.suppliers(id),
        payee_id UUID REFERENCES public.finance_payees(id),
        staff_id UUID,
        ppn_amount NUMERIC(18,2) DEFAULT 0,
        pph_amount NUMERIC(18,2) DEFAULT 0,
        pph_code_id UUID REFERENCES public.tax_codes(id),
        pph_treatment TEXT DEFAULT 'deduct',
        paid_amount NUMERIC(18,2) DEFAULT 0,
        stamp_duty_amount NUMERIC(18,2) DEFAULT 0,
        bank_charges_amount NUMERIC(18,2) DEFAULT 0,
        tax_period_id UUID REFERENCES public.tax_periods(id),
        pph_tax_period_id UUID REFERENCES public.tax_periods(id),
        approval_status TEXT DEFAULT 'pending_approval',
        originating_bank_statement_line_id UUID
      );

      CREATE VIEW public.effective_expense_posting_state AS
      SELECT id AS expense_id, 'ACTIVE' AS effective_posting_state FROM public.finance_expenses;

      CREATE TABLE public.bank_statement_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bank_account_id UUID REFERENCES public.bank_accounts(id),
        transaction_date DATE NOT NULL,
        description TEXT,
        debit_amount NUMERIC(18,2) DEFAULT 0,
        credit_amount NUMERIC(18,2) DEFAULT 0
      );

      CREATE TABLE public.bank_statement_allocations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        bank_statement_line_id UUID REFERENCES public.bank_statement_lines(id),
        document_type TEXT NOT NULL,
        document_id UUID NOT NULL,
        allocation_amount NUMERIC(18,2) NOT NULL,
        payment_kind TEXT DEFAULT 'supplier',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Step 3: Apply migrations in order
    const mig170 = readFileSync('supabase/migrations/20261114170000_multi_period_pph_allocations_and_cash_strictness.sql', 'utf8');

    // Run trigger validation function and migration 170
    await client.query(`
      CREATE OR REPLACE FUNCTION public.validate_tax_expense_linkage()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      AS $$
      DECLARE
        v_has_tax boolean;
        v_has_party boolean;
        v_is_paid boolean;
        v_has_payment_link boolean;
      BEGIN
        v_has_tax := (COALESCE(NEW.ppn_amount, 0) > 0 OR COALESCE(NEW.pph_amount, 0) > 0)
                     AND (NEW.expense_category IS DISTINCT FROM 'pib_import');
        IF v_has_tax THEN
          v_has_party := (NEW.supplier_id IS NOT NULL OR NEW.payee_id IS NOT NULL OR NEW.staff_id IS NOT NULL);
          IF NOT v_has_party THEN
            RAISE EXCEPTION 'Please select a Supplier/Payee and complete the required payment details before saving this tax expense.'
              USING ERRCODE = 'check_violation';
          END IF;
          v_is_paid := (NEW.payment_method IS NOT NULL AND NEW.payment_method NOT IN ('outstanding', ''))
                       OR (COALESCE(NEW.paid_amount, 0) > 0.01);
          v_has_payment_link := (NEW.originating_bank_statement_line_id IS NOT NULL);
          IF v_is_paid AND NOT v_has_payment_link THEN
            IF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NULL THEN
              RAISE EXCEPTION 'Please select a valid payment account for this paid expense.'
                USING ERRCODE = 'check_violation';
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$;

      DROP TRIGGER IF EXISTS trg_validate_tax_expense_linkage ON public.finance_expenses;
      CREATE TRIGGER trg_validate_tax_expense_linkage
        BEFORE INSERT OR UPDATE ON public.finance_expenses
        FOR EACH ROW
        EXECUTE FUNCTION public.validate_tax_expense_linkage();
    `);

    // Apply migration 170 in full (table, indices, triggers, sync function)
    await client.query(mig170);

    // Seed test master data
    const payeeRes = await client.query(`
      INSERT INTO public.finance_payees (full_name, nik, business_role)
      VALUES ('YENY FAHRIANI', '3172025210830002', 'notary')
      RETURNING id;
    `);
    const yenyId = payeeRes.rows[0].id;

    const bankAccRes = await client.query(`
      INSERT INTO public.bank_accounts (bank_name, account_number)
      VALUES ('BCA', '428-148282429')
      RETURNING id;
    `);
    const bcaId = bankAccRes.rows[0].id;

    // Seed Open and Filed tax periods
    const openNovRes = await client.query(`
      INSERT INTO public.tax_periods (fiscal_year, period_month, tax_type, status, filing_status)
      VALUES (2026, 11, 'PPh21', 'open', 'unfiled')
      RETURNING id;
    `);
    const novPeriodId = openNovRes.rows[0].id;

    const openDecRes = await client.query(`
      INSERT INTO public.tax_periods (fiscal_year, period_month, tax_type, status, filing_status)
      VALUES (2026, 12, 'PPh21', 'open', 'unfiled')
      RETURNING id;
    `);
    const decPeriodId = openDecRes.rows[0].id;

    const filedOctRes = await client.query(`
      INSERT INTO public.tax_periods (fiscal_year, period_month, tax_type, status, filing_status, pph_total)
      VALUES (2026, 10, 'PPh21', 'closed', 'filed', 500000)
      RETURNING id;
    `);
    const filedOctPeriodId = filedOctRes.rows[0].id;

    // ------------------------------------------------------------------------
    // TEST A: Mandatory Party validation on tax expenses
    // ------------------------------------------------------------------------
    await t.test('A. Mandatory Party validation blocks saving tax expense without party', async () => {
      await assert.rejects(
        () => client.query(`
          INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount)
          VALUES ('EXP/TEST/001', 'consulting', 1000000, '2026-11-01', 50000);
        `),
        /Please select a Supplier\/Payee/
      );
    });

    // ------------------------------------------------------------------------
    // TEST B: Valid payee_id satisfies party requirement
    // ------------------------------------------------------------------------
    let expId;
    await t.test('B. Valid payee_id satisfies party requirement and saves cleanly', async () => {
      const res = await client.query(`
        INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount, payee_id, payment_method)
        VALUES ('EXP/TEST/002', 'professional_services', 2000000, '2026-11-01', 100000, '${yenyId}', 'outstanding')
        RETURNING id;
      `);
      expId = res.rows[0].id;
      assert.ok(expId);
    });

    // ------------------------------------------------------------------------
    // TEST C: Foreign key & audit protection (ON DELETE RESTRICT)
    // ------------------------------------------------------------------------
    await t.test('C. ON DELETE RESTRICT prevents deleting expense when PPh allocations exist', async () => {
      // Create allocation for expId
      await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, source_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${expId}', '${novPeriodId}', 'direct_payment', gen_random_uuid(), '${yenyId}', '2026-11-15', 1000000, 50000
        );
      `);

      // Attempting to delete expense must fail with foreign key violation
      await assert.rejects(
        () => client.query(`DELETE FROM public.finance_expenses WHERE id = '${expId}';`),
        /foreign key constraint/i
      );
    });

    // ------------------------------------------------------------------------
    // TEST D: Stable Payment-Event ID for Cash & Direct Payments
    // ------------------------------------------------------------------------
    await t.test('D. Stable Payment-Event ID allows two cash payments on same day and handles retries idempotently', async () => {
      const expCashRes = await client.query(`
        INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount, payee_id, payment_method, paid_amount)
        VALUES ('EXP/TEST/CASH', 'office', 1000000, '2026-11-05', 50000, '${yenyId}', 'cash', 1000000)
        RETURNING id;
      `);
      const cashExpId = expCashRes.rows[0].id;

      const eventId1 = 'c0000001-0000-0000-0000-000000000001';
      const eventId2 = 'c0000002-0000-0000-0000-000000000002';

      // 1. First cash payment on 2026-11-05
      await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${cashExpId}', '${novPeriodId}', 'cash', '${eventId1}', '2026-11-05', 475000, 25000
        );
      `);

      // 2. Second distinct cash payment on the EXACT SAME DAY (2026-11-05) with different payment_event_id
      await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${cashExpId}', '${novPeriodId}', 'cash', '${eventId2}', '2026-11-05', 475000, 25000
        );
      `);

      // Both must exist!
      const twoRows = await client.query(`
        SELECT COUNT(*) as cnt FROM public.finance_expense_pph_allocations WHERE expense_id = '${cashExpId}';
      `);
      assert.equal(Number(twoRows.rows[0].cnt), 2, 'Two distinct cash payments on same day must both be recorded');

      // 3. Retry of Payment 1 with same payment_event_id fails if raw INSERT
      await assert.rejects(
        () => client.query(`
          INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
          ) VALUES (
            '${cashExpId}', '${novPeriodId}', 'cash', '${eventId1}', '2026-11-05', 475000, 25000
          );
        `),
        /uq_expense_pph_alloc_event/
      );

      // 4. Retry of Payment 1 with ON CONFLICT (expense_id, payment_source, payment_event_id) succeeds idempotently
      await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${cashExpId}', '${novPeriodId}', 'cash', '${eventId1}', '2026-11-05', 475000, 25000
        )
        ON CONFLICT (expense_id, payment_source, payment_event_id)
        DO UPDATE SET updated_at = now();
      `);

      const countAfterRetry = await client.query(`
        SELECT COUNT(*) as cnt FROM public.finance_expense_pph_allocations WHERE expense_id = '${cashExpId}';
      `);
      assert.equal(Number(countAfterRetry.rows[0].cnt), 2, 'Count remains exactly 2 after idempotent retry');
    });

    // ------------------------------------------------------------------------
    // TEST E: Concurrent duplicate allocation attempts
    // ------------------------------------------------------------------------
    await t.test('E. Concurrent duplicate allocations safely resolve via uq_expense_pph_alloc_event', async () => {
      const expConcRes = await client.query(`
        INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount, payee_id, payment_method, bank_account_id)
        VALUES ('EXP/TEST/CONC', 'office', 800000, '2026-11-10', 40000, '${yenyId}', 'bank_transfer', '${bcaId}')
        RETURNING id;
      `);
      const concExpId = expConcRes.rows[0].id;
      const fakeEventId = '11111111-2222-3333-4444-555555555555';

      // Connect independent client for concurrent execution
      const clientB = new Client({
        host: 'localhost',
        port: TEST_PORT,
        user: process.env.USER || 'postgres',
        database: 'postgres',
      });
      await clientB.connect();

      try {
        const query1 = client.query(`
          INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, source_id, payment_date, payment_amount, recognized_pph_amount
          ) VALUES (
            '${concExpId}', '${novPeriodId}', 'bank_statement_allocation', '${fakeEventId}', '${fakeEventId}', '2026-11-10', 760000, 40000
          )
          ON CONFLICT (expense_id, payment_source, payment_event_id)
          DO UPDATE SET updated_at = now();
        `);

        const query2 = clientB.query(`
          INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, source_id, payment_date, payment_amount, recognized_pph_amount
          ) VALUES (
            '${concExpId}', '${novPeriodId}', 'bank_statement_allocation', '${fakeEventId}', '${fakeEventId}', '2026-11-10', 760000, 40000
          )
          ON CONFLICT (expense_id, payment_source, payment_event_id)
          DO UPDATE SET updated_at = now();
        `);

        await Promise.all([query1, query2]);

        const countRes = await client.query(`
          SELECT COUNT(*) as cnt FROM public.finance_expense_pph_allocations WHERE expense_id = '${concExpId}';
        `);
        assert.equal(Number(countRes.rows[0].cnt), 1, 'Concurrent upserts must result in exactly 1 allocation');
      } finally {
        await clientB.end();
      }
    });

    // ------------------------------------------------------------------------
    // TEST F: Comprehensive filed-period trigger gap coverage
    // ------------------------------------------------------------------------
    await t.test('F. Trigger enforce_pph_allocation_period_lock closes all filed-period gaps', async () => {
      // 1. Block INSERT into filed period
      await assert.rejects(
        () => client.query(`
          INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
          ) VALUES (
            '${expId}', '${filedOctPeriodId}', 'direct_payment', gen_random_uuid(), '2026-10-15', 500000, 25000
          );
        `),
        /PPh tax period .* is filed\/closed; cannot assign new PPh allocations/
      );

      // Create an open allocation in novPeriodId to test open -> filed reassignment
      const novAllocRes = await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${expId}', '${novPeriodId}', 'direct_payment', gen_random_uuid(), '2026-11-15', 500000, 25000
        ) RETURNING id;
      `);
      const novAllocId = novAllocRes.rows[0].id;

      // 2. Block reassigning open allocation into a filed period (open -> filed)
      await assert.rejects(
        () => client.query(`
          UPDATE public.finance_expense_pph_allocations
          SET tax_period_id = '${filedOctPeriodId}'
          WHERE id = '${novAllocId}';
        `),
        /Target PPh tax period .* is filed\/closed; cannot reassign allocations into a filed period/
      );

      // Create a filed allocation under service_role to test operations on filed records
      await client.query(`SET request.jwt.claim.role = 'service_role';`);
      const octAllocRes = await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${expId}', '${filedOctPeriodId}', 'direct_payment', gen_random_uuid(), '2026-10-15', 500000, 25000
        ) RETURNING id;
      `);
      const octAllocId = octAllocRes.rows[0].id;
      await client.query(`RESET request.jwt.claim.role;`);

      // 3. Block reassigning filed allocation to an open period (filed -> open)
      await assert.rejects(
        () => client.query(`
          UPDATE public.finance_expense_pph_allocations
          SET tax_period_id = '${novPeriodId}'
          WHERE id = '${octAllocId}';
        `),
        /PPh tax period .* is filed\/closed; cannot reassign allocations out of a filed period/
      );

      // 4. Block modifying financial or date fields in filed period
      await assert.rejects(
        () => client.query(`
          UPDATE public.finance_expense_pph_allocations
          SET recognized_pph_amount = 30000
          WHERE id = '${octAllocId}';
        `),
        /PPh tax period .* is filed\/closed; cannot modify or reverse allocations/
      );

      // 5. Block modifying identity fields (expense_id)
      const otherExpRes = await client.query(`
        INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount, payee_id, payment_method)
        VALUES ('EXP/OTHER', 'consulting', 1000000, '2026-11-01', 50000, '${yenyId}', 'outstanding') RETURNING id;
      `);
      const otherExpId = otherExpRes.rows[0].id;

      await assert.rejects(
        () => client.query(`
          UPDATE public.finance_expense_pph_allocations
          SET expense_id = '${otherExpId}'
          WHERE id = '${novAllocId}';
        `),
        /Cannot modify expense identity \(expense_id\) on an existing PPh allocation/
      );

      // 6. Block physical DELETE from filed period
      await assert.rejects(
        () => client.query(`
          DELETE FROM public.finance_expense_pph_allocations
          WHERE id = '${octAllocId}';
        `),
        /PPh tax period .* is filed\/closed; physical deletion of tax allocations is prohibited/
      );

      // 7. Block reversal in filed period without admin authorization
      await assert.rejects(
        () => client.query(`
          UPDATE public.finance_expense_pph_allocations
          SET is_reversed = true
          WHERE id = '${octAllocId}';
        `),
        /PPh tax period .* is filed\/closed; cannot modify or reverse allocations/
      );
    });

    // ------------------------------------------------------------------------
    // TEST G: Server-authorized administrative amendment workflow
    // ------------------------------------------------------------------------
    await t.test('G. Server-authorized administrative amendment workflow', async () => {
      const adminId = '00000000-0000-0000-0000-000000000001';
      const viewerId = '00000000-0000-0000-0000-000000000002';

      // 1. Non-admin user cannot authorize amendment
      await client.query(`SET request.jwt.claim.sub = '${viewerId}';`);
      await assert.rejects(
        () => client.query(`
          SELECT public.authorize_tax_period_amendment('${filedOctPeriodId}', 'Audit rectification', 10);
        `),
        /Unauthorized: Only system administrators/
      );

      // 2. Admin authorizes amendment for 15 minutes
      await client.query(`SET request.jwt.claim.sub = '${adminId}';`);
      const authRes = await client.query(`
        SELECT public.authorize_tax_period_amendment('${filedOctPeriodId}', 'Approved SPT Masa PPh21 Pembetulan-1 by Tax Manager', 15) as auth_id;
      `);
      const authId = authRes.rows[0].auth_id;
      assert.ok(authId);

      // 3. Now INSERT into filed period succeeds under active amendment
      const amendedAllocRes = await client.query(`
        INSERT INTO public.finance_expense_pph_allocations (
          expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
        ) VALUES (
          '${expId}', '${filedOctPeriodId}', 'direct_payment', gen_random_uuid(), '2026-10-20', 200000, 10000
        ) RETURNING id;
      `);
      assert.ok(amendedAllocRes.rows[0].id);

      // 4. Verify authorization record is consumed
      const authRecord = await client.query(`
        SELECT is_consumed, consumed_at FROM public.tax_period_amendment_authorizations WHERE id = '${authId}';
      `);
      assert.equal(authRecord.rows[0].is_consumed, true);
      assert.ok(authRecord.rows[0].consumed_at);

      // 5. Subsequent modification without new authorization is blocked again
      await assert.rejects(
        () => client.query(`
          INSERT INTO public.finance_expense_pph_allocations (
            expense_id, tax_period_id, payment_source, payment_event_id, payment_date, payment_amount, recognized_pph_amount
          ) VALUES (
            '${expId}', '${filedOctPeriodId}', 'direct_payment', gen_random_uuid(), '2026-10-21', 200000, 10000
          );
        `),
        /PPh tax period .* is filed\/closed; cannot assign new PPh allocations/
      );

      await client.query(`RESET request.jwt.claim.sub;`);
    });

    // ------------------------------------------------------------------------
    // TEST H: Multi-period proportional sync via database function
    // ------------------------------------------------------------------------
    await t.test('H. Multi-period sync calculates proportional PPh across November and December', async () => {
      const expMultiRes = await client.query(`
        INSERT INTO public.finance_expenses (voucher_number, expense_category, amount, expense_date, pph_amount, payee_id, payment_method, bank_account_id)
        VALUES ('EXP/TEST/MULTI', 'services', 2000000, '2026-10-15', 100000, '${yenyId}', 'bank_transfer', '${bcaId}')
        RETURNING id;
      `);
      const multiExpId = expMultiRes.rows[0].id;
      const bsaNovId = 'aaaaaaaa-1111-2222-3333-444444444444';
      const bsaDecId = 'bbbbbbbb-1111-2222-3333-444444444444';

      // Payment 1 in November: Rp 950,000 (50%)
      await client.query(`
        SELECT public.sync_expense_pph_allocation(
          '${multiExpId}', 'bank_statement_allocation', '${bsaNovId}', '2026-11-15', 950000, false, '${bsaNovId}'
        );
      `);

      // Payment 2 in December: Rp 950,000 (Remaining 50%)
      await client.query(`
        SELECT public.sync_expense_pph_allocation(
          '${multiExpId}', 'bank_statement_allocation', '${bsaDecId}', '2026-12-10', 950000, false, '${bsaDecId}'
        );
      `);

      const allocs = await client.query(`
        SELECT tax_period_id, payment_date, payment_amount, recognized_pph_amount, is_reversed
        FROM public.finance_expense_pph_allocations
        WHERE expense_id = '${multiExpId}'
        ORDER BY payment_date ASC;
      `);

      assert.equal(allocs.rows.length, 2);
      // Nov allocation: 50,000 PPh
      assert.equal(allocs.rows[0].tax_period_id, novPeriodId);
      assert.equal(Number(allocs.rows[0].recognized_pph_amount), 50000);
      // Dec allocation: 50,000 PPh
      assert.equal(allocs.rows[1].tax_period_id, decPeriodId);
      assert.equal(Number(allocs.rows[1].recognized_pph_amount), 50000);

      // Total equals exactly 100,000
      const totalPph = allocs.rows.reduce((sum, r) => sum + Number(r.recognized_pph_amount), 0);
      assert.equal(totalPph, 100000);

      // Reversal of Payment 1
      await client.query(`
        SELECT public.sync_expense_pph_allocation(
          '${multiExpId}', 'bank_statement_allocation', '${bsaNovId}', '2026-11-15', 950000, true, '${bsaNovId}'
        );
      `);

      const afterRev = await client.query(`
        SELECT recognized_pph_amount, is_reversed
        FROM public.finance_expense_pph_allocations
        WHERE expense_id = '${multiExpId}' AND payment_event_id = '${bsaNovId}';
      `);
      assert.equal(afterRev.rows[0].is_reversed, true);
      assert.equal(Number(afterRev.rows[0].recognized_pph_amount), 0);
    });

  } finally {
    await client.end();
    // Step 4: Clean up disposable Postgres cluster
    runCmd(`/usr/local/bin/pg_ctl -D ${TEST_DIR} stop -m immediate`);
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});
