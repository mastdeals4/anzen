/*
  # Add Expense Documents and Complete Finance Integration
  
  1. Changes
    - Add document_urls column to finance_expenses
    - Ensure customer_payments properly updates invoice payment_status
    - Ensure vendor_payments properly updates bill payment_status
  
  2. Security
    - Maintain existing RLS policies
*/

-- Add document URLs to finance_expenses
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'finance_expenses' AND column_name = 'document_urls'
  ) THEN
    ALTER TABLE finance_expenses ADD COLUMN document_urls text[];
  END IF;
END $$;

-- Ensure customer_payments trigger updates invoice status correctly
CREATE OR REPLACE FUNCTION update_invoice_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_total numeric;
  v_total_paid numeric;
BEGIN
  -- Get invoice total
  SELECT total_amount INTO v_invoice_total
  FROM sales_invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Calculate total paid for this invoice
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM customer_payments
  WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Update invoice payment status
  UPDATE sales_invoices
  SET payment_status = CASE
    WHEN v_total_paid >= v_invoice_total THEN 'paid'
    WHEN v_total_paid > 0 THEN 'partial'
    ELSE 'pending'
  END,
  updated_at = now()
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger for customer payments
DROP TRIGGER IF EXISTS trg_update_invoice_payment_status ON customer_payments;
CREATE TRIGGER trg_update_invoice_payment_status
AFTER INSERT OR UPDATE OR DELETE ON customer_payments
FOR EACH ROW
EXECUTE FUNCTION update_invoice_payment_status();

-- Ensure vendor_payments trigger updates bill status correctly
CREATE OR REPLACE FUNCTION update_vendor_bill_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_bill_total numeric;
  v_total_paid numeric;
BEGIN
  -- Get bill total
  SELECT total_amount INTO v_bill_total
  FROM vendor_bills
  WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);

  -- Calculate total paid for this bill
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM vendor_payments
  WHERE bill_id = COALESCE(NEW.bill_id, OLD.bill_id);

  -- Update bill payment status
  UPDATE vendor_bills
  SET payment_status = CASE
    WHEN v_total_paid >= v_bill_total THEN 'paid'
    WHEN v_total_paid > 0 THEN 'partial'
    ELSE 'pending'
  END,
  updated_at = now()
  WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger for vendor payments
DROP TRIGGER IF EXISTS trg_update_vendor_bill_payment_status ON vendor_payments;
CREATE TRIGGER trg_update_vendor_bill_payment_status
AFTER INSERT OR UPDATE OR DELETE ON vendor_payments
FOR EACH ROW
EXECUTE FUNCTION update_vendor_bill_payment_status();
