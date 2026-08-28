/*
  # Fix get_invoice_latest_payment_date to use voucher_allocations
  
  1. Changes
    - Update function to query voucher_allocations instead of invoice_payment_allocations
    - Join with receipt_vouchers using receipt_voucher_id field
    - This fixes the blank Payment Receipt column in Sales Register report
  
  2. Technical Details
    - The system uses voucher_allocations table (which has data)
    - NOT invoice_payment_allocations table (which is empty)
    - Function now correctly returns the latest payment date for invoices
*/

CREATE OR REPLACE FUNCTION get_invoice_latest_payment_date(p_invoice_id uuid)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest_date date;
BEGIN
  SELECT MAX(rv.voucher_date)
  INTO v_latest_date
  FROM voucher_allocations va
  JOIN receipt_vouchers rv ON rv.id = va.receipt_voucher_id
  WHERE va.sales_invoice_id = p_invoice_id
    AND va.voucher_type = 'receipt';
  
  RETURN v_latest_date;
END;
$$;
