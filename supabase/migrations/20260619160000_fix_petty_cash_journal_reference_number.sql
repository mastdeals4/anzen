/*
  # Fix petty cash voucher numbers in Account Ledger

  ## Problem
  post_petty_cash_to_journal() never wrote reference_number into journal_entries —
  only reference_id (the petty_cash_transactions UUID). AccountLedger falls back
  to entry_number (JE-YYYYMMDD-NNNN) when reference_number is NULL, so petty cash
  rows display JE2601**** instead of PC-YYYYMM-NNN.

  ## Fix
  1. Backfill: set reference_number = pct.transaction_number on existing petty_cash
     journal entries that link to a transaction_number via reference_id.
  2. Update trigger: both INSERT branches now write reference_number = NEW.transaction_number.
*/

-- ===========================================================================
-- 1. Backfill existing petty_cash journal entries
-- ===========================================================================
UPDATE public.journal_entries je
SET reference_number = pct.transaction_number
FROM public.petty_cash_transactions pct
WHERE je.source_module = 'petty_cash'
  AND je.reference_id = pct.id
  AND pct.transaction_number IS NOT NULL
  AND (je.reference_number IS NULL OR je.reference_number NOT LIKE 'PC-%');

-- ===========================================================================
-- 2. Update trigger to write reference_number going forward
-- ===========================================================================
CREATE OR REPLACE FUNCTION post_petty_cash_to_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id UUID;
  v_entry_number TEXT;
  v_petty_cash_account_id UUID;
  v_bank_account_coa_id UUID;
  v_expense_account_id UUID;
  v_line_num INT;
BEGIN
  IF NEW.source IN ('moved_from_tracker', 'finance_expense', 'migrated_from_expenses') THEN
    RETURN NEW;
  END IF;

  SELECT 'JE-' || TO_CHAR(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         LPAD((COUNT(*) + 1)::TEXT, 4, '0')
  INTO v_entry_number
  FROM journal_entries;

  SELECT id INTO v_petty_cash_account_id
  FROM chart_of_accounts
  WHERE code = '1102' OR code LIKE '1-103%' OR LOWER(name) LIKE '%petty%cash%'
  LIMIT 1;

  IF v_petty_cash_account_id IS NULL THEN
    INSERT INTO chart_of_accounts (code, name, account_type, is_active)
    VALUES ('1102', 'Petty Cash', 'asset', true)
    RETURNING id INTO v_petty_cash_account_id;
  END IF;

  IF NEW.transaction_type = 'withdraw' THEN
    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id INTO v_bank_account_coa_id
      FROM bank_accounts
      WHERE id = NEW.bank_account_id;
    END IF;

    IF v_bank_account_coa_id IS NULL THEN
      SELECT id INTO v_bank_account_coa_id
      FROM chart_of_accounts
      WHERE code LIKE '1-102%' OR LOWER(name) LIKE '%bank%'
      ORDER BY code
      LIMIT 1;
    END IF;

    INSERT INTO journal_entries (
      entry_number,
      entry_date,
      source_module,
      reference_id,
      reference_number,
      description,
      is_posted,
      created_by,
      posted_at
    ) VALUES (
      v_entry_number,
      NEW.transaction_date,
      'petty_cash',
      NEW.id,
      NEW.transaction_number,
      'Petty cash withdrawal: ' || COALESCE(NEW.description, ''),
      true,
      NEW.created_by,
      NOW()
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES (
      v_journal_id, v_line_num, v_petty_cash_account_id, NEW.amount, 0, 'Cash withdrawal'
    );

    IF v_bank_account_coa_id IS NOT NULL THEN
      v_line_num := v_line_num + 1;
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, debit, credit, description
      ) VALUES (
        v_journal_id, v_line_num, v_bank_account_coa_id, 0, NEW.amount, 'Transfer to petty cash'
      );
    END IF;

  ELSIF NEW.transaction_type = 'expense' THEN
    SELECT id INTO v_expense_account_id
    FROM chart_of_accounts
    WHERE account_type = 'expense'
      AND (
        CASE
          WHEN NEW.expense_category = 'Office Supplies'        THEN LOWER(name) LIKE '%office%' OR code = '6-1010'
          WHEN NEW.expense_category = 'Transportation'         THEN LOWER(name) LIKE '%transport%' OR code = '6-1020'
          WHEN NEW.expense_category = 'Meals & Entertainment'  THEN LOWER(name) LIKE '%entertainment%' OR code = '6-1030'
          WHEN NEW.expense_category = 'Postage & Courier'      THEN LOWER(name) LIKE '%postage%' OR code = '6-1040'
          WHEN NEW.expense_category = 'Cleaning & Maintenance' THEN LOWER(name) LIKE '%maintenance%' OR code = '6-1050'
          WHEN NEW.expense_category = 'Utilities'              THEN LOWER(name) LIKE '%utilities%' OR code = '6-1060'
          ELSE code = '6-1090' OR LOWER(name) LIKE '%misc%'
        END
      )
    ORDER BY code
    LIMIT 1;

    IF v_expense_account_id IS NULL THEN
      SELECT id INTO v_expense_account_id
      FROM chart_of_accounts
      WHERE account_type = 'expense'
      ORDER BY code
      LIMIT 1;
    END IF;

    INSERT INTO journal_entries (
      entry_number,
      entry_date,
      source_module,
      reference_id,
      reference_number,
      description,
      is_posted,
      created_by,
      posted_at
    ) VALUES (
      v_entry_number,
      NEW.transaction_date,
      'petty_cash',
      NEW.id,
      NEW.transaction_number,
      'Petty cash expense: ' || COALESCE(NEW.description, ''),
      true,
      NEW.created_by,
      NOW()
    ) RETURNING id INTO v_journal_id;

    v_line_num := 1;

    IF v_expense_account_id IS NOT NULL THEN
      INSERT INTO journal_entry_lines (
        journal_entry_id, line_number, account_id, debit, credit, description
      ) VALUES (
        v_journal_id, v_line_num, v_expense_account_id, NEW.amount, 0,
        COALESCE(NEW.expense_category, 'Petty cash expense')
      );
      v_line_num := v_line_num + 1;
    END IF;

    INSERT INTO journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES (
      v_journal_id, v_line_num, v_petty_cash_account_id, 0, NEW.amount, 'Petty cash payment'
    );
  END IF;

  RETURN NEW;
END;
$$;
