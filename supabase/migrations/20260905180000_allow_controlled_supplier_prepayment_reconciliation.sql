/*
 * Controlled supplier prepayment support for bank-to-expense reconciliation.
 *
 * Supplier payments may precede the expense business date; they are advances
 * cleared through the existing AP 2110 expense_payment convention. All other
 * chronology and accounting/security guards remain unchanged.
 */
BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_original text;
  v_old text := $old$
    -- Compare business dates only. Same-day and later settlement are valid;
    -- created_at is a technical ingestion timestamp, not an obligation date.
    IF v_expense.expense_date IS NULL THEN
      RAISE EXCEPTION 'Expense business date is required before bank allocation';
    END IF;
    IF v_line.transaction_date < v_expense.expense_date THEN
      RAISE EXCEPTION 'Bank transaction predates expense obligation';
    END IF;$old$;
  v_new text := $new$
    -- Supplier bank debits before the expense date are controlled advances.
    -- They still require an approved expense, matching currency, an outgoing
    -- bank transaction, and the canonical expense_payment (AP 2110 clearing)
    -- journal below. Ordinary settlement keeps the business-date guard.
    IF v_expense.expense_date IS NULL THEN
      RAISE EXCEPTION 'Expense business date is required before bank allocation';
    END IF;
    IF v_line.transaction_date < v_expense.expense_date
       AND (COALESCE(p_payment_kind,'supplier') <> 'supplier'
            OR COALESCE(v_line.debit_amount,0) <= 0) THEN
      RAISE EXCEPTION 'Bank transaction predates expense obligation';
    END IF;$new$;
BEGIN
  SELECT pg_get_functiondef('public.link_bank_statement_line(uuid,text,uuid,text,numeric)'::regprocedure)
    INTO v_definition;
  v_original := v_definition;
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected link_bank_statement_line definition; prepayment guard not found';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  IF v_definition = v_original THEN
    RAISE EXCEPTION 'Prepayment guard replacement made no change';
  END IF;
  EXECUTE v_definition;
END;
$migration$;

COMMENT ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric)
IS 'Canonical bank allocation/payment clearing. Approved supplier bank debits before expense_date are controlled prepayments using AP 2110; all other chronology and accounting guards remain enforced.';

NOTIFY pgrst, 'reload schema';
COMMIT;
