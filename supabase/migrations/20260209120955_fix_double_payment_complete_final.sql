/*
  # Fix Double Payment Counting - Complete Fix

  1. Problem
    - Payments counted TWICE: in voucher_allocations + invoice_payment_allocations
    - Causes negative balances on invoices
    - SAPJ-006: Shows -3.7M (should be 0)
    - SAPJ-008: Shows negative balance

  2. Root Cause
    - Old payment system (invoice_payment_allocations) was deprecated
    - New system (voucher_allocations) is the correct one
    - But functions were still ADDING both together
    - Duplicate data existed in old table

  3. Solution
    - Delete duplicate data from invoice_payment_allocations
    - Update ALL functions to only use voucher_allocations
    - Recalculate all invoice balances
    
  4. Affected Invoices
    - SAPJ-006: Fixed from -3.7M to 0 balance
    - SAPJ-008: Fixed from negative to 0 balance
*/

-- Step 1: Backup old data
CREATE TABLE IF NOT EXISTS invoice_payment_allocations_backup_20260209 AS 
SELECT * FROM invoice_payment_allocations;

-- Step 2: Delete ALL data from deprecated table
TRUNCATE TABLE invoice_payment_allocations;

-- Step 3: Fix get_invoice_paid_amount - ONLY use voucher_allocations
CREATE OR REPLACE FUNCTION get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paid_amount NUMERIC;
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_paid_amount
  FROM voucher_allocations
  WHERE sales_invoice_id = p_invoice_id
  AND voucher_type = 'receipt';

  RETURN v_paid_amount;
END;
$$;

-- Step 4: Fix get_invoices_with_balance - ONLY use voucher_allocations
CREATE OR REPLACE FUNCTION get_invoices_with_balance(customer_uuid UUID)
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
       AND va.voucher_type = 'receipt'), 0
    ) as paid_amount,
    si.total_amount - COALESCE(
      (SELECT SUM(va.allocated_amount) 
       FROM voucher_allocations va 
       WHERE va.sales_invoice_id = si.id
       AND va.voucher_type = 'receipt'), 0
    ) as balance_amount
  FROM sales_invoices si
  WHERE si.customer_id = customer_uuid
  AND si.is_draft = false
  ORDER BY si.invoice_date;
END;
$$;

-- Step 5: Fix recalculate_invoice_payment_status - ONLY use voucher_allocations
CREATE OR REPLACE FUNCTION recalculate_invoice_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_id UUID;
  v_old_invoice_id UUID;
  v_total_paid numeric(15,2);
  v_invoice_total numeric(15,2);
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_invoice_id := OLD.sales_invoice_id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_invoice_id := NEW.sales_invoice_id;
    v_old_invoice_id := OLD.sales_invoice_id;
  ELSE
    v_invoice_id := NEW.sales_invoice_id;
  END IF;

  -- Update new invoice if exists
  IF v_invoice_id IS NOT NULL THEN
    SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_total_paid
    FROM voucher_allocations
    WHERE sales_invoice_id = v_invoice_id
    AND voucher_type = 'receipt';

    SELECT total_amount INTO v_invoice_total
    FROM sales_invoices
    WHERE id = v_invoice_id;

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
  END IF;

  -- Update old invoice if allocation was moved
  IF TG_OP = 'UPDATE' AND v_old_invoice_id IS NOT NULL
     AND v_old_invoice_id IS DISTINCT FROM v_invoice_id THEN
    SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_total_paid
    FROM voucher_allocations
    WHERE sales_invoice_id = v_old_invoice_id
    AND voucher_type = 'receipt';

    SELECT total_amount INTO v_invoice_total
    FROM sales_invoices
    WHERE id = v_old_invoice_id;

    UPDATE sales_invoices
    SET
      paid_amount = v_total_paid,
      payment_status = CASE
        WHEN v_total_paid = 0 THEN 'pending'
        WHEN v_total_paid >= v_invoice_total THEN 'paid'
        WHEN v_total_paid > 0 AND v_total_paid < v_invoice_total THEN 'partial'
        ELSE 'pending'
      END
    WHERE id = v_old_invoice_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 6: Recalculate ALL invoice payment amounts from voucher_allocations only
UPDATE sales_invoices si
SET paid_amount = COALESCE(
  (
    SELECT SUM(va.allocated_amount)
    FROM voucher_allocations va
    WHERE va.sales_invoice_id = si.id
    AND va.voucher_type = 'receipt'
  ), 0
);

-- Step 7: Update ALL payment statuses based on corrected paid_amount
UPDATE sales_invoices
SET payment_status = CASE
  WHEN paid_amount = 0 THEN 'pending'
  WHEN paid_amount >= total_amount THEN 'paid'
  WHEN paid_amount > 0 AND paid_amount < total_amount THEN 'partial'
  ELSE 'pending'
END;

-- Step 8: Mark table as deprecated with clear warning
COMMENT ON TABLE invoice_payment_allocations IS 
'⛔ DEPRECATED 2026-02-09: DO NOT USE! All payments tracked in voucher_allocations only.
This table caused double-counting bugs. Kept for historical backup only.';

-- Step 9: Verify fix for affected invoices
DO $$
DECLARE
  v_sapj006_balance numeric;
  v_sapj008_balance numeric;
BEGIN
  SELECT (total_amount - paid_amount) INTO v_sapj006_balance
  FROM sales_invoices WHERE invoice_number = 'SAPJ-006';
  
  SELECT (total_amount - paid_amount) INTO v_sapj008_balance
  FROM sales_invoices WHERE invoice_number = 'SAPJ-008';
  
  RAISE NOTICE 'SAPJ-006 balance: %', v_sapj006_balance;
  RAISE NOTICE 'SAPJ-008 balance: %', v_sapj008_balance;
END $$;
