-- ============================================================================
-- Reconciliation Engine Hardening (2026-07-13)
-- ============================================================================
-- Pre-merge audit identified that Expenses, Receipts, and Petty Cash lacked
-- the same DB-level guarantee that Tax Payments and Fund Transfers have:
-- when the typed FK column is cleared (NULL) the reconciliation_status was
-- NOT automatically reset to 'unmatched'. The risk: ON DELETE SET NULL fires
-- on a referenced document row, clears matched_receipt_id / matched_petty_cash_id,
-- but leaves reconciliation_status = 'matched' — a stale / orphaned status.
--
-- Fix: A single BEFORE UPDATE trigger on bank_statement_lines that acts as
-- the SHARED STATUS-SYNC ENGINE for ALL typed FK columns:
--
--   Typed FK set (non-NULL)  → reconciliation_status = 'matched'
--   All typed FKs cleared     → reconciliation_status = 'unmatched'
--   Some FKs still set        → reconciliation_status = 'matched'  (stays)
--
-- This is purely additive and covers:
--   • matched_expense_id       → finance_expenses
--   • matched_receipt_id       → receipt_vouchers
--   • matched_petty_cash_id    → petty_cash_transactions
--   • matched_fund_transfer_id → fund_transfers
--   • matched_entry_id         → journal_entries  (generic)
--   • matched_tax_payment_id   → tax_payments
--   • Any future typed FK column added to the table
--
-- The trigger runs AFTER the specialised triggers (auto_match_bank_statement_line,
-- auto_reconcile_tax_payment_from_bsl) because Postgres fires BEFORE triggers in
-- alphabetical order by trigger name. We name this trigger with a 'z_' prefix
-- so it runs last, acting as a safety net.
--
-- Idempotent. No schema changes. No data loss.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Universal status-sync trigger function
-- ============================================================================
CREATE OR REPLACE FUNCTION public.bsl_sync_reconciliation_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If ANY typed FK is set, the line is matched.
  -- If ALL typed FKs are NULL, the line is unmatched.
  -- We only act when the status would diverge from reality.

  IF (
    NEW.matched_expense_id       IS NOT NULL OR
    NEW.matched_receipt_id       IS NOT NULL OR
    NEW.matched_petty_cash_id    IS NOT NULL OR
    NEW.matched_fund_transfer_id IS NOT NULL OR
    NEW.matched_entry_id         IS NOT NULL OR
    NEW.matched_tax_payment_id   IS NOT NULL
  ) THEN
    -- At least one FK is set — ensure status reflects that
    IF NEW.reconciliation_status = 'unmatched' OR NEW.reconciliation_status IS NULL THEN
      NEW.reconciliation_status := 'matched';
    END IF;
  ELSE
    -- All FKs are NULL — reset to unmatched regardless of what the caller wrote
    NEW.reconciliation_status := 'unmatched';
    -- Clear matched_at so the timestamp doesn't mislead reconciliation reports
    NEW.matched_at := NULL;
  END IF;

  RETURN NEW;
END $$;

-- Drop first if exists (idempotent)
DROP TRIGGER IF EXISTS z_bsl_sync_reconciliation_status ON bank_statement_lines;

CREATE TRIGGER z_bsl_sync_reconciliation_status
  BEFORE UPDATE OF
    matched_expense_id,
    matched_receipt_id,
    matched_petty_cash_id,
    matched_fund_transfer_id,
    matched_entry_id,
    matched_tax_payment_id,
    reconciliation_status
  ON bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.bsl_sync_reconciliation_status();

-- ============================================================================
-- 2. Repair any currently orphaned rows (status='matched' but all FKs NULL)
--    These could exist from: ON DELETE SET NULL on a deleted document, or
--    from the old delete_expense_safe() which reset match_status (old col)
--    but not reconciliation_status.
-- ============================================================================
UPDATE bank_statement_lines
   SET reconciliation_status = 'unmatched',
       matched_at = NULL
 WHERE reconciliation_status IN ('matched', 'recorded', 'needs_review')
   AND matched_expense_id       IS NULL
   AND matched_receipt_id       IS NULL
   AND matched_petty_cash_id    IS NULL
   AND matched_fund_transfer_id IS NULL
   AND matched_entry_id         IS NULL
   AND matched_tax_payment_id   IS NULL;

-- ============================================================================
-- 3. Repair reverse orphans: all FKs set but status='unmatched'
--    Less common but possible if client wrote the FK without updating status.
-- ============================================================================
UPDATE bank_statement_lines
   SET reconciliation_status = 'matched'
 WHERE reconciliation_status = 'unmatched'
   AND (
     matched_expense_id       IS NOT NULL OR
     matched_receipt_id       IS NOT NULL OR
     matched_petty_cash_id    IS NOT NULL OR
     matched_fund_transfer_id IS NOT NULL OR
     matched_entry_id         IS NOT NULL OR
     matched_tax_payment_id   IS NOT NULL
   );

-- ============================================================================
-- 4. Also repair tax_payments.status inconsistencies.
--    If a tax_payment has a journal_entry_id but its BSL is now unmatched,
--    the payment should be 'posted' not 'reconciled'.
-- ============================================================================
UPDATE tax_payments tp
   SET status = 'posted', updated_at = now()
 WHERE tp.status = 'reconciled'
   AND NOT EXISTS (
     SELECT 1 FROM bank_statement_lines bsl
      WHERE bsl.matched_tax_payment_id = tp.id
        AND bsl.reconciliation_status IN ('matched', 'recorded')
   )
   AND NOT EXISTS (
     SELECT 1 FROM bank_reconciliation_items bri
      WHERE bri.journal_entry_id = tp.journal_entry_id
        AND bri.is_matched = true
   );

-- ============================================================================
-- 5. Notify PostgREST to refresh (idempotent; harmless if schema unchanged)
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
