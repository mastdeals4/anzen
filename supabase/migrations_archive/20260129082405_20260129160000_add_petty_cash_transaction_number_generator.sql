/*
  # Add Auto-Generated Transaction Number for Petty Cash

  1. Changes
    - Create sequence for petty cash transaction numbers
    - Add trigger to auto-generate transaction_number before insert
    - Format: PC-YYYYMM-001 (e.g., PC-202601-001)
  
  2. Security
    - Only affects transaction_number generation
    - Does not change RLS policies
*/

-- Create sequence for petty cash transaction numbers
CREATE SEQUENCE IF NOT EXISTS petty_cash_transaction_number_seq;

-- Function to generate transaction number
CREATE OR REPLACE FUNCTION generate_petty_cash_transaction_number()
RETURNS TRIGGER AS $$
DECLARE
  v_year_month TEXT;
  v_next_num INTEGER;
  v_transaction_number TEXT;
BEGIN
  -- Only generate if transaction_number is not already set
  IF NEW.transaction_number IS NULL OR NEW.transaction_number = '' THEN
    -- Get year and month from transaction date
    v_year_month := TO_CHAR(NEW.transaction_date, 'YYYYMM');
    
    -- Get the next number for this month
    SELECT COALESCE(MAX(CAST(SUBSTRING(transaction_number FROM 'PC-\d{6}-(\d+)') AS INTEGER)), 0) + 1
    INTO v_next_num
    FROM petty_cash_transactions
    WHERE transaction_number LIKE 'PC-' || v_year_month || '-%';
    
    -- If no number found, start at 1
    IF v_next_num IS NULL THEN
      v_next_num := 1;
    END IF;
    
    -- Generate the transaction number
    v_transaction_number := 'PC-' || v_year_month || '-' || LPAD(v_next_num::TEXT, 3, '0');
    
    NEW.transaction_number := v_transaction_number;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-generate transaction number
DROP TRIGGER IF EXISTS trigger_generate_petty_cash_transaction_number ON petty_cash_transactions;
CREATE TRIGGER trigger_generate_petty_cash_transaction_number
  BEFORE INSERT ON petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION generate_petty_cash_transaction_number();

-- Add comment
COMMENT ON FUNCTION generate_petty_cash_transaction_number() IS 
'Auto-generates transaction number in format PC-YYYYMM-001 for petty cash transactions';
