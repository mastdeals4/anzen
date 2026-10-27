-- Customs-broker expenses have one canonical PPh 23 posting path:
-- post_customs_broker_canonical(). Keep the generic synchronizer for all
-- other expense categories, but never add a second broker withholding line.
-- This migration changes function code only; it does not alter historical data.

CREATE OR REPLACE FUNCTION public.trg_sync_expense_pph_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_account_id uuid;
  v_journal_id uuid;
  v_line_number integer;
BEGIN
  IF NEW.expense_category = 'import_broker' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.pph_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  v_account_id := fn_pph_payable_account_id(NEW.pph_code_id);
  IF v_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_journal_id
    FROM journal_entries
   WHERE reference_id = NEW.id
     AND source_module = 'expenses'
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_journal_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM journal_entry_lines
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%'
  ) THEN
    UPDATE journal_entry_lines
       SET account_id = v_account_id
     WHERE journal_entry_id = v_journal_id
       AND debit = 0
       AND description ILIKE 'PPh Ditahan%';
  ELSE
    UPDATE journal_entry_lines
       SET credit = credit - NEW.pph_amount
     WHERE id = (
       SELECT id FROM journal_entry_lines
        WHERE journal_entry_id = v_journal_id
          AND credit >= NEW.pph_amount
        ORDER BY credit DESC, line_number DESC
        LIMIT 1
     );

    SELECT COALESCE(MAX(line_number), 0) + 1 INTO v_line_number
      FROM journal_entry_lines
     WHERE journal_entry_id = v_journal_id;

    INSERT INTO journal_entry_lines
      (journal_entry_id, line_number, account_id, debit, credit, description)
    VALUES
      (v_journal_id, v_line_number, v_account_id, 0, NEW.pph_amount,
       'PPh Ditahan - ' || COALESCE(NEW.description, NEW.voucher_number, 'Expense'));
  END IF;

  UPDATE journal_entries
     SET total_debit = (SELECT COALESCE(SUM(debit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_journal_id),
         total_credit = (SELECT COALESCE(SUM(credit), 0) FROM journal_entry_lines WHERE journal_entry_id = v_journal_id)
   WHERE id = v_journal_id;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_sync_expense_pph_account() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trg_sync_expense_pph_account() TO service_role;

NOTIFY pgrst, 'reload schema';
