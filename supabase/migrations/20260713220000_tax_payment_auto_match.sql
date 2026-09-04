-- ============================================================================
-- Extend auto_match_smart to include tax_payments
-- ============================================================================
-- The original function only matches BSL rows against finance_expenses.
-- Tax payments create JEs via record_tax_payment() and set status='posted'.
-- This migration adds a second pass that matches unmatched BSL debit rows
-- against tax_payments, completing the bank-rec loop for tax.
--
-- Matching criteria (mirrors expense pass):
--   bank_account_id must match (both sides must have one set)
--   ABS(amount - debit_amount) < 1 Rp (exact, tax payments are exact)
--   date within ±5 days
--   tax_payment not already linked to a BSL
--
-- On match:
--   matched_tax_payment_id = tax_payment.id        (typed FK)
--   matched_entry_id       = tax_payment.journal_entry_id  (canonical FK)
--   reconciliation_status  = 'matched' (exact) | 'needs_review' (date gap)
--   The BEFORE UPDATE trigger auto_reconcile_tax_payment_from_bsl then fires
--   and sets tax_payments.status = 'reconciled'.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer, suggested_count integer, skipped_count integer)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_matched_count   int := 0;
  v_suggested_count int := 0;
  v_skipped_count   int := 0;
  v_line            record;
  v_expense         record;
  v_tp              record;
  v_best_match_id   uuid;
  v_best_je_id      uuid;
  v_best_score      numeric;
  v_amount          numeric;
  v_role            text;
BEGIN
  SELECT role INTO v_role FROM user_profiles WHERE id = auth.uid();
  IF v_role NOT IN ('admin','accounts') THEN
    RAISE EXCEPTION 'Permission denied: role % cannot run auto-match', v_role;
  END IF;

  -- ── Pass 1: match against finance_expenses (unchanged) ────────────────────
  FOR v_line IN
    SELECT * FROM bank_statement_lines
    WHERE reconciliation_status = 'unmatched' AND debit_amount > 0
      AND matched_expense_id IS NULL AND matched_receipt_id IS NULL
      AND matched_petty_cash_id IS NULL AND matched_entry_id IS NULL
      AND matched_fund_transfer_id IS NULL AND matched_tax_payment_id IS NULL
    ORDER BY transaction_date DESC
  LOOP
    v_amount := v_line.debit_amount;
    v_best_match_id := NULL;
    v_best_score := 0;

    FOR v_expense IN
      SELECT fe.id, fe.amount, fe.expense_date, fe.bank_account_id, fe.expense_category,
             ABS(v_line.transaction_date::date - fe.expense_date::date) AS date_diff_days,
             ABS(fe.amount - v_amount) AS amount_diff,
             EXISTS (SELECT 1 FROM bank_statement_lines bsl
                     WHERE bsl.matched_expense_id = fe.id AND bsl.id != v_line.id) AS already_matched
      FROM finance_expenses fe
      WHERE fe.paid_by = 'bank' AND ABS(fe.amount - v_amount) <= 10000
        AND ABS(v_line.transaction_date::date - fe.expense_date::date) <= 7
        AND (v_line.bank_account_id IS NULL OR fe.bank_account_id IS NULL
             OR v_line.bank_account_id = fe.bank_account_id)
      ORDER BY ABS(fe.amount - v_amount), ABS(v_line.transaction_date::date - fe.expense_date::date)
      LIMIT 1
    LOOP
      IF v_expense.already_matched THEN v_skipped_count := v_skipped_count + 1; CONTINUE; END IF;
      v_best_score := 0;
      IF    v_expense.amount_diff < 1     THEN v_best_score := v_best_score + 60;
      ELSIF v_expense.amount_diff <= 100  THEN v_best_score := v_best_score + 50;
      ELSIF v_expense.amount_diff <= 1000 THEN v_best_score := v_best_score + 35;
      ELSE                                     v_best_score := v_best_score + 20; END IF;
      IF    v_expense.date_diff_days = 0  THEN v_best_score := v_best_score + 30;
      ELSIF v_expense.date_diff_days <= 1 THEN v_best_score := v_best_score + 25;
      ELSIF v_expense.date_diff_days <= 3 THEN v_best_score := v_best_score + 15;
      ELSE                                     v_best_score := v_best_score + 5;  END IF;
      IF v_line.bank_account_id IS NOT NULL AND v_expense.bank_account_id IS NOT NULL
         AND v_line.bank_account_id = v_expense.bank_account_id THEN
        v_best_score := v_best_score + 10;
      END IF;
      v_best_match_id := v_expense.id;
    END LOOP;

    IF v_best_match_id IS NOT NULL AND v_best_score >= 70 THEN
      UPDATE bank_statement_lines
      SET matched_expense_id    = v_best_match_id,
          reconciliation_status = CASE WHEN v_best_score >= 85 THEN 'matched' ELSE 'needs_review' END,
          matched_at            = now(),
          matched_by            = auth.uid(),
          notes                 = 'Auto-matched (confidence: ' || ROUND(v_best_score)::text || '%)'
      WHERE id = v_line.id;
      IF v_best_score >= 85 THEN v_matched_count  := v_matched_count  + 1;
      ELSE                       v_suggested_count := v_suggested_count + 1; END IF;
    END IF;
  END LOOP;

  -- ── Pass 2: match remaining unmatched rows against tax_payments ───────────
  -- Tax payments are always exact-amount bank debits; date tolerance is ±5 days.
  -- Requires both sides to have a bank_account_id for precision.
  FOR v_line IN
    SELECT * FROM bank_statement_lines
    WHERE reconciliation_status = 'unmatched' AND debit_amount > 0
      AND matched_expense_id IS NULL AND matched_receipt_id IS NULL
      AND matched_petty_cash_id IS NULL AND matched_entry_id IS NULL
      AND matched_fund_transfer_id IS NULL AND matched_tax_payment_id IS NULL
      AND bank_account_id IS NOT NULL
    ORDER BY transaction_date DESC
  LOOP
    v_amount := v_line.debit_amount;
    v_best_match_id := NULL;
    v_best_je_id    := NULL;
    v_best_score    := 0;

    FOR v_tp IN
      SELECT tp.id, tp.amount, tp.payment_date, tp.bank_account_id, tp.journal_entry_id,
             tp.tax_type,
             ABS(v_line.transaction_date::date - tp.payment_date::date) AS date_diff_days,
             ABS(tp.amount - v_amount) AS amount_diff,
             EXISTS (SELECT 1 FROM bank_statement_lines bsl
                     WHERE bsl.matched_tax_payment_id = tp.id AND bsl.id != v_line.id) AS already_matched
      FROM tax_payments tp
      WHERE tp.status IN ('posted', 'draft')
        AND tp.bank_account_id = v_line.bank_account_id
        AND tp.journal_entry_id IS NOT NULL
        AND ABS(tp.amount - v_amount) < 1        -- tax payments must be exact
        AND ABS(v_line.transaction_date::date - tp.payment_date::date) <= 5
      ORDER BY ABS(tp.amount - v_amount), ABS(v_line.transaction_date::date - tp.payment_date::date)
      LIMIT 1
    LOOP
      IF v_tp.already_matched THEN v_skipped_count := v_skipped_count + 1; CONTINUE; END IF;

      v_best_score := 60; -- exact amount (< 1 Rp)
      IF    v_tp.date_diff_days = 0  THEN v_best_score := v_best_score + 30;
      ELSIF v_tp.date_diff_days <= 1 THEN v_best_score := v_best_score + 25;
      ELSIF v_tp.date_diff_days <= 3 THEN v_best_score := v_best_score + 15;
      ELSE                                v_best_score := v_best_score + 5;  END IF;
      -- bank_account already required to match; add certainty bonus
      v_best_score    := v_best_score + 10;
      v_best_match_id := v_tp.id;
      v_best_je_id    := v_tp.journal_entry_id;
    END LOOP;

    IF v_best_match_id IS NOT NULL AND v_best_score >= 70 THEN
      UPDATE bank_statement_lines
      SET matched_tax_payment_id = v_best_match_id,
          matched_entry_id       = v_best_je_id,
          reconciliation_status  = CASE WHEN v_best_score >= 85 THEN 'matched' ELSE 'needs_review' END,
          matched_at             = now(),
          matched_by             = auth.uid(),
          notes                  = 'Auto-matched tax payment (confidence: ' || ROUND(v_best_score)::text || '%)'
      WHERE id = v_line.id;
      -- The BEFORE UPDATE trigger auto_reconcile_tax_payment_from_bsl fires here
      -- and flips tax_payments.status to 'reconciled'.
      IF v_best_score >= 85 THEN v_matched_count  := v_matched_count  + 1;
      ELSE                       v_suggested_count := v_suggested_count + 1; END IF;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_matched_count, v_suggested_count, v_skipped_count;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
