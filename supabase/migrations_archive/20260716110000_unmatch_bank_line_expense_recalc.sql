-- ============================================================================
-- P1-d: unmatch_bank_line — recompute expense paid state on unmatch
-- (2026-07-16, Expense/Payment evolution Phase 1)
-- ============================================================================
-- Gaps in the 20260703170000 version:
--   * Clearing matched_expense_id never recomputed
--     finance_expenses.paid_amount / pph_paid_amount, so an unmatched expense
--     kept looking paid. (The trg_bsl_recalc_expense_paid_state trigger from
--     20260716100000 now covers this at the row level; the explicit PERFORM
--     below is belt-and-braces so this function is correct even if applied
--     standalone.)
--
-- Deliberately UNCHANGED:
--   * matched_tax_payment_id is NOT added to the SET list. The BEFORE trigger
--     trg_auto_reconcile_tax_payment_from_bsl (20260713170000) owns that FK:
--     when this UPDATE flips reconciliation_status away from 'matched', the
--     trigger reverts the tax payment to 'posted' AND nulls the FK — but only
--     if the FK arrives UNCHANGED (its guard is
--     "NEW.matched_tax_payment_id IS NOT DISTINCT FROM OLD"). Clearing it
--     here would make NEW differ from OLD, defeat that guard, and strand the
--     tax payment in status 'reconciled' on an unmatched line.
--   * matched_entry_id lines that point at a payment voucher's journal entry:
--     unmatching only detaches the bank line; the voucher and its
--     allocations remain (the payment is still recorded, merely no longer
--     reconciled against the bank statement). That is intended.
--
-- Idempotent: CREATE OR REPLACE. No schema changes. Privileges are preserved
-- by OR REPLACE (role guard inside the body is the effective gate).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_role       text;
  v_expense_id uuid;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot unmatch bank lines', v_role;
  END IF;

  -- Capture before clearing so we can recompute the expense afterwards.
  SELECT matched_expense_id INTO v_expense_id
    FROM bank_statement_lines
   WHERE id = p_bank_line_id;

  UPDATE bank_statement_lines
  SET matched_expense_id = NULL, matched_receipt_id = NULL, matched_petty_cash_id = NULL,
      matched_fund_transfer_id = NULL, matched_entry_id = NULL, matching_status = 'none',
      reconciliation_status = 'unmatched', matched_at = NULL, matched_by = NULL, notes = NULL
  WHERE id = p_bank_line_id;

  -- Absolute recompute — idempotent even though the bank-line trigger
  -- already fired for this UPDATE.
  IF v_expense_id IS NOT NULL THEN
    PERFORM public.recalculate_expense_payment_state(v_expense_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'message', 'Match removed successfully');
END;
$$;

COMMIT;
