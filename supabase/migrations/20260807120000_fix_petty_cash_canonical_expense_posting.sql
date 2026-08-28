-- Petty Cash categories are stored as canonical keys (for example,
-- `office_admin` and `travel_conveyance`).  Resolve them through the same
-- category resolver used by the rest of Finance rather than legacy UI labels.

CREATE OR REPLACE FUNCTION public.post_petty_cash_to_journal_fixed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_journal_id         uuid;
  v_petty_cash_account uuid;
  v_counter_account    uuid;
  v_expense_account    uuid;
  v_line_num           integer := 0;
  v_je_number          text;
  v_rows                integer;
BEGIN
  IF NEW.fund_transfer_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id
    INTO v_journal_id
    FROM public.journal_entries
   WHERE source_module = 'petty_cash'
     AND reference_id = NEW.id
   LIMIT 1;

  IF v_journal_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id
    INTO v_petty_cash_account
    FROM public.chart_of_accounts
   WHERE code = '1102'
     AND is_header = false
     AND is_active = true
   LIMIT 1;

  IF v_petty_cash_account IS NULL THEN
    RAISE EXCEPTION 'Cannot post petty cash %: active Petty Cash posting account is missing', NEW.id;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext('pc_je_number_' || to_char(NEW.transaction_date, 'YYYYMMDD'))
  );

  SELECT 'JE-' || to_char(NEW.transaction_date, 'YYYYMMDD') || '-' ||
         lpad((COALESCE(MAX((substring(entry_number FROM '[0-9]+$'))::integer), 0) + 1)::text, 4, '0')
    INTO v_je_number
    FROM public.journal_entries
   WHERE entry_date = NEW.transaction_date
     AND entry_number LIKE 'JE-' || to_char(NEW.transaction_date, 'YYYYMMDD') || '-%';

  INSERT INTO public.journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, created_by, posted_at
  ) VALUES (
    v_je_number, NEW.transaction_date, 'petty_cash', NEW.id, NEW.transaction_number,
    'Petty cash ' || NEW.transaction_type || ': ' || NEW.description,
    NEW.amount, NEW.amount, true, NEW.created_by, now()
  ) RETURNING id INTO v_journal_id;

  IF NEW.transaction_type = 'withdraw' THEN
    IF NEW.bank_account_id IS NOT NULL THEN
      SELECT coa_id
        INTO v_counter_account
        FROM public.bank_accounts
       WHERE id = NEW.bank_account_id;
    ELSE
      v_counter_account := NEW.source_account_id;
    END IF;

    IF v_counter_account IS NULL THEN
      RAISE EXCEPTION 'Cannot post petty cash inflow %: select a bank or offset GL account', NEW.id;
    END IF;

    IF v_counter_account = v_petty_cash_account THEN
      RAISE EXCEPTION 'Cannot post petty cash inflow %: offset account cannot be the Petty Cash posting account', NEW.id;
    END IF;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES
      (v_journal_id, 1, v_petty_cash_account, NEW.amount, 0, 'Cash received into petty cash'),
      (v_journal_id, 2, v_counter_account, 0, NEW.amount, COALESCE(NULLIF(NEW.source, ''), 'Petty cash inflow source'));

  ELSIF NEW.transaction_type = 'expense' THEN
    -- This is the single canonical expense-category mapping.  It deliberately
    -- does not translate UI labels or embed account codes here.
    v_expense_account := public.get_expense_account_id(NEW.expense_category);

    IF v_expense_account IS NULL THEN
      RAISE EXCEPTION 'Cannot post petty cash expense %: no configured account for category %', NEW.id, NEW.expense_category;
    END IF;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, line_number, account_id, debit, credit, description
    ) VALUES
      (v_journal_id, 1, v_expense_account, NEW.amount, 0, COALESCE(NEW.expense_category, 'General expense')),
      (v_journal_id, 2, v_petty_cash_account, 0, NEW.amount, 'Cash expense');
  ELSE
    RAISE EXCEPTION 'Unsupported petty cash transaction type: %', NEW.transaction_type;
  END IF;

  IF NEW.bank_statement_line_id IS NOT NULL THEN
    UPDATE public.bank_statement_lines
       SET matched_petty_cash_id = NEW.id,
           matched_entry_id = v_journal_id,
           reconciliation_status = 'matched',
           matched_at = now(),
           matched_by = COALESCE(NEW.approved_by, NEW.created_by),
           manually_unlinked = false,
           notes = 'Linked to Petty Cash ' || NEW.transaction_number
     WHERE id = NEW.bank_statement_line_id
       AND bank_account_id = NEW.bank_account_id
       AND matched_expense_id IS NULL
       AND matched_receipt_id IS NULL
       AND matched_fund_transfer_id IS NULL
       AND matched_tax_payment_id IS NULL
       AND (matched_petty_cash_id IS NULL OR matched_petty_cash_id = NEW.id)
       AND (matched_entry_id IS NULL OR matched_entry_id = v_journal_id);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Bank statement line % is unavailable or belongs to another bank account', NEW.bank_statement_line_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_transaction record;
  v_repaired_transactions integer := 0;
  v_repaired_journals integer := 0;
BEGIN
  FOR v_transaction IN
    SELECT DISTINCT ON (pct.id)
      pct.id,
      pct.approved_by,
      pct.approved_at,
      je.id AS journal_entry_id
    FROM public.petty_cash_transactions pct
    JOIN public.journal_entries je
      ON je.reference_id = pct.id
     AND je.source_module = 'petty_cash'
     AND je.is_posted = true
    JOIN public.journal_entry_lines jel
      ON jel.journal_entry_id = je.id
     AND jel.debit > 0
    WHERE pct.approval_status = 'approved'
      AND pct.transaction_type = 'expense'
      AND pct.fund_transfer_id IS NULL
      AND jel.account_id IS DISTINCT FROM public.get_expense_account_id(pct.expense_category)
    ORDER BY pct.id, jel.line_number
  LOOP
    -- Clear the old source journal before re-approving.  The approval trigger
    -- then creates exactly one replacement journal for this source row.
    UPDATE public.bank_statement_lines
       SET matched_entry_id = NULL
     WHERE matched_entry_id = v_transaction.journal_entry_id;

    DELETE FROM public.journal_entry_lines
     WHERE journal_entry_id = v_transaction.journal_entry_id;
    DELETE FROM public.journal_entries
     WHERE id = v_transaction.journal_entry_id;

    UPDATE public.petty_cash_transactions
       SET approval_status = 'pending_approval',
           approved_by = NULL,
           approved_at = NULL
     WHERE id = v_transaction.id;

    UPDATE public.petty_cash_transactions
       SET approval_status = 'approved',
           approved_by = v_transaction.approved_by,
           approved_at = v_transaction.approved_at
     WHERE id = v_transaction.id;

    v_repaired_transactions := v_repaired_transactions + 1;
    v_repaired_journals := v_repaired_journals + 1;
  END LOOP;

  RAISE NOTICE 'Regenerated % Petty Cash journals for % transactions using canonical category accounts',
    v_repaired_journals, v_repaired_transactions;
END;
$$;

NOTIFY pgrst, 'reload schema';
