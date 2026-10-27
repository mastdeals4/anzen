/*
  # Accounting System Triggers and Fixes
  
  This migration adds:
  1. Journal entry auto-posting triggers for sales invoices, purchase invoices, vouchers
  2. Fixes for batch-supplier linking
  3. Improved reporting functions
*/

-- ============================================
-- 1. TRIGGER: Auto-post Sales Invoice to Journal
-- ============================================
CREATE OR REPLACE FUNCTION post_sales_invoice_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_ar_account_id UUID;
  v_sales_account_id UUID;
  v_ppn_account_id UUID;
BEGIN
  -- Only post on insert or when status changes to 'unpaid' or 'partial'
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NULL AND NEW.status IN ('unpaid', 'partial', 'paid')) THEN
    
    -- Get account IDs
    SELECT id INTO v_ar_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
    SELECT id INTO v_sales_account_id FROM chart_of_accounts WHERE code = '4100' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '2130' LIMIT 1;

    IF v_ar_account_id IS NULL OR v_sales_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Generate journal entry number
    v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
      SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
    )::TEXT, 4, '0');

    -- Create journal entry
    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.invoice_date, 'sales_invoice', NEW.id, NEW.invoice_number,
      'Sales Invoice: ' || NEW.invoice_number,
      NEW.total_amount, NEW.total_amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Debit: Accounts Receivable
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 1, v_ar_account_id, 'A/R - ' || NEW.invoice_number, NEW.total_amount, 0, NEW.customer_id);

    -- Credit: Sales Revenue (subtotal)
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_sales_account_id, 'Sales - ' || NEW.invoice_number, 0, NEW.subtotal, NEW.customer_id);

    -- Credit: PPN Output (if applicable)
    IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
      VALUES (v_je_id, 3, v_ppn_account_id, 'PPN Output - ' || NEW.invoice_number, 0, NEW.tax_amount, NEW.customer_id);
    END IF;

    -- Update sales invoice with journal entry ID
    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_sales_invoice ON sales_invoices;
CREATE TRIGGER trg_post_sales_invoice
  BEFORE INSERT OR UPDATE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION post_sales_invoice_journal();

-- ============================================
-- 2. TRIGGER: Auto-post Purchase Invoice to Journal
-- ============================================
CREATE OR REPLACE FUNCTION post_purchase_invoice_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_ap_account_id UUID;
  v_inventory_account_id UUID;
  v_ppn_account_id UUID;
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.journal_entry_id IS NULL AND NEW.status IN ('unpaid', 'partial', 'paid')) THEN
    
    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_inventory_account_id FROM chart_of_accounts WHERE code = '1130' LIMIT 1;
    SELECT id INTO v_ppn_account_id FROM chart_of_accounts WHERE code = '1150' LIMIT 1;

    IF v_ap_account_id IS NULL OR v_inventory_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
      SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
    )::TEXT, 4, '0');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.invoice_date, 'purchase_invoice', NEW.id, NEW.invoice_number,
      'Purchase Invoice: ' || NEW.invoice_number,
      NEW.total_amount, NEW.total_amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Debit: Inventory
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 1, v_inventory_account_id, 'Inventory - ' || NEW.invoice_number, NEW.subtotal, 0, NEW.supplier_id);

    -- Debit: PPN Input (if applicable)
    IF NEW.tax_amount > 0 AND v_ppn_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES (v_je_id, 2, v_ppn_account_id, 'PPN Input - ' || NEW.invoice_number, NEW.tax_amount, 0, NEW.supplier_id);
    END IF;

    -- Credit: Accounts Payable
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 3, v_ap_account_id, 'A/P - ' || NEW.invoice_number, 0, NEW.total_amount, NEW.supplier_id);

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_purchase_invoice ON purchase_invoices;
CREATE TRIGGER trg_post_purchase_invoice
  BEFORE INSERT OR UPDATE ON purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION post_purchase_invoice_journal();

-- ============================================
-- 3. TRIGGER: Auto-post Receipt Voucher to Journal
-- ============================================
CREATE OR REPLACE FUNCTION post_receipt_voucher_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_cash_account_id UUID;
  v_ar_account_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    
    IF NEW.payment_method = 'cash' THEN
      SELECT id INTO v_cash_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
    ELSE
      SELECT id INTO v_cash_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
    SELECT id INTO v_ar_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;

    IF v_cash_account_id IS NULL OR v_ar_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
      SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
    )::TEXT, 4, '0');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.voucher_date, 'receipt', NEW.id, NEW.voucher_number,
      'Receipt Voucher: ' || NEW.voucher_number,
      NEW.amount, NEW.amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Debit: Cash/Bank
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 1, v_cash_account_id, 'Cash Receipt - ' || NEW.voucher_number, NEW.amount, 0, NEW.customer_id);

    -- Credit: Accounts Receivable
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, 2, v_ar_account_id, 'A/R Payment - ' || NEW.voucher_number, 0, NEW.amount, NEW.customer_id);

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_receipt_voucher ON receipt_vouchers;
CREATE TRIGGER trg_post_receipt_voucher
  BEFORE INSERT ON receipt_vouchers
  FOR EACH ROW EXECUTE FUNCTION post_receipt_voucher_journal();

-- ============================================
-- 4. TRIGGER: Auto-post Payment Voucher to Journal
-- ============================================
CREATE OR REPLACE FUNCTION post_payment_voucher_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_cash_account_id UUID;
  v_ap_account_id UUID;
  v_pph_account_id UUID;
  v_net_amount DECIMAL(18,2);
BEGIN
  IF TG_OP = 'INSERT' THEN
    
    IF NEW.payment_method = 'cash' THEN
      SELECT id INTO v_cash_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
    ELSE
      SELECT id INTO v_cash_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
    SELECT id INTO v_ap_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
    SELECT id INTO v_pph_account_id FROM chart_of_accounts WHERE code = '2132' LIMIT 1;

    IF v_cash_account_id IS NULL OR v_ap_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_net_amount := NEW.amount - COALESCE(NEW.pph_amount, 0);

    v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
      SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
    )::TEXT, 4, '0');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.voucher_date, 'payment', NEW.id, NEW.voucher_number,
      'Payment Voucher: ' || NEW.voucher_number,
      NEW.amount, NEW.amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Debit: Accounts Payable
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 1, v_ap_account_id, 'A/P Payment - ' || NEW.voucher_number, NEW.amount, 0, NEW.supplier_id);

    -- Credit: Cash/Bank (net amount)
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
    VALUES (v_je_id, 2, v_cash_account_id, 'Cash Payment - ' || NEW.voucher_number, 0, v_net_amount, NEW.supplier_id);

    -- Credit: PPh Payable (if applicable)
    IF COALESCE(NEW.pph_amount, 0) > 0 AND v_pph_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, supplier_id)
      VALUES (v_je_id, 3, v_pph_account_id, 'PPh Withheld - ' || NEW.voucher_number, 0, NEW.pph_amount, NEW.supplier_id);
    END IF;

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_payment_voucher ON payment_vouchers;
CREATE TRIGGER trg_post_payment_voucher
  BEFORE INSERT ON payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION post_payment_voucher_journal();

-- ============================================
-- 5. TRIGGER: Auto-post Petty Cash Voucher to Journal
-- ============================================
CREATE OR REPLACE FUNCTION post_petty_cash_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je_id UUID;
  v_je_number TEXT;
  v_petty_cash_account_id UUID;
  v_expense_account_id UUID;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.voucher_type = 'expense' THEN
    
    SELECT id INTO v_petty_cash_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
    
    -- Use provided account or default to misc expense
    IF NEW.account_id IS NOT NULL THEN
      v_expense_account_id := NEW.account_id;
    ELSE
      SELECT id INTO v_expense_account_id FROM chart_of_accounts WHERE code = '6900' LIMIT 1;
    END IF;

    IF v_petty_cash_account_id IS NULL OR v_expense_account_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_je_number := 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '-' || LPAD((
      SELECT COUNT(*) + 1 FROM journal_entries WHERE entry_number LIKE 'JE' || TO_CHAR(CURRENT_DATE, 'YYMM') || '%'
    )::TEXT, 4, '0');

    INSERT INTO journal_entries (
      entry_number, entry_date, source_module, reference_id, reference_number,
      description, total_debit, total_credit, is_posted, posted_by
    ) VALUES (
      v_je_number, NEW.voucher_date, 'petty_cash', NEW.id, NEW.voucher_number,
      'Petty Cash: ' || NEW.description,
      NEW.amount, NEW.amount, true, NEW.created_by
    ) RETURNING id INTO v_je_id;

    -- Debit: Expense
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
    VALUES (v_je_id, 1, v_expense_account_id, NEW.description, NEW.amount, 0);

    -- Credit: Petty Cash
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit)
    VALUES (v_je_id, 2, v_petty_cash_account_id, 'Petty Cash - ' || NEW.voucher_number, 0, NEW.amount);

    NEW.journal_entry_id := v_je_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_post_petty_cash ON petty_cash_vouchers;
CREATE TRIGGER trg_post_petty_cash
  BEFORE INSERT ON petty_cash_vouchers
  FOR EACH ROW EXECUTE FUNCTION post_petty_cash_journal();

-- ============================================
-- 6. REPORTING FUNCTIONS
-- ============================================

-- Trial Balance with date range
CREATE OR REPLACE FUNCTION get_trial_balance(p_start_date DATE, p_end_date DATE)
RETURNS TABLE (
  code VARCHAR,
  name VARCHAR,
  name_id VARCHAR,
  account_type VARCHAR,
  account_group VARCHAR,
  total_debit DECIMAL,
  total_credit DECIMAL,
  balance DECIMAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    coa.code,
    coa.name,
    coa.name_id,
    coa.account_type,
    coa.account_group,
    COALESCE(SUM(jel.debit), 0) AS total_debit,
    COALESCE(SUM(jel.credit), 0) AS total_credit,
    COALESCE(SUM(jel.debit), 0) - COALESCE(SUM(jel.credit), 0) AS balance
  FROM chart_of_accounts coa
  LEFT JOIN journal_entry_lines jel ON coa.id = jel.account_id
  LEFT JOIN journal_entries je ON jel.journal_entry_id = je.id 
    AND je.is_posted = true
    AND je.entry_date >= p_start_date 
    AND je.entry_date <= p_end_date
  WHERE coa.is_header = false AND coa.is_active = true
  GROUP BY coa.id, coa.code, coa.name, coa.name_id, coa.account_type, coa.account_group
  HAVING COALESCE(SUM(jel.debit), 0) != 0 OR COALESCE(SUM(jel.credit), 0) != 0
  ORDER BY coa.code;
END;
$$;

-- P&L Summary
CREATE OR REPLACE FUNCTION get_pnl_summary(p_start_date DATE, p_end_date DATE)
RETURNS TABLE (
  total_revenue DECIMAL,
  total_expenses DECIMAL,
  net_income DECIMAL
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revenue DECIMAL;
  v_expenses DECIMAL;
BEGIN
  SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0)
  INTO v_revenue
  FROM journal_entry_lines jel
  JOIN chart_of_accounts coa ON jel.account_id = coa.id
  JOIN journal_entries je ON jel.journal_entry_id = je.id
  WHERE coa.account_type = 'revenue'
    AND je.is_posted = true
    AND je.entry_date >= p_start_date
    AND je.entry_date <= p_end_date;

  SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0)
  INTO v_expenses
  FROM journal_entry_lines jel
  JOIN chart_of_accounts coa ON jel.account_id = coa.id
  JOIN journal_entries je ON jel.journal_entry_id = je.id
  WHERE coa.account_type = 'expense'
    AND je.is_posted = true
    AND je.entry_date >= p_start_date
    AND je.entry_date <= p_end_date;

  RETURN QUERY SELECT v_revenue, v_expenses, v_revenue - v_expenses;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_trial_balance TO authenticated;
GRANT EXECUTE ON FUNCTION get_pnl_summary TO authenticated;

-- ============================================
-- 7. FIXES
-- ============================================

-- Add subtotal to sales_invoices if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_invoices' AND column_name = 'subtotal') THEN
    ALTER TABLE sales_invoices ADD COLUMN subtotal DECIMAL(18,2) DEFAULT 0;
    UPDATE sales_invoices SET subtotal = total_amount - COALESCE(tax_amount, 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sales_invoices' AND column_name = 'tax_amount') THEN
    ALTER TABLE sales_invoices ADD COLUMN tax_amount DECIMAL(18,2) DEFAULT 0;
  END IF;
END $$;

-- ============================================
-- 8. BANK RECONCILIATION TABLES
-- ============================================

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  transaction_date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(100),
  debit_amount DECIMAL(18,2) DEFAULT 0,
  credit_amount DECIMAL(18,2) DEFAULT 0,
  running_balance DECIMAL(18,2) DEFAULT 0,
  reconciliation_status VARCHAR(20) DEFAULT 'unmatched' CHECK (reconciliation_status IN ('matched', 'suggested', 'unmatched', 'created')),
  matched_entry_id UUID REFERENCES journal_entries(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_account ON bank_statement_lines(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_date ON bank_statement_lines(transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_status ON bank_statement_lines(reconciliation_status);

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bank_statement_lines_select" ON bank_statement_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "bank_statement_lines_insert" ON bank_statement_lines FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "bank_statement_lines_update" ON bank_statement_lines FOR UPDATE TO authenticated USING (true);
CREATE POLICY "bank_statement_lines_delete" ON bank_statement_lines FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
);

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '✅ Accounting triggers, reporting functions, and bank reconciliation added!';
  RAISE NOTICE 'Triggers: sales_invoice, purchase_invoice, receipt_voucher, payment_voucher, petty_cash';
  RAISE NOTICE 'Functions: get_trial_balance(), get_pnl_summary()';
  RAISE NOTICE 'Tables: bank_statement_lines';
END $$;
