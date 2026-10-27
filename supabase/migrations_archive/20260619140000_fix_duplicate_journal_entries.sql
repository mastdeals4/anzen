/*
  # Fix duplicate journal entries in Account Ledger

  ## Root cause — expenses only
  The auto_post_expense_accounting() trigger uses LIMIT 1 when deleting the old
  journal entry on UPDATE. If an expense had two duplicate JEs (from before the
  2026-04-30 index migration), only one got deleted per update, leaving the
  second duplicate alongside the newly created JE — perpetuating duplicates.

  All other modules (receipt, payment, purchase, sales, petty_cash, fund_transfer,
  import_cost) populate reference_id and are protected by the existing
  uq_journal_entries_source_reference index (source_module, reference_id).
  The 20260430000000 cleanup migration already deduplicated those and applied that
  index successfully, confirming no duplicates existed for them at that point.
  The unique index has prevented new duplicates for those modules ever since.

  Expenses leave reference_id = NULL and key on reference_number ('EXP-<uuid>'),
  so they were never covered by any existing index and accumulated duplicates.

  ## Fix
  1. One-time cleanup: delete older duplicate expense JEs, keeping the most recent
     per (source_module, reference_number). Uses same ORDER BY pattern as the
     20260430000000 cleanup (created_at DESC NULLS LAST, id DESC).
  2. Add unique index on (source_module, reference_number) — the missing guard
     for expense entries.
  3. Fix trigger UPDATE path: replace SELECT…LIMIT 1 + single DELETE with a
     bulk DELETE of ALL matching JEs before recreating, so any pre-existing
     duplicates are always fully cleared on next expense edit.
*/

-- ===========================================================================
-- 1. CLEAN UP EXISTING DUPLICATE JOURNAL ENTRIES (expenses)
-- Keep the most recently created JE per (source_module, reference_number).
-- Lines are deleted explicitly before headers; ON DELETE CASCADE would also
-- handle them, but explicit deletion avoids relying on constraint presence.
-- ===========================================================================

DO $$
DECLARE
  v_deleted_lines   INTEGER;
  v_deleted_entries INTEGER;
BEGIN
  -- Delete lines belonging to older duplicate JEs
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY source_module, reference_number
          ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS rn
      FROM public.journal_entries
      WHERE reference_number IS NOT NULL
        AND source_module    IS NOT NULL
    ) ranked
    WHERE rn > 1
  );
  GET DIAGNOSTICS v_deleted_lines = ROW_COUNT;

  -- Delete the orphaned duplicate JE header rows
  DELETE FROM public.journal_entries
  WHERE id IN (
    SELECT id FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY source_module, reference_number
          ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS rn
      FROM public.journal_entries
      WHERE reference_number IS NOT NULL
        AND source_module    IS NOT NULL
    ) ranked
    WHERE rn > 1
  );
  GET DIAGNOSTICS v_deleted_entries = ROW_COUNT;

  RAISE NOTICE 'Duplicate JE cleanup: deleted % lines across % entries', v_deleted_lines, v_deleted_entries;
END $$;

-- ===========================================================================
-- 2. UNIQUE CONSTRAINT on (source_module, reference_number)
-- Prevents future duplicate JEs for expense entries (which use reference_number,
-- not reference_id, and were therefore unprotected by the existing index).
-- ===========================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_journal_entries_source_ref_number
  ON public.journal_entries (source_module, reference_number)
  WHERE reference_number IS NOT NULL
    AND source_module    IS NOT NULL;

-- ===========================================================================
-- 3. FIX auto_post_expense_accounting — remove LIMIT 1 on UPDATE delete path
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- shared
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id         UUID;
  v_description        TEXT;
  v_credit_desc        TEXT;
  v_entry_number       TEXT;
  v_category_label     TEXT;
  -- pib_import split
  v_bm_account_id      UUID;
  v_ppn_account_id     UUID;
  v_pph_account_id     UUID;
  v_line_num           INTEGER;
BEGIN
  -- ── UPDATE: reverse ALL old journal entries if anything accounting-relevant changed ──
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.amount             = NEW.amount AND
      OLD.expense_category   = NEW.expense_category AND
      OLD.payment_method     IS NOT DISTINCT FROM NEW.payment_method AND
      OLD.bank_account_id    IS NOT DISTINCT FROM NEW.bank_account_id AND
      OLD.pib_bm_amount      IS NOT DISTINCT FROM NEW.pib_bm_amount AND
      OLD.pib_ppn_amount     IS NOT DISTINCT FROM NEW.pib_ppn_amount AND
      OLD.pib_pph_amount     IS NOT DISTINCT FROM NEW.pib_pph_amount
    ) THEN
      RETURN NEW; -- nothing accounting-relevant changed
    END IF;

    -- Delete ALL existing JEs for this expense (no LIMIT — clears any pre-existing duplicates too)
    DELETE FROM journal_entry_lines
    WHERE journal_entry_id IN (
      SELECT id FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    );
    DELETE FROM journal_entries
    WHERE reference_number = 'EXP-' || NEW.id::text;
  END IF;

  -- ── INSERT idempotency guard ──
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM journal_entries
      WHERE reference_number = 'EXP-' || NEW.id::text
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ── Resolve bank / cash payment account ──
  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

  -- ── Generate journal entry number ──
  SELECT
    'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-' ||
    LPAD(
      (COALESCE(
        MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0
      ) + 1)::TEXT,
      4, '0'
    )
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-%';

  -- ════════════════════════════════════════════════════════════════════════
  -- SPECIAL PATH: PIB Import — one bank payment split into three debit lines
  -- ════════════════════════════════════════════════════════════════════════
  IF NEW.expense_category = 'pib_import' THEN

    v_bm_account_id  := get_expense_account_id('duty_customs');
    v_ppn_account_id := get_expense_account_id('ppn_import');
    v_pph_account_id := get_expense_account_id('pph_import');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_number,
      description, transaction_category,
      total_debit, total_credit, is_posted, posted_at, created_by
    ) VALUES (
      v_entry_number,
      NEW.expense_date,
      'expenses',
      'EXP-' || NEW.id::text,
      COALESCE(NEW.description, 'PIB Import Payment'),
      'pib_import',
      NEW.amount,
      NEW.amount,
      true,
      now(),
      NEW.created_by
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    -- Dr Import Duty (BM) → capitalised to inventory
    IF COALESCE(NEW.pib_bm_amount, 0) > 0 AND v_bm_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_bm_account_id,
         NEW.pib_bm_amount, 0,
         'PIB - Import Duty (BM) [landed cost]');
      v_line_num := v_line_num + 1;
    END IF;

    -- Dr PPN Masukan (Input VAT) → asset, not expense
    IF COALESCE(NEW.pib_ppn_amount, 0) > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_ppn_account_id,
         NEW.pib_ppn_amount, 0,
         'PIB - PPN Import (Input VAT, PPN Masukan)');
      v_line_num := v_line_num + 1;
    END IF;

    -- Dr PPh 22 Dibayar Dimuka (Advance Income Tax) → asset, not expense
    IF COALESCE(NEW.pib_pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines
        (journal_entry_id, line_number, account_id, debit, credit, description)
      VALUES
        (v_journal_id, v_line_num, v_pph_account_id,
         NEW.pib_pph_amount, 0,
         'PIB - PPh 22 Dibayar Dimuka (Advance Income Tax)');
      v_line_num := v_line_num + 1;
    END IF;

    -- Cr Bank Account → single bank credit for full PIB amount
    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_line_num, v_payment_account_id,
       0, NEW.amount,
       'PIB - Bank payment [' || COALESCE(NEW.description, '') || ']');

    RETURN NEW;
  END IF;

  -- ════════════════════════════════════════════════════════════════════════
  -- STANDARD PATH: all other expense categories (2-line journal)
  -- ════════════════════════════════════════════════════════════════════════
  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description    := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc    := COALESCE(
                        SUBSTRING(NEW.description FROM '^[^\n]+'),
                        NEW.expense_category
                      ) || ' [' || v_category_label || ']';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    NEW.amount, NEW.amount, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  INSERT INTO journal_entry_lines
    (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_credit_desc);

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auto_post_expense_accounting failed for expense %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Re-attach trigger (fire on INSERT and UPDATE)
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT OR UPDATE ON public.finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_post_expense_accounting();

COMMENT ON FUNCTION public.auto_post_expense_accounting() IS
'Auto-posts journal entries for finance_expenses.
UPDATE path: deletes ALL existing JEs for the expense (not just one) before recreating,
so pre-existing duplicates are always cleared.
pib_import: 4-line split (Dr BM/1130 inventory, Dr PPN Masukan/1150, Dr PPh22/1155, Cr Bank).
All other categories: standard 2-line (Dr expense account, Cr payment account).';
