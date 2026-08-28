/*
  # Fix Expense Unlink RPC - Use Correct Column Names
  
  1. Problem
    - RPC functions were using incorrect column name 'match_status'
    - Correct column name is 'reconciliation_status'
  
  2. Changes
    - Update unlink_expense_from_bank_statement to use reconciliation_status
    - Update delete_expense_safe to use reconciliation_status
*/

-- Fix the unlink function to use correct column name
CREATE OR REPLACE FUNCTION unlink_expense_from_bank_statement(
  p_bank_statement_line_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update the bank statement line to remove the expense link
  UPDATE bank_statement_lines
  SET 
    matched_expense_id = NULL,
    reconciliation_status = 'unmatched',
    matched_at = NULL,
    matched_by = NULL,
    notes = NULL
  WHERE id = p_bank_statement_line_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;
END;
$$;

-- Fix the delete function to use correct column name
CREATE OR REPLACE FUNCTION delete_expense_safe(
  p_expense_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_linked_count int;
BEGIN
  -- Check how many bank statement lines are linked to this expense
  SELECT COUNT(*)
  INTO v_linked_count
  FROM bank_statement_lines
  WHERE matched_expense_id = p_expense_id;
  
  -- If there are linked statements, unlink them first
  IF v_linked_count > 0 THEN
    UPDATE bank_statement_lines
    SET 
      matched_expense_id = NULL,
      reconciliation_status = 'unmatched',
      matched_at = NULL,
      matched_by = NULL,
      notes = NULL
    WHERE matched_expense_id = p_expense_id;
  END IF;
  
  -- Now delete the expense
  DELETE FROM finance_expenses
  WHERE id = p_expense_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  
  RETURN jsonb_build_object(
    'success', true,
    'unlinked_statements', v_linked_count
  );
END;
$$;
