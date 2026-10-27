-- ============================================================================
-- Tax Compliance — Accounting Engine Bug Fixes (2026-07-13)
-- ============================================================================
-- Fixes 7 post-integration issues without changing the UI or schema shape:
--
--   1. NOTIFY pgrst reload schema — PostgREST had stale cache after the
--      ALTER TABLE ADD COLUMN in migration 20260713160000. This caused
--      delete_tax_payment() to be unreachable and bank_statement_lines
--      queries to fail silently (breaking the Expense "Link to Bank
--      Transaction" dropdown and making Tax Compliance pages show Rp0).
--
--   2. auto_reconcile_tax_payment_from_bsl() hardened — adds a
--      source_module='tax_payment' guard before acting on matched_entry_id
--      so it can never interfere with expense / receipt / petty-cash
--      reconciliation. The BEFORE UPDATE trigger remains but is now
--      completely no-op unless the matched JE actually belongs to a
--      tax_payment. Also: the "unmatch" block is narrowed to only fire
--      when the BSL was matched to a tax_payment JE (not just any JE).
--
--   3. compute_period_ppn() and backfill re-run — idempotent, safe on
--      production. Refreshes every tax_periods snapshot row so the
--      Tax Compliance UI shows live values (not stale zeros).
--
--   4. Re-grant delete_tax_payment and update_tax_payment — ensures the
--      functions are callable by authenticated users regardless of whether
--      the previous migration's GRANT ran before or after NOTIFY.
--
-- Additive-only. No schema changes. Idempotent.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Harden auto_reconcile_tax_payment_from_bsl
--    Only act when the matched_entry_id belongs to a tax_payment JE.
--    This prevents ANY interference with expense / receipt / petty-cash
--    reconciliation which use matched_expense_id / matched_receipt_id etc.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_reconcile_tax_payment_from_bsl()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tax_payment_id uuid;
  v_is_tax_je      boolean := false;
BEGIN
  -- ── MATCH path ──────────────────────────────────────────────────────────
  -- Only fire when status flips to 'matched' AND matched_entry_id is set.
  -- Also guard that the matched_entry_id belongs to a tax_payment JE — this
  -- prevents the trigger from ever touching expense/receipt/petty-cash BSLs.
  IF NEW.reconciliation_status = 'matched'
     AND (OLD.reconciliation_status IS DISTINCT FROM NEW.reconciliation_status)
     AND NEW.matched_entry_id IS NOT NULL
  THEN
    SELECT EXISTS (
      SELECT 1 FROM journal_entries
       WHERE id = NEW.matched_entry_id
         AND source_module = 'tax_payment'
    ) INTO v_is_tax_je;

    IF v_is_tax_je THEN
      SELECT id INTO v_tax_payment_id
        FROM tax_payments
       WHERE journal_entry_id = NEW.matched_entry_id
         AND status IN ('posted', 'draft');

      IF v_tax_payment_id IS NOT NULL THEN
        UPDATE tax_payments
           SET status = 'reconciled', updated_at = now()
         WHERE id = v_tax_payment_id;
        -- Write typed FK for symmetry with other modules
        NEW.matched_tax_payment_id := v_tax_payment_id;
      END IF;
    END IF;
  END IF;

  -- ── UNMATCH path ─────────────────────────────────────────────────────────
  -- Only act when the line had a typed tax_payment FK and now loses it
  -- (or the status reverts from 'matched'). Never touch lines whose
  -- matched_tax_payment_id was never set.
  IF (NEW.reconciliation_status IS DISTINCT FROM 'matched'
      OR NEW.matched_entry_id IS NULL)
     AND OLD.matched_tax_payment_id IS NOT NULL
     AND NEW.matched_tax_payment_id IS NOT DISTINCT FROM OLD.matched_tax_payment_id
  THEN
    -- Verify the payment was actually reconciled (not already reset by delete_tax_payment)
    UPDATE tax_payments
       SET status = 'posted', updated_at = now()
     WHERE id = OLD.matched_tax_payment_id
       AND status = 'reconciled';

    NEW.matched_tax_payment_id := NULL;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_reconcile_tax_payment_from_bsl ON bank_statement_lines;
CREATE TRIGGER trg_auto_reconcile_tax_payment_from_bsl
  BEFORE UPDATE OF reconciliation_status, matched_entry_id, matched_tax_payment_id
  ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.auto_reconcile_tax_payment_from_bsl();

-- ============================================================================
-- 2. auto_reconcile_tax_payment (bank_reconciliation_items path)
--    Same hardening: guard source_module before acting.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.auto_reconcile_tax_payment()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tax_payment_id uuid;
  v_is_tax_je      boolean := false;
BEGIN
  IF NEW.is_matched = true
     AND (OLD.is_matched IS DISTINCT FROM NEW.is_matched)
     AND NEW.journal_entry_id IS NOT NULL
  THEN
    -- Only act on tax_payment JEs
    SELECT EXISTS (
      SELECT 1 FROM journal_entries
       WHERE id = NEW.journal_entry_id
         AND source_module = 'tax_payment'
    ) INTO v_is_tax_je;

    IF v_is_tax_je THEN
      SELECT id INTO v_tax_payment_id
        FROM tax_payments
       WHERE journal_entry_id = NEW.journal_entry_id
         AND status = 'posted';

      IF v_tax_payment_id IS NOT NULL THEN
        UPDATE tax_payments
           SET status = 'reconciled', updated_at = now()
         WHERE id = v_tax_payment_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_reconcile_tax_payment ON bank_reconciliation_items;
CREATE TRIGGER trg_auto_reconcile_tax_payment
  AFTER UPDATE OF is_matched ON bank_reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION public.auto_reconcile_tax_payment();

-- ============================================================================
-- 3. Re-run snapshot backfill (idempotent — compute_period_ppn is safe on
--    closed periods; it only updates cached totals, not status).
--    This populates tax_periods.input_ppn_total / output_ppn_total / net_ppn
--    for every period so Tax Compliance pages show live values.
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

-- ============================================================================
-- 4. Re-grant RPCs (idempotent, safe to repeat)
-- ============================================================================
REVOKE ALL     ON FUNCTION public.delete_tax_payment(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_tax_payment(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_tax_payment(uuid) TO authenticated;

REVOKE ALL     ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.update_tax_payment(uuid, date, numeric, uuid, text, text, text, text, text) TO authenticated;

-- ============================================================================
-- 5. Schema cache refresh — tells PostgREST to reload immediately.
--    Fixes: delete_tax_payment not found, bank_statement_lines column
--    errors, expense dropdown returning no rows.
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
