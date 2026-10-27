import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function runSql(sql) {
  const tmpFile = path.join(os.tmpdir(), `query_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf-8');
  try {
    const res = execSync(`npx supabase db query --linked -f "${tmpFile}"`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      shell: '/bin/zsh'
    });
    const jsonMatch = res.match(/\{[\s\S]*"rows":[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.rows;
    }
    return [];
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

test('1. Migration file and FK constraint verification', () => {
  const migrationPath = path.join(process.cwd(), 'supabase/migrations/20260923140000_fix_receipt_voucher_cancellation_and_repair_fk.sql');
  assert.ok(fs.existsSync(migrationPath), 'Migration file must exist');

  const content = fs.readFileSync(migrationPath, 'utf-8');
  assert.match(content, /ON DELETE SET NULL/, 'Migration must set ON DELETE SET NULL on created_allocation_id');
  assert.match(content, /unmatch_bank_statement_allocation/, 'Migration must use unmatch_bank_statement_allocation');
  assert.match(content, /sync_bank_line_allocation_owner/, 'Migration must call sync_bank_line_allocation_owner');
  assert.match(content, /refresh_bank_statement_allocation_status/, 'Migration must call refresh_bank_statement_allocation_status');

  const fkRows = runSql(`
    SELECT
      tc.constraint_name,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.referential_constraints AS rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.constraint_name = 'finance_historical_repair_commands_created_allocation_id_fkey';
  `);

  assert.equal(fkRows.length, 1);
  assert.equal(fkRows[0].delete_rule, 'SET NULL', 'Database FK delete rule must be SET NULL');
});

test('2. Live DB state verification for RV2607-0008 and target invoices', () => {
  const rows = runSql(`
    SELECT json_build_object(
      'rv', (
        SELECT row_to_json(r) FROM (
          SELECT id, voucher_number, is_posted, journal_entry_id, amount
          FROM receipt_vouchers
          WHERE id = '5c893064-f524-4271-b8a2-6ed3451b2c97'
        ) r
      ),
      'va', (
        SELECT json_agg(row_to_json(v)) FROM (
          SELECT va.id, va.sales_invoice_id, si.invoice_number, va.allocated_amount
          FROM voucher_allocations va
          JOIN sales_invoices si ON si.id = va.sales_invoice_id
          WHERE va.receipt_voucher_id = '5c893064-f524-4271-b8a2-6ed3451b2c97'
        ) v
      ),
      'invoices', (
        SELECT json_agg(row_to_json(inv)) FROM (
          SELECT invoice_number, total_amount, paid_amount, balance_amount, payment_status
          FROM sales_invoices
          WHERE invoice_number IN ('SAPJ-26-026', 'SAPJ-26-028')
          ORDER BY invoice_number
        ) inv
      ),
      'fhrc', (
        SELECT row_to_json(f) FROM (
          SELECT id, operation, status, created_allocation_id
          FROM finance_historical_repair_commands
          WHERE id = 'e8285a92-d3bd-48ab-aa89-62891a8ae555'
        ) f
      ),
      'bsl', (
        SELECT row_to_json(b) FROM (
          SELECT id, credit_amount, reconciliation_status, matching_status, matched_receipt_id, matched_entry_id
          FROM bank_statement_lines
          WHERE id = '802feb3b-d143-4c98-b74e-2e361cb56c19'
        ) b
      ),
      'bsa', (
        SELECT json_agg(row_to_json(a)) FROM (
          SELECT id, bank_statement_line_id, document_type, document_id, journal_entry_id, allocation_amount, payment_kind
          FROM bank_statement_allocations
          WHERE bank_statement_line_id = '802feb3b-d143-4c98-b74e-2e361cb56c19'
        ) a
      ),
      'je_count', (
        SELECT count(*)
        FROM journal_entries
        WHERE source_module = 'receipt' AND reference_id = '5c893064-f524-4271-b8a2-6ed3451b2c97'
      ),
      'unmatched_bsl_count', (
        SELECT count(*)
        FROM bank_statement_lines
        WHERE reconciliation_status = 'unmatched'
      )
    ) AS state;
  `);

  assert.equal(rows.length, 1);
  const state = rows[0].state;

  // Point A / E / J: RV2607-0008 is posted
  assert.equal(state.rv.voucher_number, 'RV2607-0008');
  assert.equal(state.rv.is_posted, true, 'Receipt voucher must be posted');
  assert.ok(state.rv.journal_entry_id, 'Receipt voucher must have journal_entry_id');
  assert.equal(Number(state.rv.amount), 49215412);

  // Point I / L: Allocated to SAPJ-26-026 with amount 49,215,412
  assert.equal(state.va.length, 1, 'Exactly 1 allocation for RV2607-0008');
  assert.equal(state.va[0].invoice_number, 'SAPJ-26-026', 'Allocation must be to SAPJ-26-026');
  assert.equal(Number(state.va[0].allocated_amount), 49215412, 'Allocated amount must be 49,215,412');

  // Point L: SAPJ-26-026 is fully paid, SAPJ-26-028 has pending balance
  const sapj026 = state.invoices.find(i => i.invoice_number === 'SAPJ-26-026');
  const sapj028 = state.invoices.find(i => i.invoice_number === 'SAPJ-26-028');

  assert.equal(Number(sapj026.total_amount), 104574487.5);
  assert.equal(Number(sapj026.paid_amount), 104574487.5);
  assert.equal(Number(sapj026.balance_amount), 0);
  assert.equal(sapj026.payment_status, 'paid');

  assert.equal(Number(sapj028.total_amount), 49215412);
  assert.equal(Number(sapj028.paid_amount), 0);
  assert.equal(Number(sapj028.balance_amount), 49215412);
  assert.equal(sapj028.payment_status, 'pending');

  // Point C / D: Historical repair command still exists, created_allocation_id is NULL
  assert.equal(state.fhrc.id, 'e8285a92-d3bd-48ab-aa89-62891a8ae555');
  assert.equal(state.fhrc.operation, 'allocate_existing_cash_event');
  assert.equal(state.fhrc.status, 'committed');
  assert.equal(state.fhrc.created_allocation_id, null, 'created_allocation_id must be null');

  // Point G / H: Bank statement line intact and matched
  assert.equal(state.bsl.id, '802feb3b-d143-4c98-b74e-2e361cb56c19');
  assert.equal(Number(state.bsl.credit_amount), 49215412);
  assert.equal(state.bsl.reconciliation_status, 'matched');
  assert.equal(state.bsl.matching_status, 'confirmed');
  assert.equal(state.bsl.matched_receipt_id, '5c893064-f524-4271-b8a2-6ed3451b2c97');
  assert.equal(state.bsl.matched_entry_id, state.rv.journal_entry_id);

  // Point K: No duplicate journal, duplicate bank allocation, or duplicate cash event
  assert.equal(state.je_count, 1, 'Exactly 1 posted journal entry must exist for RV2607-0008');
  assert.equal(state.bsa.length, 1, 'Exactly 1 bank statement allocation must exist for bank line');
  assert.equal(state.bsa[0].journal_entry_id, state.rv.journal_entry_id);
  assert.equal(state.bsa[0].document_id, '5c893064-f524-4271-b8a2-6ed3451b2c97');
  assert.equal(Number(state.bsa[0].allocation_amount), 49215412);

  // Unmatched bank lines remain stable
  assert.equal(state.unmatched_bsl_count, 7, 'Unmatched bank lines count must remain 7');
});

test('3. Full transactional cancellation workflow validation (Points A-L in isolated transaction)', () => {
  const rows = runSql(`
    DO $$
    DECLARE
      v_rv_id uuid := '5c893064-f524-4271-b8a2-6ed3451b2c97';
      v_bsl_id uuid := '802feb3b-d143-4c98-b74e-2e361cb56c19';
      v_target_inv_id uuid := '24ef4e05-1e3d-4fad-bf76-5a4cc1b7a5d0';
      v_curr_bsa_id uuid;
      v_test_cmd_id uuid;
      v_bsl record;
      v_cmd record;
      v_rv record;
      v_je_count int;
      v_bsa_count int;
    BEGIN
      PERFORM set_config('request.jwt.claim.role', 'service_role', true);

      SELECT id INTO v_curr_bsa_id
      FROM bank_statement_allocations
      WHERE bank_statement_line_id = v_bsl_id
      LIMIT 1;

      -- Create a test historical repair command referencing this allocation to verify FK SET NULL behavior
      INSERT INTO finance_historical_repair_commands (
        idempotency_key, document_type, document_id, bank_statement_line_id,
        operation, status, created_allocation_id, before_state, after_state
      ) VALUES (
        'test-repair-verify-' || gen_random_uuid()::text, 'receipt', v_rv_id, v_bsl_id,
        'allocate_existing_cash_event', 'committed', v_curr_bsa_id, '{}'::jsonb, '{}'::jsonb
      ) RETURNING id INTO v_test_cmd_id;

      -- POINT B: Cancel Posting succeeds without FK violation
      PERFORM public.cancel_receipt_voucher_posting(v_rv_id);

      -- POINT C & D: Repair command survives with created_allocation_id = NULL
      SELECT * INTO v_cmd FROM finance_historical_repair_commands WHERE id = v_test_cmd_id;
      IF v_cmd.id IS NULL THEN
        RAISE EXCEPTION 'Historical repair command was deleted';
      END IF;
      IF v_cmd.created_allocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'created_allocation_id was not set to NULL on cancellation';
      END IF;

      -- POINT E & F: Receipt is draft, journal entry reference cleared
      SELECT * INTO v_rv FROM receipt_vouchers WHERE id = v_rv_id;
      IF v_rv.is_posted = true THEN
        RAISE EXCEPTION 'Receipt is still posted after cancellation';
      END IF;
      IF v_rv.journal_entry_id IS NOT NULL THEN
        RAISE EXCEPTION 'journal_entry_id was not cleared from receipt voucher';
      END IF;

      -- POINT G & H: Bank line intact, reconciliation status recalculated to unmatched
      SELECT * INTO v_bsl FROM bank_statement_lines WHERE id = v_bsl_id;
      IF v_bsl.credit_amount <> 49215412.00 THEN
        RAISE EXCEPTION 'Bank line credit amount was altered';
      END IF;
      IF v_bsl.reconciliation_status <> 'unmatched' OR v_bsl.matching_status <> 'none' THEN
        RAISE EXCEPTION 'Bank line status not unmatched: % / %', v_bsl.reconciliation_status, v_bsl.matching_status;
      END IF;

      -- POINT I: User can edit allocations to SAPJ-26-026
      PERFORM public.save_receipt_voucher_with_allocations(
        v_rv_id,
        jsonb_build_object(
          'customer_id', v_rv.customer_id,
          'voucher_date', v_rv.voucher_date,
          'payment_method', v_rv.payment_method,
          'bank_account_id', v_rv.bank_account_id,
          'amount', 49215412.00,
          'transaction_currency', 'IDR',
          'exchange_rate', 1.0
        ),
        jsonb_build_array(
          jsonb_build_object('sales_invoice_id', v_target_inv_id, 'amount', 49215412.00)
        )
      );

      -- POINT J: Reposting succeeds
      PERFORM public.post_receipt_voucher(v_rv_id);

      -- Relink bank statement line
      PERFORM public.link_bank_statement_line(v_bsl_id, 'receipt', v_rv_id, 'supplier', 49215412.00);

      -- POINT K: No duplicate journals, allocations, or cash events
      SELECT count(*) INTO v_je_count FROM journal_entries WHERE source_module = 'receipt' AND reference_id = v_rv_id;
      IF v_je_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 journal entry, found %', v_je_count;
      END IF;

      SELECT count(*) INTO v_bsa_count FROM bank_statement_allocations WHERE bank_statement_line_id = v_bsl_id;
      IF v_bsa_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 bank allocation, found %', v_bsa_count;
      END IF;

      -- POINT L: Final allocation to SAPJ-26-026 verified
      IF NOT EXISTS (
        SELECT 1 FROM voucher_allocations
        WHERE receipt_voucher_id = v_rv_id AND sales_invoice_id = v_target_inv_id AND allocated_amount = 49215412.00
      ) THEN
        RAISE EXCEPTION 'Allocation not updated to SAPJ-26-026';
      END IF;

      -- Rollback test transaction so live DB is untouched
      RAISE EXCEPTION 'TEST_SUCCESS_ROLLBACK';
    EXCEPTION
      WHEN OTHERS THEN
        IF SQLERRM = 'TEST_SUCCESS_ROLLBACK' THEN
          -- Success
          NULL;
        ELSE
          RAISE;
        END IF;
    END $$;
  `);

  assert.ok(true, 'Isolated transaction cancellation workflow succeeded');
});
