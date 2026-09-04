/*
  # Create Petty Cash Balance by Date Function

  1. New Function
    - `get_petty_cash_balance_by_date(start_date, end_date)` - Calculates petty cash balance within a date range

  2. Logic
    - Sum withdrawals between start and end date
    - Subtract expenses between start and end date
    - Returns balance for the selected period

  3. Security
    - SECURITY DEFINER to allow access
    - Returns numeric value
*/

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_date(start_date date, end_date date)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total_withdrawals numeric := 0;
  total_expenses numeric := 0;
BEGIN
  SELECT COALESCE(SUM(amount), 0)
  INTO total_withdrawals
  FROM petty_cash_transactions
  WHERE transaction_type = 'withdraw'
    AND transaction_date >= start_date
    AND transaction_date <= end_date;

  SELECT COALESCE(SUM(amount), 0)
  INTO total_expenses
  FROM petty_cash_transactions
  WHERE transaction_type = 'expense'
    AND transaction_date >= start_date
    AND transaction_date <= end_date;

  RETURN total_withdrawals - total_expenses;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) TO authenticated;

COMMENT ON FUNCTION public.get_petty_cash_balance_by_date(date, date) IS
  'Calculates petty cash balance within the provided date range by summing withdrawals and subtracting expenses';
