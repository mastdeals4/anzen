/*
  # Add function to get latest payment receipt date for invoices
  
  1. New Function
    - `get_invoice_latest_payment_date(p_invoice_id uuid)` - Returns the latest payment/receipt date for an invoice
    - Joins invoice_payment_allocations with receipt_vouchers to get the most recent payment date
    - Returns NULL if no payments have been made
  
  2. Purpose
    - Used in Sales Register to display when a payment was last received
    - Helps track payment history for each invoice
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
  FROM invoice_payment_allocations ipa
  JOIN receipt_vouchers rv ON rv.id = ipa.payment_id
  WHERE ipa.invoice_id = p_invoice_id;
  
  RETURN v_latest_date;
END;
$$;
