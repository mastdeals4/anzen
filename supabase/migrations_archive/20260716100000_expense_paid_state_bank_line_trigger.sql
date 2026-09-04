-- ============================================================================
-- P1-b: keep finance_expenses.paid_amount consistent with bank matches
-- (2026-07-16, Expense/Payment evolution Phase 1)
-- ============================================================================
-- Problem:
--   recalculate_expense_payment_state() (20260703120000) derives
--   paid_amount / pph_paid_amount from TWO sources:
--     1. voucher_allocations(finance_expense_id)  — covered by
--        trg_sync_expense_payment_state on voucher_allocations
--     2. bank_statement_lines(matched_expense_id) — covered by NOTHING at the
--        DB level. Only the client (BankReconciliationEnhanced) remembers to
--        call the recompute after linking. Any other path that sets/clears
--        matched_expense_id (unmatch_bank_line, ON DELETE SET NULL when a
--        statement import is deleted, manual SQL, future code) leaves
--        paid_amount stale.
--
-- Fix: AFTER trigger on bank_statement_lines that recomputes the affected
-- expense(s) whenever matched_expense_id, payment_kind, or the line amounts
-- change. AFTER timing so the recompute's own SELECTs on
-- bank_statement_lines see the new row state.
--
-- Safe by construction:
--   * recalculate_expense_payment_state only UPDATEs finance_expenses —
--     it never writes bank_statement_lines or voucher_allocations, so no
--     trigger recursion.
--   * Recompute is absolute (SUM from scratch), so double-firing (e.g. the
--     client still calling the RPC after linking) is idempotent, never
--     double-counts.
--   * If the expense row is gone (FK ON DELETE SET NULL during expense
--     delete), the recompute's UPDATE matches zero rows — a no-op.
--
-- Idempotent: CREATE OR REPLACE + DROP TRIGGER IF EXISTS. No schema changes.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.bsl_recalc_expense_paid_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: recompute every expense whose derived total could have moved.
  IF NEW.matched_expense_id IS DISTINCT FROM OLD.matched_expense_id THEN
    IF OLD.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(OLD.matched_expense_id);
    END IF;
    IF NEW.matched_expense_id IS NOT NULL THEN
      PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
    END IF;
  ELSIF NEW.matched_expense_id IS NOT NULL
    AND (   NEW.payment_kind  IS DISTINCT FROM OLD.payment_kind
         OR NEW.debit_amount  IS DISTINCT FROM OLD.debit_amount
         OR NEW.credit_amount IS DISTINCT FROM OLD.credit_amount) THEN
    PERFORM public.recalculate_expense_payment_state(NEW.matched_expense_id);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bsl_recalc_expense_paid_state ON bank_statement_lines;

CREATE TRIGGER trg_bsl_recalc_expense_paid_state
  AFTER INSERT OR UPDATE OR DELETE
  ON bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.bsl_recalc_expense_paid_state();

-- ============================================================================
-- One-time repair: recompute every expense that has (or ever had) a payment
-- source, so rows that went stale before this trigger existed become
-- consistent. Absolute recompute — safe to re-run.
-- ============================================================================
DO $$
DECLARE
  v_id uuid;
  v_count int := 0;
BEGIN
  FOR v_id IN
    SELECT DISTINCT matched_expense_id
      FROM bank_statement_lines
     WHERE matched_expense_id IS NOT NULL
    UNION
    SELECT DISTINCT finance_expense_id
      FROM voucher_allocations
     WHERE finance_expense_id IS NOT NULL
    UNION
    -- expenses claiming payment with no surviving source (orphaned paid_amount)
    SELECT id
      FROM finance_expenses
     WHERE COALESCE(paid_amount, 0) <> 0
        OR COALESCE(pph_paid_amount, 0) <> 0
  LOOP
    PERFORM public.recalculate_expense_payment_state(v_id);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'bsl_recalc_expense_paid_state: repaired % expense rows', v_count;
END $$;

COMMIT;
