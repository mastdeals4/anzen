/*
  # Fix Sales Invoice Payment Tracking

  1. Problem
    - ReceiptVoucherManager.tsx attempts to update `paid_amount` and `balance_amount` columns on sales_invoices
    - These columns DO NOT EXIST in the current schema
    - This causes receipt voucher allocation to fail with database errors

  2. Solution
    - Add `paid_amount` and `balance_amount` columns to sales_invoices table
    - Backfill current values from voucher_allocations and invoice_payment_allocations
    - Create triggers to auto-update these columns when payments are allocated/deallocated
    - This enables proper payment tracking and status updates

  3. Changes
    - Add paid_amount column (tracks total payments received)
    - Add balance_amount column (tracks remaining balance as computed column)
    - Create trigger to auto-update on voucher allocation changes
    - Create trigger to auto-update on invoice payment allocation changes
    - Backfill existing data
*/

-- Step 1: Add columns to sales_invoices table
ALTER TABLE sales_invoices
ADD COLUMN IF NOT EXISTS paid_amount numeric(15,2) DEFAULT 0 NOT NULL,
ADD COLUMN IF NOT EXISTS balance_amount numeric(15,2) GENERATED ALWAYS AS (total_amount - paid_amount) STORED;

-- Step 2: Backfill paid_amount from existing voucher_allocations
UPDATE sales_invoices si
SET paid_amount = COALESCE(
  (
    SELECT SUM(va.allocated_amount)
    FROM voucher_allocations va
    WHERE va.sales_invoice_id = si.id
    AND va.voucher_type = 'receipt'
  ), 0
) + COALESCE(
  (
    SELECT SUM(ipa.allocated_amount)
    FROM invoice_payment_allocations ipa
    WHERE ipa.invoice_id = si.id
  ), 0
);

-- Step 3: Update payment_status based on paid_amount
UPDATE sales_invoices
SET payment_status = CASE
  WHEN paid_amount = 0 THEN 'pending'
  WHEN paid_amount >= total_amount THEN 'paid'
  WHEN paid_amount > 0 AND paid_amount < total_amount THEN 'partial'
  ELSE 'pending'
END;

-- Step 4: Create function to recalculate invoice payment status
CREATE OR REPLACE FUNCTION recalculate_invoice_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_id UUID;
  v_total_paid numeric(15,2);
  v_invoice_total numeric(15,2);
BEGIN
  -- Determine which invoice to update
  IF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.sales_invoice_id;
  ELSE
    v_invoice_id := NEW.sales_invoice_id;
  END IF;

  -- Only proceed if this is for a sales invoice
  IF v_invoice_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Calculate total paid from voucher_allocations
  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total_paid
  FROM voucher_allocations
  WHERE sales_invoice_id = v_invoice_id
  AND voucher_type = 'receipt';

  -- Add payments from invoice_payment_allocations
  v_total_paid := v_total_paid + COALESCE(
    (SELECT SUM(allocated_amount)
     FROM invoice_payment_allocations
     WHERE invoice_id = v_invoice_id), 0
  );

  -- Get invoice total
  SELECT total_amount INTO v_invoice_total
  FROM sales_invoices
  WHERE id = v_invoice_id;

  -- Update the invoice
  UPDATE sales_invoices
  SET
    paid_amount = v_total_paid,
    payment_status = CASE
      WHEN v_total_paid = 0 THEN 'pending'
      WHEN v_total_paid >= v_invoice_total THEN 'paid'
      WHEN v_total_paid > 0 AND v_total_paid < v_invoice_total THEN 'partial'
      ELSE 'pending'
    END
  WHERE id = v_invoice_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 5: Create trigger on voucher_allocations
DROP TRIGGER IF EXISTS trg_update_invoice_payment_status ON voucher_allocations;
CREATE TRIGGER trg_update_invoice_payment_status
  AFTER INSERT OR UPDATE OR DELETE ON voucher_allocations
  FOR EACH ROW
  EXECUTE FUNCTION recalculate_invoice_payment_status();

-- Step 6: Create function for invoice_payment_allocations trigger
CREATE OR REPLACE FUNCTION recalculate_invoice_payment_from_allocations()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_id UUID;
  v_total_paid numeric(15,2);
  v_invoice_total numeric(15,2);
BEGIN
  -- Determine which invoice to update
  IF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.invoice_id;
  ELSE
    v_invoice_id := NEW.invoice_id;
  END IF;

  -- Only proceed if we have an invoice_id
  IF v_invoice_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Calculate total paid from invoice_payment_allocations
  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total_paid
  FROM invoice_payment_allocations
  WHERE invoice_id = v_invoice_id;

  -- Add payments from voucher_allocations
  v_total_paid := v_total_paid + COALESCE(
    (SELECT SUM(allocated_amount)
     FROM voucher_allocations
     WHERE sales_invoice_id = v_invoice_id
     AND voucher_type = 'receipt'), 0
  );

  -- Get invoice total
  SELECT total_amount INTO v_invoice_total
  FROM sales_invoices
  WHERE id = v_invoice_id;

  -- Update the invoice
  UPDATE sales_invoices
  SET
    paid_amount = v_total_paid,
    payment_status = CASE
      WHEN v_total_paid = 0 THEN 'pending'
      WHEN v_total_paid >= v_invoice_total THEN 'paid'
      WHEN v_total_paid > 0 AND v_total_paid < v_invoice_total THEN 'partial'
      ELSE 'pending'
    END
  WHERE id = v_invoice_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 7: Create trigger on invoice_payment_allocations
DROP TRIGGER IF EXISTS trg_update_invoice_payment_from_allocations ON invoice_payment_allocations;
CREATE TRIGGER trg_update_invoice_payment_from_allocations
  AFTER INSERT OR UPDATE OR DELETE ON invoice_payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION recalculate_invoice_payment_from_allocations();

-- Step 8: Add comments
COMMENT ON COLUMN sales_invoices.paid_amount IS 'Total amount paid towards this invoice from all payment sources';
COMMENT ON COLUMN sales_invoices.balance_amount IS 'Remaining balance (computed as total_amount - paid_amount)';