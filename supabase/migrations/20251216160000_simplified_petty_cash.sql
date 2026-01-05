-- Enhanced Petty Cash System
-- Simple Dr/Cr entries with detailed tracking: Withdraw cash from bank, Record cash expenses

-- First, ensure profiles table exists (required for staff tracking)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email VARCHAR(255),
  full_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'accounts',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Basic profiles policies (if they don't exist)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can view all profiles') THEN
    CREATE POLICY "Users can view all profiles" ON profiles FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'profiles' AND policyname = 'Users can update own profile') THEN
    CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE TO authenticated USING (id = auth.uid());
  END IF;
END $$;

-- Create petty cash transactions table if it doesn't exist
CREATE TABLE IF NOT EXISTS petty_cash_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_number VARCHAR(50) UNIQUE NOT NULL,
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('withdraw', 'expense')),
  amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  expense_category VARCHAR(100),
  bank_account_id UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add new columns if they don't exist (for existing tables)
-- Note: Staff ID columns reference auth.users instead of profiles for broader compatibility
DO $$
BEGIN
  -- Add paid_to column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'paid_to') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN paid_to VARCHAR(255);
  END IF;

  -- Add paid_by_staff_id column (references profiles for staff tracking)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'paid_by_staff_id') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN paid_by_staff_id UUID REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;

  -- Add source column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'source') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN source VARCHAR(255);
  END IF;

  -- Add received_by_staff_id column (references profiles for staff tracking)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'received_by_staff_id') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN received_by_staff_id UUID REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;

  -- Add paid_by_staff_name for display purposes
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'paid_by_staff_name') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN paid_by_staff_name VARCHAR(255);
  END IF;

  -- Add received_by_staff_name for display purposes
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'petty_cash_transactions' AND column_name = 'received_by_staff_name') THEN
    ALTER TABLE petty_cash_transactions ADD COLUMN received_by_staff_name VARCHAR(255);
  END IF;
END $$;

-- Petty cash document attachments
CREATE TABLE IF NOT EXISTS petty_cash_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  petty_cash_transaction_id UUID NOT NULL REFERENCES petty_cash_transactions(id) ON DELETE CASCADE,
  file_type VARCHAR(50) NOT NULL CHECK (file_type IN ('proof', 'invoice', 'photo', 'other')),
  file_name VARCHAR(255),
  file_url TEXT NOT NULL,
  file_size INTEGER,
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for documents
ALTER TABLE petty_cash_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view petty cash documents" ON petty_cash_documents;
CREATE POLICY "Users can view petty cash documents"
  ON petty_cash_documents FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Admin and accounts can insert petty cash documents" ON petty_cash_documents;
CREATE POLICY "Admin and accounts can insert petty cash documents"
  ON petty_cash_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin can delete petty cash documents" ON petty_cash_documents;
CREATE POLICY "Admin can delete petty cash documents"
  ON petty_cash_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Enable RLS on transactions
ALTER TABLE petty_cash_transactions ENABLE ROW LEVEL SECURITY;

-- RLS policies for transactions
DROP POLICY IF EXISTS "Users can view petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Users can view petty cash transactions"
  ON petty_cash_transactions FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Admin and accounts can insert petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin and accounts can insert petty cash transactions"
  ON petty_cash_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin and accounts can update petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin and accounts can update petty cash transactions"
  ON petty_cash_transactions FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'accounts')
    )
  );

DROP POLICY IF EXISTS "Admin can delete petty cash transactions" ON petty_cash_transactions;
CREATE POLICY "Admin can delete petty cash transactions"
  ON petty_cash_transactions FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_date 
  ON petty_cash_transactions(transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_petty_cash_transactions_type 
  ON petty_cash_transactions(transaction_type);

-- Trigger for auto-posting journal entries
CREATE OR REPLACE FUNCTION post_petty_cash_to_journal()
RETURNS TRIGGER AS $$
DECLARE
  v_journal_id UUID;
  v_petty_cash_account_id UUID;
  v_expense_account_id UUID;
  v_bank_account_coa_id UUID;
BEGIN
  -- Get petty cash account (1-1030 or similar)
  SELECT id INTO v_petty_cash_account_id
  FROM chart_of_accounts
  WHERE account_code LIKE '1-103%' OR account_name ILIKE '%petty%cash%'
  LIMIT 1;

  IF v_petty_cash_account_id IS NULL THEN
    -- Create petty cash account if not exists
    INSERT INTO chart_of_accounts (account_code, account_name, account_type, parent_id, is_active)
    VALUES ('1-1030', 'Petty Cash', 'asset', NULL, true)
    RETURNING id INTO v_petty_cash_account_id;
  END IF;

  IF NEW.transaction_type = 'withdraw' THEN
    -- Withdraw: Dr Petty Cash, Cr Bank
    -- Get linked bank account's COA id
    SELECT coa_id INTO v_bank_account_coa_id
    FROM bank_accounts
    WHERE id = NEW.bank_account_id;

    IF v_bank_account_coa_id IS NULL THEN
      -- Use default bank account
      SELECT id INTO v_bank_account_coa_id
      FROM chart_of_accounts
      WHERE account_code LIKE '1-102%' OR account_name ILIKE '%bank%'
      LIMIT 1;
    END IF;

    -- Create journal entry
    INSERT INTO journal_entries (
      entry_date, reference_type, reference_id, description, 
      status, created_by, posted_at
    ) VALUES (
      NEW.transaction_date, 'petty_cash', NEW.id,
      'Cash withdrawal: ' || NEW.description,
      'posted', NEW.created_by, NOW()
    ) RETURNING id INTO v_journal_id;

    -- Dr Petty Cash
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
    VALUES (v_journal_id, v_petty_cash_account_id, NEW.amount, 0, 'Cash withdrawal');

    -- Cr Bank
    IF v_bank_account_coa_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES (v_journal_id, v_bank_account_coa_id, 0, NEW.amount, 'Cash withdrawal to petty cash');
    END IF;

  ELSIF NEW.transaction_type = 'expense' THEN
    -- Expense: Dr Expense, Cr Petty Cash
    -- Get expense account based on category
    SELECT id INTO v_expense_account_id
    FROM chart_of_accounts
    WHERE account_type = 'expense'
    AND (
      CASE 
        WHEN NEW.expense_category = 'Office Supplies' THEN account_name ILIKE '%office%' OR account_code = '6-1010'
        WHEN NEW.expense_category = 'Transportation' THEN account_name ILIKE '%transport%' OR account_code = '6-1020'
        WHEN NEW.expense_category = 'Meals & Entertainment' THEN account_name ILIKE '%entertainment%' OR account_code = '6-1030'
        WHEN NEW.expense_category = 'Postage & Courier' THEN account_name ILIKE '%postage%' OR account_code = '6-1040'
        WHEN NEW.expense_category = 'Cleaning & Maintenance' THEN account_name ILIKE '%maintenance%' OR account_code = '6-1050'
        WHEN NEW.expense_category = 'Utilities' THEN account_name ILIKE '%utilities%' OR account_code = '6-1060'
        ELSE account_code = '6-1090' OR account_name ILIKE '%misc%'
      END
    )
    LIMIT 1;

    IF v_expense_account_id IS NULL THEN
      -- Use general expense account
      SELECT id INTO v_expense_account_id
      FROM chart_of_accounts
      WHERE account_type = 'expense'
      LIMIT 1;
    END IF;

    -- Create journal entry
    INSERT INTO journal_entries (
      entry_date, reference_type, reference_id, description, 
      status, created_by, posted_at
    ) VALUES (
      NEW.transaction_date, 'petty_cash', NEW.id,
      'Petty cash expense: ' || NEW.description,
      'posted', NEW.created_by, NOW()
    ) RETURNING id INTO v_journal_id;

    -- Dr Expense
    IF v_expense_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
      VALUES (v_journal_id, v_expense_account_id, NEW.amount, 0, COALESCE(NEW.expense_category, 'Petty cash expense'));
    END IF;

    -- Cr Petty Cash
    INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit_amount, credit_amount, description)
    VALUES (v_journal_id, v_petty_cash_account_id, 0, NEW.amount, 'Petty cash expense');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger
DROP TRIGGER IF EXISTS trigger_post_petty_cash ON petty_cash_transactions;
CREATE TRIGGER trigger_post_petty_cash
  AFTER INSERT ON petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION post_petty_cash_to_journal();

SELECT 'Enhanced Petty Cash system created/updated successfully' as status;
