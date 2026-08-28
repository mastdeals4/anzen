-- ================================================================
-- Migration:  20260626120000_correct_pv26_26_001_audited
-- Date:       2026-06-26
-- Author:     System (historical data correction)
--
-- Purpose
-- -------
-- PV/26-26/001 was entered with the wrong bank account.
-- The operator selected BCA IDR (bfe79829) instead of BCA USD
-- (c7278ad8) for a USD wire payment to Anzen Exports Pvt Ltd.
-- This caused three downstream errors:
--   1. JE2606-0033 line 3 posted to COA 1111 "Bank BCA" (generic
--      header / fallback) instead of COA 111102 "Bank BCA USD".
--   2. The reporting engine classified the payment JE as IDR
--      (ba.currency = 'IDR', exchange_rate = 1), so USD 33,600
--      was read as Rp 33,600 — AP never cleared in USD terms.
--   3. Invoice E0000311/2526 was entered with exchange_rate = 1;
--      the correct rate is 16,800 sourced from batch XMEP250178
--      (exchange_rate_usd_to_idr = 16,800, import_date 2025-12-30).
--
-- Evidence
-- --------
-- Confirmed pattern: PV/25-26/003 (2025-12-22) is an identical USD
-- supplier payment. It used BCA USD (c7278ad8), exchange_rate = 1,
-- and its JE correctly credits COA 111102 "Bank BCA USD". The BCA
-- USD bank statement confirms a debit of USD 40,050 on that date.
-- No amounts change in this correction — only account mappings.
--
-- Changes Applied
-- ---------------
-- 1. payment_vouchers.bank_account_id:
--    bfe79829 (BCA IDR) → c7278ad8 (BCA USD)
-- 2. journal_entry_lines (JE2606-0033, line 3) .account_id:
--    688fda2e (COA 1111 Bank BCA generic) → c6bd2ea2 (COA 111102)
-- 3. purchase_invoices (E0000311/2526) .exchange_rate:
--    1 → 16800 (from batch XMEP250178)
--
-- Idempotency
-- -----------
-- Checks current values before applying. Re-running is safe.
--
-- Reversibility
-- -------------
-- Rollback SQL is stored in audit_logs.old_values._rollback_sql
-- for each affected record. Summary rollback:
--   UPDATE payment_vouchers     SET bank_account_id = 'bfe79829-07d1-48ed-8965-ff9d367d758e' WHERE id = 'e08220ab-3e9c-4cf9-b941-49be4ffd3732';
--   UPDATE journal_entry_lines  SET account_id      = '688fda2e-5b51-4b84-842f-9c2e9a747324' WHERE id = '934fbf93-7574-49ee-abae-5d7f3b1dba19';
--   UPDATE purchase_invoices    SET exchange_rate    = 1                                       WHERE id = 'b505eac1-0938-4bec-bfcf-0eb998b79530';
-- ================================================================

DO $$
DECLARE
  -- ── Fixed identifiers (from investigation queries) ─────────────
  v_pv_id             UUID    := 'e08220ab-3e9c-4cf9-b941-49be4ffd3732';  -- PV/26-26/001
  v_je_id             UUID    := '1c59e2c5-61f5-4a93-8a3b-9728bba2f107';  -- JE2606-0033
  v_je_line_id        UUID    := '934fbf93-7574-49ee-abae-5d7f3b1dba19';  -- JE line 3
  v_invoice_id        UUID    := 'b505eac1-0938-4bec-bfcf-0eb998b79530';  -- E0000311/2526
  v_migration_id      TEXT    := '20260626120000_correct_pv26_26_001_audited';

  -- ── Original (erroneous) values ────────────────────────────────
  v_orig_bank_id      UUID    := 'bfe79829-07d1-48ed-8965-ff9d367d758e';  -- BCA IDR
  v_orig_je_coa_id    UUID    := '688fda2e-5b51-4b84-842f-9c2e9a747324';  -- COA 1111
  v_orig_inv_rate     NUMERIC := 1;

  -- ── Correct values ─────────────────────────────────────────────
  v_correct_bank_id   UUID    := 'c7278ad8-1d49-4bc7-9d5b-18c2cfce0ff9';  -- BCA USD
  v_correct_je_coa_id UUID    := 'c6bd2ea2-337e-49b8-ac8f-8947769660e6';  -- COA 111102
  v_correct_inv_rate  NUMERIC := 16800;  -- from batch XMEP250178

  -- ── Runtime state for idempotency ─────────────────────────────
  v_cur_bank_id       UUID;
  v_cur_je_coa_id     UUID;
  v_cur_inv_rate      NUMERIC;
  v_rows_affected     INT;
BEGIN

  -- ── 0. READ CURRENT STATE ──────────────────────────────────────
  SELECT bank_account_id INTO v_cur_bank_id
    FROM payment_vouchers WHERE id = v_pv_id;

  SELECT account_id INTO v_cur_je_coa_id
    FROM journal_entry_lines WHERE id = v_je_line_id;

  SELECT exchange_rate INTO v_cur_inv_rate
    FROM purchase_invoices WHERE id = v_invoice_id;

  -- ── 1. IDEMPOTENCY GATE ────────────────────────────────────────
  IF v_cur_bank_id    = v_correct_bank_id
 AND v_cur_je_coa_id  = v_correct_je_coa_id
 AND v_cur_inv_rate   = v_correct_inv_rate THEN
    RAISE NOTICE '[%] Already applied — no changes made.', v_migration_id;
    RETURN;
  END IF;

  -- Confirm source records exist before touching anything
  IF v_cur_bank_id IS NULL THEN
    RAISE EXCEPTION '[%] payment_voucher % not found — aborting.', v_migration_id, v_pv_id;
  END IF;
  IF v_cur_je_coa_id IS NULL THEN
    RAISE EXCEPTION '[%] journal_entry_line % not found — aborting.', v_migration_id, v_je_line_id;
  END IF;
  IF v_cur_inv_rate IS NULL THEN
    RAISE EXCEPTION '[%] purchase_invoice % not found — aborting.', v_migration_id, v_invoice_id;
  END IF;

  -- ── 2. AUDIT LOG — PAYMENT VOUCHER ────────────────────────────
  INSERT INTO audit_logs (
    table_name, action_type, record_id,
    old_values, new_values, changed_fields, user_email
  ) VALUES (
    'payment_vouchers',
    'HISTORICAL_CORRECTION',
    v_pv_id,
    jsonb_build_object(
      'bank_account_id',   v_orig_bank_id,
      '_bank_account_name','Bank BCA - IDR (0930201022)',
      '_bank_currency',    'IDR',
      '_migration_id',     v_migration_id,
      '_correction_date',  NOW(),
      '_affected_voucher', 'PV/26-26/001',
      '_affected_invoice', 'E0000311/2526',
      '_affected_je',      v_je_id,
      '_reason',           'Wrong bank account selected at data entry: BCA IDR used for a USD wire payment. Pattern confirmed by PV/25-26/003 which correctly used BCA USD for an identical transaction.',
      '_rollback_sql',     'UPDATE payment_vouchers SET bank_account_id = ''bfe79829-07d1-48ed-8965-ff9d367d758e'', updated_at = NOW() WHERE id = ''e08220ab-3e9c-4cf9-b941-49be4ffd3732'';'
    ),
    jsonb_build_object(
      'bank_account_id',   v_correct_bank_id,
      '_bank_account_name','Bank BCA - USD (0930201014)',
      '_bank_currency',    'USD'
    ),
    ARRAY['bank_account_id'],
    'migration:' || v_migration_id
  );

  -- ── 3. AUDIT LOG — JOURNAL ENTRY LINE ─────────────────────────
  INSERT INTO audit_logs (
    table_name, action_type, record_id,
    old_values, new_values, changed_fields, user_email
  ) VALUES (
    'journal_entry_lines',
    'HISTORICAL_CORRECTION',
    v_je_line_id,
    jsonb_build_object(
      'account_id',       v_orig_je_coa_id,
      '_account_code',    '1111',
      '_account_name',    'Bank BCA (generic header — trigger fallback when coa_id was NULL)',
      '_migration_id',    v_migration_id,
      '_correction_date', NOW(),
      '_affected_je',     v_je_id,
      '_je_number',       'JE2606-0033',
      '_line_number',     3,
      '_reason',          'COA 1111 was the trigger fallback: bank_accounts.coa_id was NULL when PV/26-26/001 was inserted. Correct account is COA 111102 (BCA USD) matching the corrected bank_account_id.',
      '_rollback_sql',    'UPDATE journal_entry_lines SET account_id = ''688fda2e-5b51-4b84-842f-9c2e9a747324'' WHERE id = ''934fbf93-7574-49ee-abae-5d7f3b1dba19'';'
    ),
    jsonb_build_object(
      'account_id',    v_correct_je_coa_id,
      '_account_code', '111102',
      '_account_name', 'Bank BCA - USD (0930201014)'
    ),
    ARRAY['account_id'],
    'migration:' || v_migration_id
  );

  -- ── 4. AUDIT LOG — PURCHASE INVOICE ───────────────────────────
  INSERT INTO audit_logs (
    table_name, action_type, record_id,
    old_values, new_values, changed_fields, user_email
  ) VALUES (
    'purchase_invoices',
    'HISTORICAL_CORRECTION',
    v_invoice_id,
    jsonb_build_object(
      'exchange_rate',    v_orig_inv_rate,
      '_migration_id',    v_migration_id,
      '_correction_date', NOW(),
      '_affected_invoice','E0000311/2526',
      '_affected_voucher','PV/26-26/001',
      '_reason',          'exchange_rate was 1.0 — data entry omission at invoice creation. Authoritative source: batches.exchange_rate_usd_to_idr = 16800 for batch XMEP250178 (import_date 2025-12-30, same date as invoice). Rate of 16,800 was used for inventory unit cost calculation in the same batch record.',
      '_rollback_sql',    'UPDATE purchase_invoices SET exchange_rate = 1, updated_at = NOW() WHERE id = ''b505eac1-0938-4bec-bfcf-0eb998b79530'';'
    ),
    jsonb_build_object(
      'exchange_rate', v_correct_inv_rate,
      '_source',       'batches.exchange_rate_usd_to_idr for batch XMEP250178 (import_date 2025-12-30)'
    ),
    ARRAY['exchange_rate'],
    'migration:' || v_migration_id
  );

  -- ── 5. APPLY: Fix payment voucher bank account ─────────────────
  UPDATE payment_vouchers
  SET bank_account_id = v_correct_bank_id,
      updated_at      = NOW()
  WHERE id = v_pv_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION '[%] Expected 1 row updated on payment_vouchers, got %', v_migration_id, v_rows_affected;
  END IF;

  -- ── 6. APPLY: Fix JE line 3 account (1111 → 111102) ──────────
  UPDATE journal_entry_lines
  SET account_id = v_correct_je_coa_id
  WHERE id = v_je_line_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION '[%] Expected 1 row updated on journal_entry_lines, got %', v_migration_id, v_rows_affected;
  END IF;

  -- ── 7. APPLY: Fix invoice exchange rate (1 → 16800) ───────────
  UPDATE purchase_invoices
  SET exchange_rate = v_correct_inv_rate,
      updated_at    = NOW()
  WHERE id = v_invoice_id;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected <> 1 THEN
    RAISE EXCEPTION '[%] Expected 1 row updated on purchase_invoices, got %', v_migration_id, v_rows_affected;
  END IF;

  RAISE NOTICE '[%] Correction applied successfully. 3 records updated, 3 audit entries written.', v_migration_id;
END;
$$;
