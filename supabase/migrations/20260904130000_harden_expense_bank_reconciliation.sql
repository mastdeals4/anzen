/*
 * Forward-only safety hardening for expense bank reconciliation.
 * Historical expenses, journals, bank lines, and allocations are untouched.
 */

CREATE OR REPLACE FUNCTION public.expense_recognition_has_direct_bank_settlement(
  p_expense_id uuid,
  p_recognition_journal_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM journal_entry_lines l
      JOIN bank_accounts ba ON ba.coa_id=l.account_id
     WHERE l.journal_entry_id=p_recognition_journal_id
       AND l.credit>0
       AND EXISTS (
         SELECT 1 FROM journal_entries j
          WHERE j.id=p_recognition_journal_id
            AND j.reference_id=p_expense_id
            AND j.source_module IN ('expense','expenses')
            AND j.is_posted AND NOT COALESCE(j.is_reversed,false)
       )
  );
$$;

DO $migration$
DECLARE d text; original text;
BEGIN
  SELECT pg_get_functiondef('public.link_bank_statement_line(uuid,text,uuid,text,numeric)'::regprocedure) INTO d;
  original := d;

  d := regexp_replace(d,
    E'    IF v_expense.approval_status <> ''approved'' THEN\n      RAISE EXCEPTION ''Expense must be approved before bank allocation'';\n    END IF;',
    E'    IF v_expense.approval_status <> ''approved'' THEN\n      RAISE EXCEPTION ''Expense must be approved before bank allocation'';\n    END IF;\n    -- Obligation must exist by the bank transaction date.\n    IF v_line.transaction_date < v_expense.expense_date OR v_line.transaction_date < v_expense.created_at::date THEN\n      RAISE EXCEPTION ''Bank transaction predates expense obligation'';\n    END IF;', '');

  d := regexp_replace(d,
    E'    v_je := v_recognition_je;\n  ELSIF p_document_type=''receipt''',
    E'    v_je := v_recognition_je;\n    IF public.expense_recognition_has_direct_bank_settlement(p_document_id, v_recognition_je) THEN\n      RAISE EXCEPTION ''Expense uses legacy direct-bank recognition; controlled legacy handling is required before reconciliation'';\n    END IF;\n  ELSIF p_document_type=''receipt''', '');

  -- Retrying an already-created allocation must never create another payment JE.
  -- Existing allocation uniqueness and amount guards remain authoritative.
  d := regexp_replace(d,
    E'  IF p_document_type=''expense'' THEN\n    v_rate:=',
    E'  IF p_document_type=''expense'' THEN\n    IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=p_bank_line_id AND a.document_type=''expense'' AND a.document_id=p_document_id AND a.payment_kind=COALESCE(p_payment_kind,''supplier'')) THEN\n      RAISE EXCEPTION ''This expense allocation already exists'';\n    END IF;\n    v_rate:=', '');

  IF d = original THEN
    RAISE EXCEPTION 'Unexpected link_bank_statement_line definition; safety migration not applied';
  END IF;
  EXECUTE d;
END;
$migration$;

COMMENT ON FUNCTION public.expense_recognition_has_direct_bank_settlement(uuid,uuid)
IS 'Detects legacy expense recognition journals that already credit a bank account; used to prevent duplicate settlement postings.';
