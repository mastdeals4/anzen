/*
  # Invoice Payment Allocation System

  ## Summary
  This migration enhances the finance module to support split payments across multiple invoices
  and adds PO document tracking to invoices.

  ## Changes

  ### 1. Add customer_po_file_url to sales_invoices
  - Stores the URL of customer's purchase order document
  - Links sales orders PO documents to invoices for printing

  ### 2. Make invoice_id nullable in customer_payments
  - Allows payments to be recorded without immediate invoice linkage
  - Supports payment splitting across multiple invoices via new allocation table

  ### 3. Create invoice_payment_allocations table
  - Links payments to invoices with specific allocation amounts
  - Enables tracking which payment paid which invoice
  - Supports partial payments and split payments

  ### 4. Database Functions
  - `get_invoice_paid_amount(invoice_id)` - Calculate total paid for an invoice
  - `get_invoice_balance(invoice_id)` - Calculate remaining balance
  - `update_invoice_payment_status_from_allocation()` - Auto-update payment status

  ## Security
  - RLS enabled on new table
  - Policies restrict to authenticated users
  - Admin and accounts roles can manage allocations
*/

-- Add customer_po_file_url to sales_invoices
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales_invoices' AND column_name = 'customer_po_file_url'
  ) THEN
    ALTER TABLE sales_invoices ADD COLUMN customer_po_file_url text;
  END IF;
END $$;

-- Make invoice_id nullable in customer_payments (for unallocated payments)
ALTER TABLE customer_payments ALTER COLUMN invoice_id DROP NOT NULL;

-- Create invoice_payment_allocations table
CREATE TABLE IF NOT EXISTS invoice_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
  allocated_amount numeric(15,2) NOT NULL CHECK (allocated_amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  CONSTRAINT unique_invoice_payment UNIQUE (invoice_id, payment_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_invoice_payment_alloc_invoice ON invoice_payment_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_payment_alloc_payment ON invoice_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_due_date ON sales_invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_payment_status ON sales_invoices(payment_status);

-- Enable Row Level Security
ALTER TABLE invoice_payment_allocations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for invoice_payment_allocations
CREATE POLICY "Users can view invoice payment allocations"
  ON invoice_payment_allocations FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and accounts can insert invoice payment allocations"
  ON invoice_payment_allocations FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can update invoice payment allocations"
  ON invoice_payment_allocations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins can delete invoice payment allocations"
  ON invoice_payment_allocations FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Create function to calculate invoice paid amount
CREATE OR REPLACE FUNCTION get_invoice_paid_amount(p_invoice_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_paid_amount numeric;
BEGIN
  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_paid_amount
  FROM invoice_payment_allocations
  WHERE invoice_id = p_invoice_id;

  RETURN v_paid_amount;
END;
$$;

-- Create function to calculate invoice balance
CREATE OR REPLACE FUNCTION get_invoice_balance(p_invoice_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric;
  v_paid numeric;
BEGIN
  SELECT total_amount INTO v_total
  FROM sales_invoices
  WHERE id = p_invoice_id;

  v_paid := get_invoice_paid_amount(p_invoice_id);

  RETURN COALESCE(v_total, 0) - COALESCE(v_paid, 0);
END;
$$;

-- Drop old trigger that uses invoice_id directly
DROP TRIGGER IF EXISTS trigger_update_invoice_payment_status ON customer_payments;

-- Create new trigger function for allocation-based payment status
CREATE OR REPLACE FUNCTION update_invoice_payment_status_from_allocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_paid numeric;
  v_invoice_total numeric;
  v_invoice_id uuid;
BEGIN
  v_invoice_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- Calculate total paid for the invoice
  v_total_paid := get_invoice_paid_amount(v_invoice_id);

  -- Get invoice total
  SELECT total_amount INTO v_invoice_total
  FROM sales_invoices
  WHERE id = v_invoice_id;

  -- Update payment status based on paid amount
  IF v_total_paid = 0 THEN
    UPDATE sales_invoices
    SET payment_status = 'pending'
    WHERE id = v_invoice_id;
  ELSIF v_total_paid >= v_invoice_total THEN
    UPDATE sales_invoices
    SET payment_status = 'paid'
    WHERE id = v_invoice_id;
  ELSE
    UPDATE sales_invoices
    SET payment_status = 'partial'
    WHERE id = v_invoice_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create trigger on invoice_payment_allocations table
CREATE TRIGGER trigger_update_invoice_payment_status_from_allocation
  AFTER INSERT OR UPDATE OR DELETE ON invoice_payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION update_invoice_payment_status_from_allocation();

COMMENT ON TABLE invoice_payment_allocations IS 'Links customer payments to invoices with specific allocation amounts, supporting split payments across multiple invoices';
COMMENT ON FUNCTION get_invoice_paid_amount(uuid) IS 'Calculates the total amount paid for a specific invoice from all payment allocations';
COMMENT ON FUNCTION get_invoice_balance(uuid) IS 'Calculates the remaining balance for an invoice (total - paid)';