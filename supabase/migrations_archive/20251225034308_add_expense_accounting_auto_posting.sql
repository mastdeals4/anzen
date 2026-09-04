/*
  # Add Automatic Accounting Entries for Expenses

  1. Trigger Function
    - Automatically post accounting entries when expense is created/updated
    - Import-type expenses: Dr Inventory, Cr Cash/Bank
    - Sales/Admin-type expenses: Dr Expense, Cr Cash/Bank

  2. Logic
    - Check expense_type field
    - If 'import' → Capitalize to inventory
    - If 'sales' or 'admin' → Expense to P&L
    - Create journal entries automatically
*/

-- =====================================================
-- 1. CREATE FUNCTION TO AUTO-POST EXPENSE ENTRIES
-- =====================================================

CREATE OR REPLACE FUNCTION auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_description TEXT;
  v_inventory_account_id UUID;
  v_expense_account_id UUID;
  v_cash_account_id UUID;
  v_journal_id UUID;
BEGIN
  -- Get account IDs
  SELECT id INTO v_inventory_account_id
  FROM chart_of_accounts
  WHERE account_code = '1300' OR account_name ILIKE '%inventory%'
  LIMIT 1;

  SELECT id INTO v_expense_account_id
  FROM chart_of_accounts
  WHERE account_code LIKE '5%' OR account_name ILIKE '%expense%'
  LIMIT 1;

  SELECT id INTO v_cash_account_id
  FROM chart_of_accounts
  WHERE account_code = '1100' OR account_name ILIKE '%cash%'
  LIMIT 1;

  -- Build description
  v_description := 'Expense: ' || NEW.expense_category;
  IF NEW.description IS NOT NULL THEN
    v_description := v_description || ' - ' || NEW.description;
  END IF;

  -- Create journal entry based on expense type
  IF NEW.expense_type = 'import' THEN
    -- Import expenses are CAPITALIZED to inventory
    -- Dr Inventory, Cr Cash
    
    IF v_inventory_account_id IS NULL OR v_cash_account_id IS NULL THEN
      RAISE NOTICE 'Inventory or Cash account not found - skipping auto-posting';
      RETURN NEW;
    END IF;

    -- Create journal header
    INSERT INTO journal_entries (
      entry_date,
      entry_type,
      reference_number,
      description,
      total_debit,
      total_credit,
      status,
      created_by
    ) VALUES (
      NEW.expense_date,
      'expense',
      'EXP-' || NEW.id::text,
      v_description || ' (CAPITALIZED)',
      NEW.amount,
      NEW.amount,
      'posted',
      NEW.created_by
    ) RETURNING id INTO v_journal_id;

    -- Create journal lines
    -- Debit: Inventory
    INSERT INTO journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description
    ) VALUES (
      v_journal_id,
      v_inventory_account_id,
      NEW.amount,
      0,
      'Inventory - ' || NEW.expense_category
    );

    -- Credit: Cash
    INSERT INTO journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description
    ) VALUES (
      v_journal_id,
      v_cash_account_id,
      0,
      NEW.amount,
      'Cash payment'
    );

  ELSE
    -- Sales/Admin expenses are EXPENSED to P&L
    -- Dr Expense, Cr Cash
    
    IF v_expense_account_id IS NULL OR v_cash_account_id IS NULL THEN
      RAISE NOTICE 'Expense or Cash account not found - skipping auto-posting';
      RETURN NEW;
    END IF;

    -- Create journal header
    INSERT INTO journal_entries (
      entry_date,
      entry_type,
      reference_number,
      description,
      total_debit,
      total_credit,
      status,
      created_by
    ) VALUES (
      NEW.expense_date,
      'expense',
      'EXP-' || NEW.id::text,
      v_description || ' (EXPENSE)',
      NEW.amount,
      NEW.amount,
      'posted',
      NEW.created_by
    ) RETURNING id INTO v_journal_id;

    -- Create journal lines
    -- Debit: Expense
    INSERT INTO journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description
    ) VALUES (
      v_journal_id,
      v_expense_account_id,
      NEW.amount,
      0,
      'Expense - ' || NEW.expense_category
    );

    -- Credit: Cash
    INSERT INTO journal_entry_lines (
      journal_entry_id,
      account_id,
      debit,
      credit,
      description
    ) VALUES (
      v_journal_id,
      v_cash_account_id,
      0,
      NEW.amount,
      'Cash payment'
    );

  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the expense insert
    RAISE NOTICE 'Error auto-posting expense accounting: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- =====================================================
-- 2. CREATE TRIGGER
-- =====================================================

DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON finance_expenses;

CREATE TRIGGER trigger_auto_post_expense_accounting
  AFTER INSERT ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION auto_post_expense_accounting();

-- =====================================================
-- 3. COMMENTS
-- =====================================================

COMMENT ON FUNCTION auto_post_expense_accounting() IS 
'Automatically creates journal entries when expenses are recorded.
Import-type expenses are capitalized to inventory.
Sales/Admin-type expenses are expensed to P&L.';
