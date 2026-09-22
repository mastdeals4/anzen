-- Migration: 20260922210000_loan_accounting_workflow_and_historical_alignment.sql
-- Purpose:
-- 1. Upgrade save_finance_loan to support both 'given' (receivable) and 'taken' (liability) loans,
--    accept user-selected COA accounts, validate debit vs credit based on direction, and remove hardcoded 2210.
-- 2. Upgrade save_finance_loan_repayment to support both 'given' loans (bank credit inflow) and 'taken' loans (bank debit outflow).
-- 3. Idempotently document and ensure the historical September Vijay temporary loan alignment.

BEGIN;

-- 1. Upgrade save_finance_loan
CREATE OR REPLACE FUNCTION public.save_finance_loan(
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
  v_number text;
  v_je uuid;
  v_coa uuid;
  v_line public.bank_statement_lines%ROWTYPE;
  v_amount numeric;
  v_date date;
  v_loan_type text;
  v_counterparty text;
  v_counterparty_type text;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date := (p_payload->>'loan_date')::date;
  v_amount := (p_payload->>'principal_amount')::numeric;
  v_loan_type := COALESCE(NULLIF(p_payload->>'loan_type', ''), 'taken');
  v_counterparty := trim(p_payload->>'counterparty_name');

  IF NULLIF(v_counterparty, '') IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Loan counterparty and positive principal are required';
  END IF;

  -- Resolve counterparty_type
  v_counterparty_type := COALESCE(NULLIF(p_payload->>'counterparty_type', ''), 'person');
  IF v_counterparty_type = 'bank' AND v_counterparty !~* 'bank|bca|mandiri|bni|bri|cimb|danamon|permata|uob' THEN
    v_counterparty_type := 'person';
  END IF;

  -- 1. Account resolution: user-selected coa_id takes top priority
  IF NULLIF(p_payload->>'coa_id', '') IS NOT NULL THEN
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE id = (p_payload->>'coa_id')::uuid
      AND is_active = true
      AND COALESCE(is_header, false) = false;
  ELSIF p_payload->>'liability_kind' = 'director_owner' THEN
    SELECT id INTO v_coa
    FROM public.chart_of_accounts
    WHERE id = NULLIF(p_payload->>'liability_account_id', '')::uuid
      AND is_active = true
      AND COALESCE(is_header, false) = false
      AND lower(account_type) = 'liability';
  END IF;

  -- Fallback if no coa was provided
  IF v_coa IS NULL THEN
    IF v_loan_type = 'given' THEN
      SELECT id INTO v_coa FROM public.chart_of_accounts WHERE code = '1310' AND is_active = true LIMIT 1;
    ELSE
      -- loan taken
      IF v_counterparty_type = 'person' THEN
        SELECT id INTO v_coa FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true LIMIT 1;
      ELSE
        SELECT id INTO v_coa FROM public.chart_of_accounts WHERE code = '2210' AND is_active = true LIMIT 1;
      END IF;
    END IF;
  END IF;

  IF v_coa IS NULL THEN
    RAISE EXCEPTION 'Required loan control account is not configured';
  END IF;

  -- 2. Validate Bank Statement Line based on direction
  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line
    FROM public.bank_statement_lines
    WHERE id = p_bank_statement_line_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bank statement line not found';
    END IF;

    IF v_loan_type = 'given' THEN
      IF COALESCE(v_line.debit_amount, 0) <> v_amount THEN
        RAISE EXCEPTION 'Bank statement line debit amount (%) does not match loan amount (%)', v_line.debit_amount, v_amount;
      END IF;
    ELSE
      IF COALESCE(v_line.credit_amount, 0) <> v_amount THEN
        RAISE EXCEPTION 'Bank statement line credit amount (%) does not match loan amount (%)', v_line.credit_amount, v_amount;
      END IF;
    END IF;

    IF v_line.bank_account_id <> (p_payload->>'bank_account_id')::uuid THEN
      RAISE EXCEPTION 'Bank account mismatch on bank statement line';
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
    v_id, v_number, v_loan_type, v_counterparty,
    v_counterparty_type,
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
$function$;

-- 2. Upgrade save_finance_loan_repayment
CREATE OR REPLACE FUNCTION public.save_finance_loan_repayment(
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := gen_random_uuid();
  v_number text;
  v_je uuid;
  v_line public.bank_statement_lines%ROWTYPE;
  v_amount numeric;
  v_date date;
  v_loan public.loans%ROWTYPE;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_date := (p_payload->>'transaction_date')::date;
  v_amount := COALESCE((p_payload->>'principal_amount')::numeric, 0) + COALESCE((p_payload->>'interest_amount')::numeric, 0);

  SELECT * INTO v_loan FROM public.loans WHERE id = (p_payload->>'loan_id')::uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Loan not found';
  END IF;

  IF p_bank_statement_line_id IS NOT NULL THEN
    SELECT * INTO v_line FROM public.bank_statement_lines WHERE id = p_bank_statement_line_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Bank statement line not found';
    END IF;

    -- For loan taken (borrowing): repayment is a bank DEBIT (cash outflow)
    -- For loan given (receivable): repayment is a bank CREDIT (cash inflow)
    IF v_loan.loan_type = 'given' THEN
      IF COALESCE(v_line.credit_amount, 0) <> v_amount THEN
        RAISE EXCEPTION 'Bank statement line credit (%) does not match repayment amount (%)', v_line.credit_amount, v_amount;
      END IF;
    ELSE
      IF COALESCE(v_line.debit_amount, 0) <> v_amount THEN
        RAISE EXCEPTION 'Bank statement line debit (%) does not match repayment amount (%)', v_line.debit_amount, v_amount;
      END IF;
    END IF;

    IF v_line.bank_account_id <> (p_payload->>'bank_account_id')::uuid THEN
      RAISE EXCEPTION 'Bank account mismatch on bank statement line';
    END IF;

    IF v_line.matched_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Bank statement line is already linked';
    END IF;
  END IF;

  v_number := public.next_loan_transaction_number(v_date);
  INSERT INTO public.loan_transactions(
    id, transaction_number, loan_id, transaction_type, transaction_date,
    amount, principal_amount, interest_amount,
    bank_account_id, bank_statement_line_id, description, created_by,
    transaction_currency, functional_currency, exchange_rate, bank_account_currency
  )
  VALUES (
    v_id, v_number, v_loan.id, 'repayment', v_date,
    v_amount, (p_payload->>'principal_amount')::numeric,
    COALESCE((p_payload->>'interest_amount')::numeric, 0),
    (p_payload->>'bank_account_id')::uuid, p_bank_statement_line_id,
    COALESCE(p_payload->>'description', ''),
    COALESCE(NULLIF(p_payload->>'created_by', '')::uuid, auth.uid()),
    upper(p_payload->>'transaction_currency'), 'IDR',
    (p_payload->>'exchange_rate')::numeric, upper(p_payload->>'transaction_currency')
  )
  RETURNING journal_entry_id INTO v_je;

  IF p_bank_statement_line_id IS NOT NULL THEN
    PERFORM public._link_native_bank_document(
      p_bank_statement_line_id,
      v_je,
      'Loan Repayment - ' || v_number
    );
  END IF;

  RETURN jsonb_build_object('id', v_id, 'transaction_number', v_number, 'journal_entry_id', v_je);
END;
$function$;

-- 3. Idempotent check for September Vijay temporary loan (ensures live state matches canonical model)
DO $$
DECLARE
  v_coa_1310 uuid;
BEGIN
  SELECT id INTO v_coa_1310 FROM chart_of_accounts WHERE code = '1310' AND is_active = true LIMIT 1;
  IF v_coa_1310 IS NOT NULL THEN
    UPDATE loans
    SET loan_type = 'given',
        coa_id = v_coa_1310,
        counterparty_name = 'Vijay Lunkad',
        counterparty_type = 'person',
        outstanding_balance = 0.00,
        status = 'closed'
    WHERE loan_number = 'LN2609-0001'
      AND (loan_type <> 'given' OR coa_id <> v_coa_1310 OR status <> 'closed');
  END IF;
END $$;

COMMIT;
