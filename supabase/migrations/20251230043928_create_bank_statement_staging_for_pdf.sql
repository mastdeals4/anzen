/*
  # Bank Statement PDF Upload & Reconciliation System
  
  ## Purpose
  Enable BCA PDF statement uploads with multi-currency support and auto-matching
  
  ## New Tables
  
  ### `bank_statement_uploads`
  Tracks PDF uploads and metadata:
  - `id` - Unique identifier
  - `bank_account_id` - Links to bank_accounts
  - `upload_date` - When uploaded
  - `statement_period` - Month/Year (e.g., "November 2025")
  - `statement_start_date` - Period start
  - `statement_end_date` - Period end
  - `currency` - IDR or USD (from bank account)
  - `opening_balance` - Statement opening balance
  - `closing_balance` - Statement closing balance
  - `total_credits` - Sum of credit transactions
  - `total_debits` - Sum of debit transactions
  - `transaction_count` - Number of transactions
  - `file_url` - Original PDF storage URL
  - `uploaded_by` - User who uploaded
  - `status` - draft, processing, completed, error
  
  ### `bank_statement_lines`
  Staging area for parsed transactions:
  - `id` - Unique identifier
  - `upload_id` - Links to bank_statement_uploads
  - `bank_account_id` - Links to bank_accounts
  - `transaction_date` - Date from statement
  - `description` - KETERANGAN field
  - `reference` - Bank reference number
  - `branch_code` - CBG field (optional)
  - `debit_amount` - Debit value
  - `credit_amount` - Credit value
  - `running_balance` - SALDO field
  - `currency` - IDR or USD
  - `reconciliation_status` - unmatched, matched, needs_review, recorded
  - `matched_entry_id` - Links to journal_entries (if matched)
  - `matched_expense_id` - Links to finance_expenses (if recorded as expense)
  - `matched_receipt_id` - Links to receipt_vouchers (if recorded as receipt)
  - `matched_at` - Timestamp of match
  - `matched_by` - User who matched
  - `notes` - Manual notes
  - `created_by` - User who created
  
  ## Security
  - Enable RLS on all tables
  - Authenticated users can view their company's data
  - Only accounts/admin roles can manage
  
  ## Indexes
  - Foreign keys for performance
  - Transaction date for date range queries
  - Reconciliation status for filtering
*/

-- =====================================================
-- TABLE: bank_statement_uploads
-- =====================================================
CREATE TABLE IF NOT EXISTS bank_statement_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  upload_date timestamptz NOT NULL DEFAULT now(),
  statement_period text NOT NULL,
  statement_start_date date NOT NULL,
  statement_end_date date NOT NULL,
  currency text NOT NULL CHECK (currency IN ('IDR', 'USD')),
  opening_balance numeric(15,2) NOT NULL DEFAULT 0,
  closing_balance numeric(15,2) NOT NULL DEFAULT 0,
  total_credits numeric(15,2) NOT NULL DEFAULT 0,
  total_debits numeric(15,2) NOT NULL DEFAULT 0,
  transaction_count integer NOT NULL DEFAULT 0,
  file_url text,
  uploaded_by uuid REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'processing', 'completed', 'error')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- =====================================================
-- TABLE: bank_statement_lines
-- =====================================================
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id uuid NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  transaction_date date NOT NULL,
  description text,
  reference text,
  branch_code text,
  debit_amount numeric(15,2) DEFAULT 0,
  credit_amount numeric(15,2) DEFAULT 0,
  running_balance numeric(15,2),
  currency text NOT NULL CHECK (currency IN ('IDR', 'USD')),
  reconciliation_status text DEFAULT 'unmatched' CHECK (reconciliation_status IN ('unmatched', 'matched', 'needs_review', 'recorded')),
  matched_entry_id uuid REFERENCES journal_entries(id),
  matched_expense_id uuid REFERENCES finance_expenses(id),
  matched_receipt_id uuid REFERENCES receipt_vouchers(id),
  matched_at timestamptz,
  matched_by uuid REFERENCES auth.users(id),
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_bank_statement_uploads_account 
  ON bank_statement_uploads(bank_account_id);

CREATE INDEX IF NOT EXISTS idx_bank_statement_uploads_period 
  ON bank_statement_uploads(statement_start_date, statement_end_date);

CREATE INDEX IF NOT EXISTS idx_bank_statement_uploads_status 
  ON bank_statement_uploads(status);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_upload 
  ON bank_statement_lines(upload_id);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_account 
  ON bank_statement_lines(bank_account_id);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_date 
  ON bank_statement_lines(transaction_date);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_status 
  ON bank_statement_lines(reconciliation_status);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_currency 
  ON bank_statement_lines(currency);

-- =====================================================
-- RLS POLICIES
-- =====================================================
ALTER TABLE bank_statement_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;

-- bank_statement_uploads policies
CREATE POLICY "Users can view bank statement uploads"
  ON bank_statement_uploads FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Accounts/admin can insert bank statement uploads"
  ON bank_statement_uploads FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Accounts/admin can update bank statement uploads"
  ON bank_statement_uploads FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

-- bank_statement_lines policies
CREATE POLICY "Users can view bank statement lines"
  ON bank_statement_lines FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Accounts/admin can insert bank statement lines"
  ON bank_statement_lines FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Accounts/admin can update bank statement lines"
  ON bank_statement_lines FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Accounts/admin can delete bank statement lines"
  ON bank_statement_lines FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'accounts')
    )
  );
