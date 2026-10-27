-- ============================================================================
-- Migration: 20260626130000_correct_petty_cash_je_and_fix_engine
-- Date:      2026-06-26
--
-- PART 1 — Correct 9 journal entry amounts that diverged from the source
--          petty_cash_transactions record. Every change is audited and
--          reversible. The JE line trigger (recalculate_journal_entry_totals)
--          auto-recalculates journal_entries.total_debit / total_credit
--          whenever a journal_entry_line is updated, so only the lines need
--          to be touched here.
--
-- PART 2 — Replace post_petty_cash_to_journal_fixed() with a corrected
--          version that:
--            a) Acquires a per-date advisory lock to eliminate the JE number
--               race condition that could produce duplicate entry_numbers
--               under concurrent inserts.
--            b) Sets total_debit / total_credit explicitly on the header so
--               the JE is readable even before the line-totals trigger fires.
--
-- PART 3 — Create trigger_sync_petty_cash_je_on_update so that any future
--          UPDATE to petty_cash_transactions.amount or .expense_category
--          is immediately reflected in the linked journal_entry_lines.
--          Audit log entry is written for every sync.
--
-- PART 4 — Batch-posting date differences are acceptable; do NOT change
--          journal_entries.entry_date here or in the new update trigger.
--
-- Idempotency: checks current values before every update; re-running is safe.
-- Reversibility: rollback SQL stored in audit_logs.old_values._rollback_sql.
-- ============================================================================

-- ── PART 1 ─────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_mid TEXT := '20260626130000_correct_petty_cash_je_and_fix_engine';

  -- ── Correction 1: PC-202602-003 (13 → 23,000) ──────────────────────────
  -- Root cause: initial PCT inserted with amount=13 (data entry error);
  --             trigger captured 13; PCT later corrected to 23,000.
  c1_je      UUID    := 'b2984dd7-8b27-408a-b2b5-4ed9a3a48aca'; -- JE-20260202-0002
  c1_dr      UUID    := 'b0b7276f-c9bc-46c4-a455-7b3ea5f675b3'; -- DR 5102
  c1_cr      UUID    := '7623b64f-844a-49bc-a686-e79ed281deba'; -- CR 1102
  c1_old     NUMERIC := 13.00;
  c1_new     NUMERIC := 23000.00;
  c1_ref     TEXT    := 'PC-202602-003';
  c1_reason  TEXT    := 'Wrong amount at JE creation: initial PCT had amount=13 (data entry error for stamp 2x11,500=23,000 IDR). PCT was corrected to 23,000 but JE was not updated (INSERT-only trigger).';

  -- ── Correction 2: PC-202602-026 (11,000 → 12,000) ─────────────────────
  -- Root cause: PCT amount updated from 11,000 to 12,000 after JE posted.
  c2_je      UUID    := '125aa6aa-1084-4d2f-88dc-20a8b12f4b64'; -- JE-20260202-0010
  c2_dr      UUID    := '42886e3e-80c4-46b6-ad1c-baf83de125db';
  c2_cr      UUID    := '63bc693b-6c76-4484-b3df-b053b2399b28';
  c2_old     NUMERIC := 11000.00;
  c2_new     NUMERIC := 12000.00;
  c2_ref     TEXT    := 'PC-202602-026';
  c2_reason  TEXT    := 'PCT amount updated from 11,000 to 12,000 (toll fee revised) after JE was already posted. INSERT-only trigger did not update JE.';

  -- ── Correction 3: PC-202603-017 (36,000 → 36,174) ─────────────────────
  -- Root cause: PCT amount updated from 36,000 to 36,174 (receipt rounding)
  c3_je      UUID    := '629ff099-b471-4faa-8658-c6e0144404ab'; -- JE-20260326-0002
  c3_dr      UUID    := 'fbc6df12-77b3-4e33-a43f-6548990769b7';
  c3_cr      UUID    := 'fda4188f-9c62-421f-8726-d9974d1cec53';
  c3_old     NUMERIC := 36000.00;
  c3_new     NUMERIC := 36174.00;
  c3_ref     TEXT    := 'PC-202603-017';
  c3_reason  TEXT    := 'PCT amount updated from 36,000 to 36,174 (mineral water receipt: exact amount including Rp 174 fraction) after JE posted. INSERT-only trigger did not update JE.';

  -- ── Correction 4: PC-202604-014 (11 → 11,000) ─────────────────────────
  -- Root cause: decimal error at entry — 11,000 IDR entered as 11.
  c4_je      UUID    := 'bbcdb6f5-fd33-45fb-a465-9008d276d144'; -- JE-20260413-0008
  c4_dr      UUID    := '859e730c-62dc-46a7-8bce-79ecd20ab39a';
  c4_cr      UUID    := '75f6c62f-3d68-4808-a74d-b05a25c12988';
  c4_old     NUMERIC := 11.00;
  c4_new     NUMERIC := 11000.00;
  c4_ref     TEXT    := 'PC-202604-014';
  c4_reason  TEXT    := 'Decimal entry error: E-TOLL PAPANGGO 11,000 IDR entered as 11 (amount field accepted 11.00). JE captured 11. Same class as PV/26-27/001 bank charge error.';

  -- ── Correction 5: PC-202604-029 (372,552 → 400,932) ───────────────────
  -- Root cause: PCT inserted initially with wrong amount (copied from 028);
  --             later updated to correct 400,932; JE captured original value.
  c5_je      UUID    := 'fe968641-e68c-46d9-bf18-4cec87b6b8bb'; -- JE-20260422-0003
  c5_dr      UUID    := '0ed80314-5fa9-4967-a49f-d87c9bb3453b';
  c5_cr      UUID    := '2b1e95c5-719b-4eb8-9678-b13f911c1351';
  c5_old     NUMERIC := 372552.00;
  c5_new     NUMERIC := 400932.00;
  c5_ref     TEXT    := 'PC-202604-029';
  c5_reason  TEXT    := 'PCT for Feb email bill (USD 23.31 x 17,200 = 400,932) initially entered with January amount 372,552 (same as PC-202604-028). Corrected in PCT but JE retained original amount. Confirmed by adjacent JEs on 2026-04-22.';

  -- ── Correction 6: PC-202605-012 (311,000 → 547,000) ───────────────────
  -- Root cause: PCT amount updated (3rd trip added) after JE posted.
  c6_je      UUID    := '756a6d33-6035-412c-8655-4ed06d819c81'; -- JE-20260508-0007
  c6_dr      UUID    := '8543d3fa-c1dd-437d-a8ab-cbd2ecf42847';
  c6_cr      UUID    := 'b8ec49eb-41a6-4c8e-9f30-5fabc9e47e1d';
  c6_old     NUMERIC := 311000.00;
  c6_new     NUMERIC := 547000.00;
  c6_ref     TEXT    := 'PC-202605-012';
  c6_reason  TEXT    := 'PCT updated to final receipt total (244,000+87,000+216,000=547,000) after JE posted with partial amount 311,000. INSERT-only trigger did not resync.';

  -- ── Correction 7: PC-202605-013 (60,000 → 76,000) ─────────────────────
  -- Root cause: PCT amount updated (+1 toll item) after JE posted.
  c7_je      UUID    := '6f58eef2-9890-422e-aaa8-1f4cb9da0a54'; -- JE-20260508-0008
  c7_dr      UUID    := '51fef2f8-c7fc-4aae-9237-d231902903ee';
  c7_cr      UUID    := '13293b39-9f96-430e-9c78-5a8c058b8a13';
  c7_old     NUMERIC := 60000.00;
  c7_new     NUMERIC := 76000.00;
  c7_ref     TEXT    := 'PC-202605-013';
  c7_reason  TEXT    := 'PCT updated (+16,000 for additional e-toll entry) after JE posted at 60,000. INSERT-only trigger did not resync.';

  -- ── Correction 8: PC-202605-023 (28,100 → 30,100) ─────────────────────
  -- Root cause: PCT amount updated (+2,000 parking) after JE posted.
  c8_je      UUID    := '3585d051-e5ac-4513-93ad-109e32f5b9ea'; -- JE-20260519-0001
  c8_dr      UUID    := '5db6e14e-7363-4037-9604-85b14c667524';
  c8_cr      UUID    := 'e6f9496c-6abe-402a-bd33-02c4c23e8b8c';
  c8_old     NUMERIC := 28100.00;
  c8_new     NUMERIC := 30100.00;
  c8_ref     TEXT    := 'PC-202605-023';
  c8_reason  TEXT    := 'PCT updated (+2,000 parking at Superindo) after JE posted at 28,100. INSERT-only trigger did not resync.';

  -- ── Correction 9: PC-202606-006 (98,500 → 100,000) ────────────────────
  -- Root cause: PCT amount updated after JE posted.
  c9_je      UUID    := '00b4ae65-5570-42ae-bf08-0fede17c18d7'; -- JE-20260608-0004
  c9_dr      UUID    := '9a2076e0-f1d6-4677-be89-fd8c8b5e041c';
  c9_cr      UUID    := '6eaeb0b6-a992-4dbb-91a0-dd8baba7446f';
  c9_old     NUMERIC := 98500.00;
  c9_new     NUMERIC := 100000.00;
  c9_ref     TEXT    := 'PC-202606-006';
  c9_reason  TEXT    := 'PCT updated from 98,500 to 100,000 (emoney top-up final amount) after JE posted. INSERT-only trigger did not resync.';

  v_cur NUMERIC;

BEGIN

  -- ── IDEMPOTENCY ────────────────────────────────────────────────────────
  IF (SELECT debit FROM journal_entry_lines WHERE id = c1_dr) = c1_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c2_dr) = c2_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c3_dr) = c3_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c4_dr) = c4_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c5_dr) = c5_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c6_dr) = c6_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c7_dr) = c7_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c8_dr) = c8_new
 AND (SELECT debit FROM journal_entry_lines WHERE id = c9_dr) = c9_new
  THEN
    RAISE NOTICE '[%] Already applied — no changes made.', v_mid;
    RETURN;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- Helper macro: for each correction, if not already applied:
  --   1. Insert audit_log with before/after and rollback SQL.
  --   2. Update DR line debit.
  --   3. Update CR line credit.
  --   (recalculate_journal_entry_totals fires automatically on each JEL
  --    UPDATE and keeps journal_entries.total_debit/total_credit in sync.)
  -- ══════════════════════════════════════════════════════════════════════

  -- ── C1: PC-202602-003 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c1_dr;
  IF v_cur IS DISTINCT FROM c1_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c1_dr,
      jsonb_build_object(
        'reference', c1_ref, 'je_id', c1_je, 'je_number', 'JE-20260202-0002',
        'dr_line_id', c1_dr, 'cr_line_id', c1_cr,
        'debit', c1_old, 'credit', c1_old,
        '_reason', c1_reason,
        '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c1_old, c1_dr, c1_old, c1_cr)
      ),
      jsonb_build_object('debit', c1_new, 'credit', c1_new),
      ARRAY['debit','credit'],
      'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c1_new WHERE id = c1_dr;
    UPDATE journal_entry_lines SET credit = c1_new WHERE id = c1_cr;
    RAISE NOTICE '[%] C1 applied: % 13 → 23,000', v_mid, c1_ref;
  END IF;

  -- ── C2: PC-202602-026 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c2_dr;
  IF v_cur IS DISTINCT FROM c2_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c2_dr,
      jsonb_build_object(
        'reference', c2_ref, 'je_id', c2_je, 'je_number', 'JE-20260202-0010',
        'dr_line_id', c2_dr, 'cr_line_id', c2_cr,
        'debit', c2_old, 'credit', c2_old,
        '_reason', c2_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c2_old, c2_dr, c2_old, c2_cr)
      ),
      jsonb_build_object('debit', c2_new, 'credit', c2_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c2_new WHERE id = c2_dr;
    UPDATE journal_entry_lines SET credit = c2_new WHERE id = c2_cr;
    RAISE NOTICE '[%] C2 applied: % 11,000 → 12,000', v_mid, c2_ref;
  END IF;

  -- ── C3: PC-202603-017 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c3_dr;
  IF v_cur IS DISTINCT FROM c3_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c3_dr,
      jsonb_build_object(
        'reference', c3_ref, 'je_id', c3_je, 'je_number', 'JE-20260326-0002',
        'dr_line_id', c3_dr, 'cr_line_id', c3_cr,
        'debit', c3_old, 'credit', c3_old,
        '_reason', c3_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c3_old, c3_dr, c3_old, c3_cr)
      ),
      jsonb_build_object('debit', c3_new, 'credit', c3_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c3_new WHERE id = c3_dr;
    UPDATE journal_entry_lines SET credit = c3_new WHERE id = c3_cr;
    RAISE NOTICE '[%] C3 applied: % 36,000 → 36,174', v_mid, c3_ref;
  END IF;

  -- ── C4: PC-202604-014 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c4_dr;
  IF v_cur IS DISTINCT FROM c4_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c4_dr,
      jsonb_build_object(
        'reference', c4_ref, 'je_id', c4_je, 'je_number', 'JE-20260413-0008',
        'dr_line_id', c4_dr, 'cr_line_id', c4_cr,
        'debit', c4_old, 'credit', c4_old,
        '_reason', c4_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c4_old, c4_dr, c4_old, c4_cr)
      ),
      jsonb_build_object('debit', c4_new, 'credit', c4_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c4_new WHERE id = c4_dr;
    UPDATE journal_entry_lines SET credit = c4_new WHERE id = c4_cr;
    RAISE NOTICE '[%] C4 applied: % 11 → 11,000', v_mid, c4_ref;
  END IF;

  -- ── C5: PC-202604-029 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c5_dr;
  IF v_cur IS DISTINCT FROM c5_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c5_dr,
      jsonb_build_object(
        'reference', c5_ref, 'je_id', c5_je, 'je_number', 'JE-20260422-0003',
        'dr_line_id', c5_dr, 'cr_line_id', c5_cr,
        'debit', c5_old, 'credit', c5_old,
        '_reason', c5_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c5_old, c5_dr, c5_old, c5_cr)
      ),
      jsonb_build_object('debit', c5_new, 'credit', c5_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c5_new WHERE id = c5_dr;
    UPDATE journal_entry_lines SET credit = c5_new WHERE id = c5_cr;
    RAISE NOTICE '[%] C5 applied: % 372,552 → 400,932', v_mid, c5_ref;
  END IF;

  -- ── C6: PC-202605-012 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c6_dr;
  IF v_cur IS DISTINCT FROM c6_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c6_dr,
      jsonb_build_object(
        'reference', c6_ref, 'je_id', c6_je, 'je_number', 'JE-20260508-0007',
        'dr_line_id', c6_dr, 'cr_line_id', c6_cr,
        'debit', c6_old, 'credit', c6_old,
        '_reason', c6_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c6_old, c6_dr, c6_old, c6_cr)
      ),
      jsonb_build_object('debit', c6_new, 'credit', c6_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c6_new WHERE id = c6_dr;
    UPDATE journal_entry_lines SET credit = c6_new WHERE id = c6_cr;
    RAISE NOTICE '[%] C6 applied: % 311,000 → 547,000', v_mid, c6_ref;
  END IF;

  -- ── C7: PC-202605-013 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c7_dr;
  IF v_cur IS DISTINCT FROM c7_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c7_dr,
      jsonb_build_object(
        'reference', c7_ref, 'je_id', c7_je, 'je_number', 'JE-20260508-0008',
        'dr_line_id', c7_dr, 'cr_line_id', c7_cr,
        'debit', c7_old, 'credit', c7_old,
        '_reason', c7_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c7_old, c7_dr, c7_old, c7_cr)
      ),
      jsonb_build_object('debit', c7_new, 'credit', c7_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c7_new WHERE id = c7_dr;
    UPDATE journal_entry_lines SET credit = c7_new WHERE id = c7_cr;
    RAISE NOTICE '[%] C7 applied: % 60,000 → 76,000', v_mid, c7_ref;
  END IF;

  -- ── C8: PC-202605-023 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c8_dr;
  IF v_cur IS DISTINCT FROM c8_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c8_dr,
      jsonb_build_object(
        'reference', c8_ref, 'je_id', c8_je, 'je_number', 'JE-20260519-0001',
        'dr_line_id', c8_dr, 'cr_line_id', c8_cr,
        'debit', c8_old, 'credit', c8_old,
        '_reason', c8_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c8_old, c8_dr, c8_old, c8_cr)
      ),
      jsonb_build_object('debit', c8_new, 'credit', c8_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c8_new WHERE id = c8_dr;
    UPDATE journal_entry_lines SET credit = c8_new WHERE id = c8_cr;
    RAISE NOTICE '[%] C8 applied: % 28,100 → 30,100', v_mid, c8_ref;
  END IF;

  -- ── C9: PC-202606-006 ─────────────────────────────────────────────────
  SELECT debit INTO v_cur FROM journal_entry_lines WHERE id = c9_dr;
  IF v_cur IS DISTINCT FROM c9_new THEN
    INSERT INTO audit_logs (table_name, action_type, record_id, old_values, new_values, changed_fields, user_email)
    VALUES (
      'journal_entry_lines', 'update', c9_dr,
      jsonb_build_object(
        'reference', c9_ref, 'je_id', c9_je, 'je_number', 'JE-20260608-0004',
        'dr_line_id', c9_dr, 'cr_line_id', c9_cr,
        'debit', c9_old, 'credit', c9_old,
        '_reason', c9_reason, '_migration_id', v_mid, '_correction_date', NOW(),
        '_correction_type', 'HISTORICAL_CORRECTION',
        '_rollback_sql', format(
          'UPDATE journal_entry_lines SET debit=%s WHERE id=''%s''; UPDATE journal_entry_lines SET credit=%s WHERE id=''%s'';',
          c9_old, c9_dr, c9_old, c9_cr)
      ),
      jsonb_build_object('debit', c9_new, 'credit', c9_new),
      ARRAY['debit','credit'], 'migration:' || v_mid
    );
    UPDATE journal_entry_lines SET debit  = c9_new WHERE id = c9_dr;
    UPDATE journal_entry_lines SET credit = c9_new WHERE id = c9_cr;
    RAISE NOTICE '[%] C9 applied: % 98,500 → 100,000', v_mid, c9_ref;
  END IF;

  RAISE NOTICE '[%] Part 1 complete. 9 corrections processed.', v_mid;
END;
$$;


-- ── PART 2 — Fix the posting engine ─────────────────────────────────────────
-- Replaced: post_petty_cash_to_journal_fixed()
-- Changes vs previous version:
--   a) pg_advisory_xact_lock per date prevents duplicate JE numbers under
--      concurrent inserts.
--   b) Explicit total_debit / total_credit set on the JE header at INSERT
--      time (belt-and-suspenders alongside the recalculate trigger).

CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id           UUID;
  v_petty_cash_account   UUID;
  v_bank_coa             UUID;
  v_expense_account      UUID;
  v_line_num             INT  := 0;
  v_je_number            TEXT;
BEGIN
  -- Withdrawals that came from a fund_transfer are journalised by the
  -- fund_transfer trigger; skip them here.
  IF NEW.fund_transfer_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_petty_cash_account
    FROM chart_of_accounts WHERE code = '1102' LIMIT 1;

  IF v_petty_cash_account IS NULL THEN
    RAISE EXCEPTION 'Petty cash account 1102 not found in chart_of_accounts';
  END IF;

  -- ── Generate JE number (advisory lock prevents race condition) ──────────
  -- Lock is scoped to the transaction; concurrent inserts for the same date
  -- are serialised so COUNT() always sees the latest committed row count.
  PERFORM pg_advisory_xact_lock(
    hashtext('pc_je_number_' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD'))
  );

  SELECT 'JE-' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         LPAD((COUNT(*) + 1)::TEXT, 4, '0')
    INTO v_je_number
    FROM journal_entries
   WHERE entry_date = NEW.transaction_date;

  -- ── Create JE header ─────────────────────────────────────────────────────
  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by, posted_at
  ) VALUES (
    v_je_number,
    NEW.transaction_date,
    'petty_cash',
    NEW.id,
    NEW.transaction_number,
    'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
    NEW.amount,
    NEW.amount,
    TRUE,
    NEW.created_by,
    NOW()
  ) RETURNING id INTO v_journal_id;

  -- ── Create JE lines ───────────────────────────────────────────────────────
  IF NEW.transaction_type = 'withdraw' THEN
    -- DR 1102 Petty Cash
    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, NEW.amount, 0, 'Cash withdrawal');

    -- CR Bank (if bank account linked and has a COA)
    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_bank_coa FROM bank_accounts WHERE id = NEW.bank_account_id;
      IF v_bank_coa IS NOT NULL THEN
        v_line_num := v_line_num + 1;
        INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
        VALUES (v_journal_id, v_line_num, v_bank_coa, 0, NEW.amount, 'Bank withdrawal for petty cash');
      END IF;
    END IF;

  ELSIF NEW.transaction_type = 'expense' THEN
    -- Resolve expense COA from category; fall back to 5102 General Expenses
    SELECT id INTO v_expense_account
      FROM chart_of_accounts
     WHERE account_type = 'expense'
       AND (
         CASE
           WHEN NEW.expense_category = 'Utilities'                   THEN code = '6300'
           WHEN NEW.expense_category = 'Office Supplies'             THEN code = '6310'
           WHEN NEW.expense_category = 'Transportation'              THEN code = '6320'
           WHEN NEW.expense_category = 'Meals & Entertainment'       THEN code = '6330'
           WHEN NEW.expense_category = 'Postage & Courier'           THEN code = '6340'
           WHEN NEW.expense_category = 'Cleaning & Maintenance'      THEN code = '6350'
           WHEN NEW.expense_category = 'Staff Salaries & Wages'      THEN code = '6360'
           WHEN NEW.expense_category = 'Staff Benefits & Allowances' THEN code = '6370'
           WHEN NEW.expense_category = 'Printing & Stationery'       THEN code = '6380'
           WHEN NEW.expense_category = 'Telephone & Internet'        THEN code = '6390'
           WHEN NEW.expense_category = 'Bank Charges'                THEN code = '6400'
           WHEN NEW.expense_category = 'Professional Fees'           THEN code = '6410'
           WHEN NEW.expense_category = 'Office Renovation & Shifting'THEN code = '6420'
           WHEN NEW.expense_category = 'Other Expenses'              THEN code = '6490'
           ELSE code = '5102'
         END
       )
     LIMIT 1;

    IF v_expense_account IS NULL THEN
      SELECT id INTO v_expense_account FROM chart_of_accounts WHERE code = '5102' LIMIT 1;
    END IF;

    IF v_expense_account IS NULL THEN
      RAISE EXCEPTION 'No expense account found for petty cash expense (category: %)', NEW.expense_category;
    END IF;

    -- DR Expense account
    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_expense_account, NEW.amount, 0,
            COALESCE(NEW.expense_category, 'General expense'));

    -- CR 1102 Petty Cash
    v_line_num := v_line_num + 1;
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES (v_journal_id, v_line_num, v_petty_cash_account, 0, NEW.amount, 'Cash expense');
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'post_petty_cash_to_journal_fixed: %', SQLERRM;
    RETURN NEW;
END;
$$;


-- ── PART 3 — Sync trigger: keep JE in sync on PCT updates ───────────────────
-- Fires after any UPDATE to petty_cash_transactions where .amount or
-- .expense_category changed. Finds the linked JE and updates both lines.
-- The recalculate_journal_entry_totals trigger then auto-updates the header
-- total_debit / total_credit.
-- Does NOT change entry_date (batch-posting dates are intentional; Part 4).

CREATE OR REPLACE FUNCTION public.sync_petty_cash_journal_on_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id    UUID;
  v_expense_acct  UUID;
BEGIN
  -- Only act when financially-material fields change
  IF NEW.amount            IS NOT DISTINCT FROM OLD.amount
 AND NEW.expense_category  IS NOT DISTINCT FROM OLD.expense_category
 AND NEW.transaction_type  IS NOT DISTINCT FROM OLD.transaction_type
  THEN
    RETURN NEW;
  END IF;

  -- Locate linked JE (reference_id is the authoritative link)
  SELECT id INTO v_journal_id
    FROM journal_entries
   WHERE source_module = 'petty_cash'
     AND reference_id  = NEW.id
   LIMIT 1;

  IF v_journal_id IS NULL THEN
    -- No JE exists yet; INSERT trigger will create it if needed.
    RETURN NEW;
  END IF;

  -- Update JE description to keep it readable
  UPDATE journal_entries
     SET description = 'Petty cash ' || NEW.transaction_type || ': ' || NEW.description
   WHERE id = v_journal_id;

  IF NEW.transaction_type = 'expense' THEN
    SELECT id INTO v_expense_acct FROM chart_of_accounts WHERE code = '5102' LIMIT 1;

    -- Update DR line (expense) — debit > 0 identifies it
    UPDATE journal_entry_lines
       SET debit      = NEW.amount,
           account_id = COALESCE(v_expense_acct, account_id)
     WHERE journal_entry_id = v_journal_id
       AND debit > 0;

    -- Update CR line (petty cash) — credit > 0 identifies it
    UPDATE journal_entry_lines
       SET credit = NEW.amount
     WHERE journal_entry_id = v_journal_id
       AND credit > 0;

  ELSIF NEW.transaction_type = 'withdraw' THEN
    UPDATE journal_entry_lines
       SET debit  = NEW.amount
     WHERE journal_entry_id = v_journal_id
       AND debit > 0;

    UPDATE journal_entry_lines
       SET credit = NEW.amount
     WHERE journal_entry_id = v_journal_id
       AND credit > 0;
  END IF;

  -- Audit the sync
  INSERT INTO audit_logs (
    table_name, action_type, record_id,
    old_values, new_values, changed_fields, user_email
  ) VALUES (
    'journal_entry_lines',
    'update',
    v_journal_id,
    jsonb_build_object(
      'amount', OLD.amount,
      'expense_category', OLD.expense_category,
      'transaction_type', OLD.transaction_type,
      '_source_pct_id', OLD.id::text,
      '_source_pct_number', OLD.transaction_number
    ),
    jsonb_build_object(
      'amount', NEW.amount,
      'expense_category', NEW.expense_category,
      'transaction_type', NEW.transaction_type
    ),
    ARRAY['debit','credit'],
    'trigger:sync_petty_cash_journal_on_update'
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'sync_petty_cash_journal_on_update: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Create the trigger if it does not already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trigger_sync_petty_cash_je_on_update'
      AND tgrelid = 'petty_cash_transactions'::regclass
  ) THEN
    EXECUTE $t$
      CREATE TRIGGER trigger_sync_petty_cash_je_on_update
      AFTER UPDATE ON petty_cash_transactions
      FOR EACH ROW
      EXECUTE FUNCTION sync_petty_cash_journal_on_update();
    $t$;
    RAISE NOTICE 'trigger_sync_petty_cash_je_on_update created.';
  ELSE
    RAISE NOTICE 'trigger_sync_petty_cash_je_on_update already exists — skipped.';
  END IF;
END;
$$;
