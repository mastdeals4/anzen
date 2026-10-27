/*
  # Fix petty cash balance RPC and refresh PostgREST schema cache

  1. RPC
    - Ensure `public.get_petty_cash_balance_by_date(start_date date, end_date date)` exists.
    - Keep balance math consistent with `public.get_petty_cash_balance()` (no approval_status filter).

  2. Permissions
    - Grant execute to authenticated users.

  3. Cache refresh
    - Notify PostgREST to reload schema cache so `/rest/v1/rpc/get_petty_cash_balance_by_date` resolves immediately.
*/

CREATE OR REPLACE FUNCTION public.get_petty_cash_balance_by_date(start_date date, end_date date)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  total_withdrawals numeric := 0;
  total_expenses numeric := 0;
BEGIN
  SELECT COALESCE(SUM(amount), 0)
  INTO total_withdrawals
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'withdraw'
    AND transaction_date BETWEEN start_date AND end_date;

  SELECT COALESCE(SUM(amount), 0)
  INTO total_expenses
  FROM public.petty_cash_transactions
  WHERE transaction_type = 'expense'
    AND transaction_date BETWEEN start_date AND end_date;

  RETURN total_withdrawals - total_expenses;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_petty_cash_balance_by_date(date, date) TO authenticated;

COMMENT ON FUNCTION public.get_petty_cash_balance_by_date(date, date) IS
  'Calculates petty cash balance within a date range by summing withdrawals and subtracting expenses; consistent with get_petty_cash_balance().';

NOTIFY pgrst, 'reload schema';
