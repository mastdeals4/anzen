/*
 * Expense/bank reconciliation safety fix.
 *
 * The payable obligation date is the expense's business date.  Technical
 * created_at timestamps are deliberately excluded: delayed data entry must
 * not make a same-day payment appear to predate the obligation.
 * No business rows are rewritten by this migration.
 */
BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_original text;
  v_bad text := $bad$
    -- Obligation must exist by the bank transaction date.
    IF v_line.transaction_date < v_expense.expense_date OR v_line.transaction_date < v_expense.created_at::date THEN
      RAISE EXCEPTION 'Bank transaction predates expense obligation';
    END IF;$bad$;
  v_good text := $good$
    -- Compare business dates only. Same-day and later settlement are valid;
    -- created_at is a technical ingestion timestamp, not an obligation date.
    IF v_expense.expense_date IS NULL THEN
      RAISE EXCEPTION 'Expense business date is required before bank allocation';
    END IF;
    IF v_line.transaction_date < v_expense.expense_date THEN
      RAISE EXCEPTION 'Bank transaction predates expense obligation';
    END IF;$good$;
BEGIN
  SELECT pg_get_functiondef('public.link_bank_statement_line(uuid,text,uuid,text,numeric)'::regprocedure)
    INTO v_definition;
  v_original := v_definition;
  IF position(v_bad IN v_definition) > 0 THEN
    v_definition := replace(v_definition, v_bad, v_good);
  ELSIF position('v_line.transaction_date < v_expense.created_at::date' IN v_definition) > 0 THEN
    v_definition := replace(v_definition,
      'IF v_line.transaction_date < v_expense.expense_date OR v_line.transaction_date < v_expense.created_at::date THEN',
      'IF v_expense.expense_date IS NULL THEN\n      RAISE EXCEPTION ''Expense business date is required before bank allocation'';\n    END IF;\n    IF v_line.transaction_date < v_expense.expense_date THEN');
  END IF;
  IF v_definition = v_original OR position('v_line.transaction_date < v_expense.created_at::date' IN v_definition) > 0 THEN
    RAISE EXCEPTION 'Unexpected link_bank_statement_line definition; obligation-date fix not applied';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

COMMENT ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric)
IS 'Canonical bank allocation/payment clearing. Expense chronology uses expense_date (business obligation date), never created_at.';

NOTIFY pgrst, 'reload schema';
COMMIT;
