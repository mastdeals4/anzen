-- Finance stabilization: Director/Owner loans must use the canonical active
-- Chart of Accounts control account. The previous shared command referenced
-- legacy code 2220, which is not present in the production COA; the approved
-- master account is 2105 - Director Loan – Vijay.

DO $$
DECLARE
  v_canonical_id uuid;
  v_legacy_id uuid;
BEGIN
  SELECT id INTO v_canonical_id
  FROM public.chart_of_accounts
  WHERE code = '2105'
  LIMIT 1;

  SELECT id INTO v_legacy_id
  FROM public.chart_of_accounts
  WHERE code = '2220'
  LIMIT 1;

  -- Older installations created the same Vijay director-loan concept as 2220.
  -- Re-key that existing master row only when 2105 is absent; do not create a
  -- duplicate account or rewrite journal amounts.
  IF v_canonical_id IS NULL AND v_legacy_id IS NOT NULL THEN
    UPDATE public.chart_of_accounts
    SET code = '2105',
        name = 'Director Loan – Vijay',
        account_type = 'liability',
        account_group = 'Loans / Borrowings',
        normal_balance = 'credit',
        is_header = false,
        is_active = true,
        updated_at = now()
    WHERE id = v_legacy_id;
    v_canonical_id := v_legacy_id;
  END IF;

  IF v_canonical_id IS NULL THEN
    RAISE EXCEPTION 'Canonical Director Loan account 2105 is not configured';
  END IF;

  UPDATE public.chart_of_accounts
  SET name = 'Director Loan – Vijay',
      account_type = 'liability',
      account_group = 'Loans / Borrowings',
      normal_balance = 'credit',
      is_header = false,
      is_active = true,
      updated_at = now()
  WHERE id = v_canonical_id;
END $$

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
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE code = '2105' AND is_active = true AND COALESCE(is_header, false) = false
    LIMIT 1;
  ELSE
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE code = '2210' AND is_active = true AND COALESCE(is_header, false) = false
    LIMIT 1;
  END IF;

  IF v_coa IS NULL THEN
    RAISE EXCEPTION 'Required loan liability account is not configured';
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
END $$

REVOKE ALL ON FUNCTION public.save_finance_loan(jsonb, uuid) FROM PUBLIC, anon

GRANT EXECUTE ON FUNCTION public.save_finance_loan(jsonb, uuid) TO authenticated, service_role
