-- Bank Reconciliation must select an existing Director/Owner loan ledger.
-- This replaces only the existing save_finance_loan command's director branch:
-- no account, party, ledger, journal, or posting mechanism is created here.
-- `loans.coa_id` remains the established source relationship used by the
-- existing loan journal and loan-repayment journal triggers.

CREATE OR REPLACE FUNCTION public.save_finance_loan(
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_number text;
  v_je uuid;
  v_coa uuid;
  v_line public.bank_statement_lines%ROWTYPE;
  v_amount numeric;
  v_date date;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date := (p_payload->>'loan_date')::date;
  v_amount := (p_payload->>'principal_amount')::numeric;

  IF NULLIF(trim(p_payload->>'counterparty_name'), '') IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Loan counterparty and positive principal are required';
  END IF;

  IF p_payload->>'liability_kind' = 'director_owner' THEN
    -- The UI supplies the existing liability ledger ID selected from the COA.
    -- Do not resolve a code or manufacture a Director/Owner account here.
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE id = NULLIF(p_payload->>'liability_account_id', '')::uuid
      AND is_active = true
      AND COALESCE(is_header, false) = false
      AND lower(account_type) = 'liability';
    IF v_coa IS NULL THEN
      RAISE EXCEPTION 'Select an existing active Director/Owner liability ledger';
    END IF;
    -- When the installation has an existing Director master, ensure its
    -- configured loan ledger is exactly the selected COA. Older ledgers with
    -- no master record remain supported without creating one.
    IF NULLIF(p_payload->>'director_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.directors d
      WHERE d.id = (p_payload->>'director_id')::uuid
        AND d.is_active = true
        AND COALESCE(d.is_deprecated, false) = false
        AND d.loan_account_id = v_coa
    ) THEN
      RAISE EXCEPTION 'Selected Director/Owner is not configured for this loan ledger';
    END IF;
  ELSE
    -- Existing ordinary-loan behaviour is intentionally unchanged.
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE code = '2210' AND is_active = true AND COALESCE(is_header, false) = false
    LIMIT 1;
    IF v_coa IS NULL THEN
      RAISE EXCEPTION 'Required loan liability account is not configured';
    END IF;
  END IF;

  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line
    FROM public.bank_statement_lines
    WHERE id = p_bank_statement_line_id
    FOR UPDATE;

    IF NOT FOUND
      OR COALESCE(v_line.credit_amount, 0) <> v_amount
      OR v_line.bank_account_id <> (p_payload->>'bank_account_id')::uuid THEN
      RAISE EXCEPTION 'Bank statement line does not exactly match this loan';
    END IF;
    IF v_line.matched_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bank statement line is already linked';
    END IF;
  END IF;

  v_number := public.next_loan_number(v_date);
  INSERT INTO public.loans(
    id, loan_number, loan_type, counterparty_name, counterparty_type,
    principal_amount, interest_rate, loan_date, bank_account_id, coa_id,
    currency, transaction_currency, functional_currency, exchange_rate,
    bank_account_currency, description, created_by, bank_statement_line_id
  )
  VALUES (
    v_id, v_number, 'taken', trim(p_payload->>'counterparty_name'),
    COALESCE(NULLIF(p_payload->>'counterparty_type', ''), 'person'),
    v_amount, 0, v_date, (p_payload->>'bank_account_id')::uuid, v_coa,
    upper(p_payload->>'transaction_currency'), upper(p_payload->>'transaction_currency'),
    'IDR', (p_payload->>'exchange_rate')::numeric,
    upper(p_payload->>'transaction_currency'), COALESCE(p_payload->>'description', ''),
    COALESCE(NULLIF(p_payload->>'created_by', '')::uuid, auth.uid()),
    p_bank_statement_line_id
  )
  RETURNING journal_entry_id INTO v_je;

  IF p_bank_statement_line_id IS NOT NULL THEN
    PERFORM public._link_native_bank_document(
      p_bank_statement_line_id,
      v_je,
      'Loan - ' || v_number
    );
  END IF;

  RETURN jsonb_build_object('id', v_id, 'loan_number', v_number, 'journal_entry_id', v_je);
END;
$$;

REVOKE ALL ON FUNCTION public.save_finance_loan(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_finance_loan(jsonb, uuid) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
