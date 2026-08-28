/*
  # Expand Finance Module - Accounts & Payments

  ## Summary
  This migration adds comprehensive financial management capabilities to track payments,
  bank accounts, and provide detailed financial reporting.

  ## New Tables

  ### 1. `bank_accounts`
  - `id` (uuid, primary key)
  - `account_name` (text) - Name of the bank account
  - `bank_name` (text) - Name of the bank
  - `account_number` (text) - Bank account number
  - `account_type` (text) - savings, current, credit_card
  - `currency` (text) - IDR, USD, etc.
  - `opening_balance` (numeric) - Starting balance
  - `current_balance` (numeric) - Current balance
  - `is_active` (boolean)
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 2. `customer_payments`
  - `id` (uuid, primary key)
  - `payment_number` (text, unique) - Payment reference number
  - `customer_id` (uuid) - Foreign key to customers
  - `invoice_id` (uuid) - Foreign key to sales_invoices
  - `payment_date` (date)
  - `amount` (numeric) - Payment amount
  - `payment_method` (text) - cash, bank_transfer, cheque, etc.
  - `bank_account_id` (uuid) - Foreign key to bank_accounts
  - `reference_number` (text) - Bank reference or cheque number
  - `notes` (text)
  - `created_by` (uuid)
  - `created_at` (timestamptz)

  ### 3. `vendor_bills`
  - `id` (uuid, primary key)
  - `bill_number` (text, unique)
  - `vendor_name` (text)
  - `vendor_id` (text) - Vendor tax ID or reference
  - `bill_date` (date)
  - `due_date` (date)
  - `amount` (numeric)
  - `tax_amount` (numeric)
  - `total_amount` (numeric)
  - `payment_status` (text) - pending, partial, paid
  - `category` (text) - inventory, expense, asset
  - `description` (text)
  - `created_by` (uuid)
  - `created_at` (timestamptz)

  ### 4. `vendor_payments`
  - `id` (uuid, primary key)
  - `payment_number` (text, unique)
  - `bill_id` (uuid) - Foreign key to vendor_bills
  - `payment_date` (date)
  - `amount` (numeric)
  - `payment_method` (text)
  - `bank_account_id` (uuid)
  - `reference_number` (text)
  - `notes` (text)
  - `created_by` (uuid)
  - `created_at` (timestamptz)

  ## Security
  - Enable RLS on all tables
  - Policies for authenticated users based on roles (admin, accounts)

  ## Important Notes
  - All monetary amounts in IDR unless specified
  - Payment methods: cash, bank_transfer, cheque, credit_card, other
  - Payment status tracks: pending, partial, paid
*/

-- Create bank_accounts table
CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name text NOT NULL,
  bank_name text NOT NULL,
  account_number text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('savings', 'current', 'credit_card', 'other')),
  currency text NOT NULL DEFAULT 'IDR',
  opening_balance numeric NOT NULL DEFAULT 0,
  current_balance numeric NOT NULL DEFAULT 0,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create customer_payments table
CREATE TABLE IF NOT EXISTS customer_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque', 'credit_card', 'other')),
  bank_account_id uuid REFERENCES bank_accounts(id),
  reference_number text,
  notes text,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

-- Create vendor_bills table
CREATE TABLE IF NOT EXISTS vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number text UNIQUE NOT NULL,
  vendor_name text NOT NULL,
  vendor_id text,
  bill_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  amount numeric NOT NULL DEFAULT 0,
  tax_amount numeric DEFAULT 0,
  total_amount numeric NOT NULL DEFAULT 0,
  payment_status text DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid')),
  category text CHECK (category IN ('inventory', 'expense', 'asset', 'other')),
  description text,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create vendor_payments table
CREATE TABLE IF NOT EXISTS vendor_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number text UNIQUE NOT NULL,
  bill_id uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque', 'credit_card', 'other')),
  bank_account_id uuid REFERENCES bank_accounts(id),
  reference_number text,
  notes text,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_customer_payments_customer ON customer_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_invoice ON customer_payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_date ON customer_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_bill ON vendor_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_vendor_bills_status ON vendor_bills(payment_status);
CREATE INDEX IF NOT EXISTS idx_vendor_bills_date ON vendor_bills(bill_date);

-- Enable Row Level Security
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_payments ENABLE ROW LEVEL SECURITY;

-- RLS Policies for bank_accounts
CREATE POLICY "Admins and accounts can view bank accounts"
  ON bank_accounts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can insert bank accounts"
  ON bank_accounts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can update bank accounts"
  ON bank_accounts FOR UPDATE
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

CREATE POLICY "Admins can delete bank accounts"
  ON bank_accounts FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- RLS Policies for customer_payments
CREATE POLICY "Authenticated users can view customer payments"
  ON customer_payments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and accounts can insert customer payments"
  ON customer_payments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can update customer payments"
  ON customer_payments FOR UPDATE
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

CREATE POLICY "Admins can delete customer payments"
  ON customer_payments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- RLS Policies for vendor_bills
CREATE POLICY "Authenticated users can view vendor bills"
  ON vendor_bills FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and accounts can insert vendor bills"
  ON vendor_bills FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can update vendor bills"
  ON vendor_bills FOR UPDATE
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

CREATE POLICY "Admins can delete vendor bills"
  ON vendor_bills FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- RLS Policies for vendor_payments
CREATE POLICY "Authenticated users can view vendor payments"
  ON vendor_payments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins and accounts can insert vendor payments"
  ON vendor_payments FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admins and accounts can update vendor payments"
  ON vendor_payments FOR UPDATE
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

CREATE POLICY "Admins can delete vendor payments"
  ON vendor_payments FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = 'admin'
    )
  );

-- Trigger to update bank account balance when payment is recorded
CREATE OR REPLACE FUNCTION update_bank_balance_on_payment()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Increase balance for customer payment (money in)
    IF TG_TABLE_NAME = 'customer_payments' AND NEW.bank_account_id IS NOT NULL THEN
      UPDATE bank_accounts
      SET current_balance = current_balance + NEW.amount,
          updated_at = now()
      WHERE id = NEW.bank_account_id;
    END IF;
    
    -- Decrease balance for vendor payment (money out)
    IF TG_TABLE_NAME = 'vendor_payments' AND NEW.bank_account_id IS NOT NULL THEN
      UPDATE bank_accounts
      SET current_balance = current_balance - NEW.amount,
          updated_at = now()
      WHERE id = NEW.bank_account_id;
    END IF;
    
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Reverse the balance changes
    IF TG_TABLE_NAME = 'customer_payments' AND OLD.bank_account_id IS NOT NULL THEN
      UPDATE bank_accounts
      SET current_balance = current_balance - OLD.amount,
          updated_at = now()
      WHERE id = OLD.bank_account_id;
    END IF;
    
    IF TG_TABLE_NAME = 'vendor_payments' AND OLD.bank_account_id IS NOT NULL THEN
      UPDATE bank_accounts
      SET current_balance = current_balance + OLD.amount,
          updated_at = now()
      WHERE id = OLD.bank_account_id;
    END IF;
    
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers
DROP TRIGGER IF EXISTS trigger_customer_payment_bank_balance ON customer_payments;
CREATE TRIGGER trigger_customer_payment_bank_balance
  AFTER INSERT OR DELETE ON customer_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_bank_balance_on_payment();

DROP TRIGGER IF EXISTS trigger_vendor_payment_bank_balance ON vendor_payments;
CREATE TRIGGER trigger_vendor_payment_bank_balance
  AFTER INSERT OR DELETE ON vendor_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_bank_balance_on_payment();

-- Trigger to update invoice payment status
CREATE OR REPLACE FUNCTION update_invoice_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_total_paid numeric;
  v_invoice_total numeric;
BEGIN
  -- Calculate total paid for the invoice
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_paid
  FROM customer_payments
  WHERE invoice_id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  
  -- Get invoice total
  SELECT total_amount
  INTO v_invoice_total
  FROM sales_invoices
  WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  
  -- Update payment status
  IF v_total_paid = 0 THEN
    UPDATE sales_invoices
    SET payment_status = 'pending'
    WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  ELSIF v_total_paid >= v_invoice_total THEN
    UPDATE sales_invoices
    SET payment_status = 'paid'
    WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  ELSE
    UPDATE sales_invoices
    SET payment_status = 'partial'
    WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  END IF;
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_update_invoice_payment_status ON customer_payments;
CREATE TRIGGER trigger_update_invoice_payment_status
  AFTER INSERT OR DELETE ON customer_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_invoice_payment_status();

-- Trigger to update vendor bill payment status
CREATE OR REPLACE FUNCTION update_bill_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_total_paid numeric;
  v_bill_total numeric;
BEGIN
  -- Calculate total paid for the bill
  SELECT COALESCE(SUM(amount), 0)
  INTO v_total_paid
  FROM vendor_payments
  WHERE bill_id = COALESCE(NEW.bill_id, OLD.bill_id);
  
  -- Get bill total
  SELECT total_amount
  INTO v_bill_total
  FROM vendor_bills
  WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);
  
  -- Update payment status
  IF v_total_paid = 0 THEN
    UPDATE vendor_bills
    SET payment_status = 'pending'
    WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);
  ELSIF v_total_paid >= v_bill_total THEN
    UPDATE vendor_bills
    SET payment_status = 'paid'
    WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);
  ELSE
    UPDATE vendor_bills
    SET payment_status = 'partial'
    WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);
  END IF;
  
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_update_bill_payment_status ON vendor_payments;
CREATE TRIGGER trigger_update_bill_payment_status
  AFTER INSERT OR DELETE ON vendor_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_bill_payment_status();

COMMENT ON TABLE bank_accounts IS 'Bank accounts for managing company funds and reconciliation';
COMMENT ON TABLE customer_payments IS 'Payments received from customers against sales invoices';
COMMENT ON TABLE vendor_bills IS 'Bills received from vendors for purchases and expenses';
COMMENT ON TABLE vendor_payments IS 'Payments made to vendors against bills';
