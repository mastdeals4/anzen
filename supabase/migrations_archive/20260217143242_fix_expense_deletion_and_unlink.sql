/*
  # Fix Expense Deletion and Unlinking from Bank Statements
  
  1. Problem
    - Deleting expenses fails with foreign key constraint error
    - Unlink button doesn't actually unlink expenses from bank statements
  
  2. Changes
    - Recreate foreign key constraint with proper ON DELETE SET NULL
    - Add RPC function to safely unlink expense from bank statement
    - Add RPC function to safely delete expense
  
  3. Security
    - Only authenticated users can use these functions
    - Proper validation and error handling
*/

-- Drop and recreate the foreign key constraint to ensure it's properly set
ALTER TABLE bank_statement_lines 
DROP CONSTRAINT IF EXISTS bank_statement_lines_matched_expense_id_fkey;

ALTER TABLE bank_statement_lines
ADD CONSTRAINT bank_statement_lines_matched_expense_id_fkey
FOREIGN KEY (matched_expense_id)
REFERENCES finance_expenses(id)
ON DELETE SET NULL;

-- Create RPC function to unlink expense from bank statement
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
    match_status = 'unmatched'
  WHERE id = p_bank_statement_line_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;
END;
$$;

-- Create RPC function to safely delete expense
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
      match_status = 'unmatched'
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

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION unlink_expense_from_bank_statement TO authenticated;
GRANT EXECUTE ON FUNCTION delete_expense_safe TO authenticated;
