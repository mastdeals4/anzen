/*
  # Create get_overdue_balances function

  ## Summary
  Creates the `get_overdue_balances` RPC function used by the Dashboard to calculate
  the total outstanding balance for overdue invoices (past due_date, not fully paid).

  ## Details
  - Returns a set of rows with invoice_id and balance_due for each overdue invoice
  - Uses get_invoice_paid_amount to compute actual balance per invoice
  - Only includes invoices with payment_status in ('pending', 'partial') and due_date < today
*/

CREATE OR REPLACE FUNCTION public.get_overdue_balances()
RETURNS TABLE(invoice_id uuid, balance_due numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    si.id AS invoice_id,
    GREATEST(0, si.total_amount - COALESCE(public.get_invoice_paid_amount(si.id), 0)) AS balance_due
  FROM sales_invoices si
  WHERE si.payment_status IN ('pending', 'partial')
    AND si.due_date IS NOT NULL
    AND si.due_date < CURRENT_DATE;
$$;