/*
  # Fix get_invoices_with_balance to exclude current voucher when editing

  When editing a receipt voucher, the balance calculation was including
  the current voucher's own allocations, making the balance appear near zero.
  This prevented users from re-entering the full allocation amount.

  Fix: Add optional `exclude_voucher_uuid` parameter so that when editing,
  the current voucher's allocations are excluded from the paid_amount calculation,
  showing the true available balance.
*/

CREATE OR REPLACE FUNCTION get_invoices_with_balance(
  customer_uuid UUID,
  exclude_voucher_uuid UUID DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  invoice_number TEXT,
  invoice_date DATE,
  total_amount NUMERIC,
  paid_amount NUMERIC,
  balance_amount NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    si.id,
    si.invoice_number,
    si.invoice_date,
    si.total_amount,
    COALESCE(
      (SELECT SUM(va.allocated_amount) 
       FROM voucher_allocations va 
       WHERE va.sales_invoice_id = si.id
       AND va.voucher_type = 'receipt'
       AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id != exclude_voucher_uuid)), 0
    ) as paid_amount,
    si.total_amount - COALESCE(
      (SELECT SUM(va.allocated_amount) 
       FROM voucher_allocations va 
       WHERE va.sales_invoice_id = si.id
       AND va.voucher_type = 'receipt'
       AND (exclude_voucher_uuid IS NULL OR va.receipt_voucher_id != exclude_voucher_uuid)), 0
    ) as balance_amount
  FROM sales_invoices si
  WHERE si.customer_id = customer_uuid
  AND si.is_draft = false
  ORDER BY si.invoice_date;
END;
$$;
