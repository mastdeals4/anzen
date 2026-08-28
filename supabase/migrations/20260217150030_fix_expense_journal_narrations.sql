/*
  # Fix expense journal entry narrations

  1. Changes
    - Updates auto_post_expense_accounting trigger to use expense description 
      on BOTH debit and credit journal entry lines
    - Credit line now shows: "expense description (Category: category_name)"
      instead of just the bank account holder name
    - Updates all existing journal entry credit lines for expenses to use
      the actual expense description instead of bank account name

  2. Impact
    - All ledgers (Account Ledger, Bank Ledger, CA Reports) will now show 
      meaningful narrations for expense entries
    - Existing entries are retroactively fixed
*/

-- Fix the trigger function to use expense description on credit lines too
CREATE OR REPLACE FUNCTION auto_post_expense_accounting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expense_account_id UUID;
  v_payment_account_id UUID;
  v_journal_id UUID;
  v_description TEXT;
  v_credit_desc TEXT;
  v_entry_number TEXT;
  v_category_label TEXT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM journal_entries 
    WHERE reference_number = 'EXP-' || NEW.id::text
  ) THEN
    RETURN NEW;
  END IF;

  SELECT 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-' || 
    LPAD((COALESCE(MAX(CAST(SUBSTRING(entry_number FROM '-([0-9]+)$') AS INTEGER)), 0) + 1)::TEXT, 4, '0')
  INTO v_entry_number
  FROM journal_entries
  WHERE entry_number LIKE 'JE' || TO_CHAR(NEW.expense_date, 'YYMM') || '-%';

  v_expense_account_id := get_expense_account_id(NEW.expense_category);
  IF v_expense_account_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.payment_method = 'cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  ELSIF NEW.payment_method = 'petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id
    FROM bank_accounts WHERE id = NEW.bank_account_id;
    IF v_payment_account_id IS NULL THEN
      SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
    END IF;
  ELSIF NEW.payment_method IS NULL THEN
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '2110' LIMIT 1;
  ELSE
    SELECT id INTO v_payment_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;

  IF v_payment_account_id IS NULL THEN RETURN NEW; END IF;

  v_category_label := REPLACE(INITCAP(REPLACE(NEW.expense_category, '_', ' ')), ' ', ' ');
  v_description := COALESCE(NEW.description, NEW.expense_category);
  v_credit_desc := COALESCE(
    SUBSTRING(NEW.description FROM '^[^\n]+'),
    NEW.expense_category
  ) || ' [' || v_category_label || ']';

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_number,
    description, transaction_category,
    total_debit, total_credit, is_posted, posted_at, created_by
  ) VALUES (
    v_entry_number, NEW.expense_date, 'expenses', 'EXP-' || NEW.id::text,
    v_description, NEW.expense_category,
    NEW.amount, NEW.amount, true, now(), NEW.created_by
  ) RETURNING id INTO v_journal_id;

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 1, v_expense_account_id, NEW.amount, 0, v_credit_desc);

  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit, credit, description)
  VALUES (v_journal_id, 2, v_payment_account_id, 0, NEW.amount, v_credit_desc);

  RETURN NEW;
END;
$$;

-- Now fix all existing journal entry lines for expenses
-- Update credit lines (line_number = 2) to use expense description
UPDATE journal_entry_lines jel
SET description = COALESCE(
  SUBSTRING(fe.description FROM '^[^\n]+'),
  fe.expense_category
) || ' [' || REPLACE(INITCAP(REPLACE(fe.expense_category, '_', ' ')), ' ', ' ') || ']'
FROM journal_entries je
JOIN finance_expenses fe ON je.reference_number = 'EXP-' || fe.id::text
WHERE jel.journal_entry_id = je.id
AND je.source_module = 'expenses'
AND jel.line_number = 2;

-- Also update debit lines (line_number = 1) to have consistent descriptions
UPDATE journal_entry_lines jel
SET description = COALESCE(
  SUBSTRING(fe.description FROM '^[^\n]+'),
  fe.expense_category
) || ' [' || REPLACE(INITCAP(REPLACE(fe.expense_category, '_', ' ')), ' ', ' ') || ']'
FROM journal_entries je
JOIN finance_expenses fe ON je.reference_number = 'EXP-' || fe.id::text
WHERE jel.journal_entry_id = je.id
AND je.source_module = 'expenses'
AND jel.line_number = 1;