/*
  # Fix auto_match_smart EXTRACT type error

  ## Problem
  The function uses EXTRACT(EPOCH FROM (date - date)) but in PostgreSQL,
  subtracting two date values returns an integer (number of days), not an interval.
  EXTRACT(EPOCH FROM integer) does not exist, causing the error:
  "function pg_catalog.extract(unknown, integer) does not exist"

  ## Fix
  Replace EXTRACT(EPOCH FROM ...) / 86400 with simple date arithmetic:
  (transaction_date::date - expense_date::date) which directly returns days as integer.
*/

DROP FUNCTION IF EXISTS auto_match_smart();

CREATE OR REPLACE FUNCTION auto_match_smart()
RETURNS TABLE(matched_count int, suggested_count int, skipped_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_matched_count int := 0;
  v_suggested_count int := 0;
  v_skipped_count int := 0;
  v_line record;
  v_expense record;
  v_best_match_id uuid;
  v_best_score numeric;
  v_amount numeric;
BEGIN
  FOR v_line IN 
    SELECT * FROM bank_statement_lines 
    WHERE reconciliation_status = 'unmatched'
      AND debit_amount > 0
      AND matched_expense_id IS NULL
      AND matched_receipt_id IS NULL
      AND matched_petty_cash_id IS NULL
      AND matched_entry_id IS NULL
      AND matched_fund_transfer_id IS NULL
    ORDER BY transaction_date DESC
  LOOP
    v_amount := v_line.debit_amount;
    v_best_match_id := NULL;
    v_best_score := 0;
    
    FOR v_expense IN 
      SELECT 
        fe.id,
        fe.amount,
        fe.expense_date,
        fe.bank_account_id,
        fe.expense_category,
        ABS(v_line.transaction_date::date - fe.expense_date::date) as date_diff_days,
        ABS(fe.amount - v_amount) as amount_diff,
        EXISTS (
          SELECT 1 FROM bank_statement_lines bsl 
          WHERE bsl.matched_expense_id = fe.id 
            AND bsl.id != v_line.id
        ) as already_matched
      FROM finance_expenses fe
      WHERE fe.paid_by = 'bank'
        AND ABS(fe.amount - v_amount) <= 10000
        AND ABS(v_line.transaction_date::date - fe.expense_date::date) <= 7
        AND (
          v_line.bank_account_id IS NULL 
          OR fe.bank_account_id IS NULL 
          OR v_line.bank_account_id = fe.bank_account_id
        )
      ORDER BY 
        ABS(fe.amount - v_amount),
        ABS(v_line.transaction_date::date - fe.expense_date::date)
      LIMIT 1
    LOOP
      IF v_expense.already_matched THEN
        v_skipped_count := v_skipped_count + 1;
        CONTINUE;
      END IF;
      
      v_best_score := 0;
      
      IF v_expense.amount_diff < 1 THEN
        v_best_score := v_best_score + 60;
      ELSIF v_expense.amount_diff <= 100 THEN
        v_best_score := v_best_score + 50;
      ELSIF v_expense.amount_diff <= 1000 THEN
        v_best_score := v_best_score + 35;
      ELSE
        v_best_score := v_best_score + 20;
      END IF;
      
      IF v_expense.date_diff_days = 0 THEN
        v_best_score := v_best_score + 30;
      ELSIF v_expense.date_diff_days <= 1 THEN
        v_best_score := v_best_score + 25;
      ELSIF v_expense.date_diff_days <= 3 THEN
        v_best_score := v_best_score + 15;
      ELSE
        v_best_score := v_best_score + 5;
      END IF;
      
      IF v_line.bank_account_id IS NOT NULL 
         AND v_expense.bank_account_id IS NOT NULL 
         AND v_line.bank_account_id = v_expense.bank_account_id THEN
        v_best_score := v_best_score + 10;
      END IF;
      
      v_best_match_id := v_expense.id;
    END LOOP;
    
    IF v_best_match_id IS NOT NULL AND v_best_score >= 70 THEN
      UPDATE bank_statement_lines
      SET 
        matched_expense_id = v_best_match_id,
        reconciliation_status = CASE 
          WHEN v_best_score >= 85 THEN 'matched'
          ELSE 'needs_review'
        END,
        matched_at = now(),
        matched_by = (select auth.uid()),
        notes = 'Auto-matched (confidence: ' || ROUND(v_best_score)::text || '%)'
      WHERE id = v_line.id;
      
      IF v_best_score >= 85 THEN
        v_matched_count := v_matched_count + 1;
      ELSE
        v_suggested_count := v_suggested_count + 1;
      END IF;
    END IF;
  END LOOP;
  
  RETURN QUERY SELECT v_matched_count, v_suggested_count, v_skipped_count;
END;
$$;
