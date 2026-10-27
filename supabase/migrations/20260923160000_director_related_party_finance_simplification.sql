-- Migration: 20260923160000_director_related_party_finance_simplification.sql
-- Description:
-- 1. Seed Vijay Lunkad in directors table linking 2105, 3100, 3110.
-- 2. Enhance _link_native_bank_document to preserve full bank_statement_allocations lineage.
-- 3. Backfill allocation entry for LP2609-0001 to resolve historical lineage gap.
-- 4. Create canonical RPC record_director_related_party_bank_transaction.
-- 5. Create helper RPC get_director_related_party_balance_summary.

-- 1. Ensure Vijay Lunkad is in directors table
INSERT INTO public.directors (
  id,
  full_name,
  designation,
  capital_account_id,
  loan_account_id,
  drawings_account_id,
  is_active,
  notes
)
SELECT
  'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'::uuid,
  'Vijay Lunkad',
  'Director / Owner',
  (SELECT id FROM public.chart_of_accounts WHERE code = '3100' AND is_active = true LIMIT 1),
  (SELECT id FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true LIMIT 1),
  (SELECT id FROM public.chart_of_accounts WHERE code = '3110' AND is_active = true LIMIT 1),
  true,
  'Primary Director / Owner'
WHERE NOT EXISTS (
  SELECT 1 FROM public.directors WHERE full_name ILIKE '%Vijay%' AND full_name ILIKE '%Lunkad%'
);

-- 2. Enhance _link_native_bank_document to always record bank_statement_allocations
CREATE OR REPLACE FUNCTION public._link_native_bank_document(p_line_id uuid, p_journal_id uuid, p_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_amount numeric;
  v_created_by uuid;
BEGIN
  UPDATE public.bank_statement_lines
  SET matched_entry_id = p_journal_id,
      reconciliation_status = 'recorded',
      matching_status = 'confirmed',
      matched_at = now(),
      matched_by = COALESCE(auth.uid(), matched_by),
      manually_unlinked = false,
      notes = p_label
  WHERE id = p_line_id
  RETURNING COALESCE(NULLIF(debit_amount, 0), credit_amount, 0), created_by INTO v_amount, v_created_by;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  -- Ensure bank_statement_allocations has an entry for full audit lineage
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = p_line_id AND journal_entry_id = p_journal_id
  ) THEN
    INSERT INTO public.bank_statement_allocations (
      bank_statement_line_id,
      document_type,
      document_id,
      journal_entry_id,
      allocation_amount,
      payment_kind,
      created_by
    ) VALUES (
      p_line_id,
      'journal',
      p_journal_id,
      p_journal_id,
      v_amount,
      'supplier',
      COALESCE(auth.uid(), v_created_by)
    );
  END IF;
END
$function$;

-- 3. Backfill allocation entry for LP2609-0001 (repayment 14 Sep 2026)
INSERT INTO public.bank_statement_allocations (
  bank_statement_line_id,
  document_type,
  document_id,
  journal_entry_id,
  allocation_amount,
  payment_kind,
  created_by
)
SELECT
  '6f9781c2-ea23-443e-b77f-48ce38cdfe35'::uuid,
  'journal',
  '29e57ab0-ac04-42ba-a3a3-9080c41ca7b8'::uuid,
  '29e57ab0-ac04-42ba-a3a3-9080c41ca7b8'::uuid,
  10000000.00,
  'supplier',
  bsl.created_by
FROM public.bank_statement_lines bsl
WHERE bsl.id = '6f9781c2-ea23-443e-b77f-48ce38cdfe35'::uuid
  AND NOT EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = '6f9781c2-ea23-443e-b77f-48ce38cdfe35'::uuid
  );

-- 4. Helper function: get_director_related_party_balance_summary
CREATE OR REPLACE FUNCTION public.get_director_related_party_balance_summary(p_director_name text DEFAULT 'Vijay Lunkad')
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_due_to_director numeric := 0;
  v_due_from_director numeric := 0;
  v_net_position numeric := 0;
  v_active_loans jsonb := '[]'::jsonb;
  v_last_tx_date date;
BEGIN
  -- Due TO Director (Account 2105 - Liability: Credit minus Debit)
  SELECT COALESCE(sum(jel.credit - jel.debit), 0) INTO v_due_to_director
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '2105'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false);

  -- Due FROM Director (Account 1310 - Asset: Debit minus Credit)
  SELECT COALESCE(sum(jel.debit - jel.credit), 0) INTO v_due_from_director
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '1310'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false);

  v_net_position := v_due_to_director - v_due_from_director;

  -- Active loans for this director
  SELECT json_agg(json_build_object(
    'id', l.id,
    'loan_number', l.loan_number,
    'loan_type', l.loan_type,
    'principal_amount', l.principal_amount,
    'outstanding_balance', l.outstanding_balance,
    'currency', l.currency,
    'loan_date', l.loan_date,
    'status', l.status
  )) INTO v_active_loans
  FROM public.loans l
  WHERE l.counterparty_name ILIKE ('%' || trim(p_director_name) || '%')
    AND l.status = 'active';

  -- Last transaction date
  SELECT max(je.entry_date) INTO v_last_tx_date
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code IN ('1310', '2105')
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false);

  RETURN jsonb_build_object(
    'director_name', p_director_name,
    'due_to_director', v_due_to_director,
    'due_from_director', v_due_from_director,
    'net_position', v_net_position,
    'net_status', CASE
      WHEN v_net_position > 0 THEN 'payable'
      WHEN v_net_position < 0 THEN 'receivable'
      ELSE 'settled'
    END,
    'active_loans', COALESCE(v_active_loans, '[]'::jsonb),
    'last_transaction_date', v_last_tx_date
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_director_related_party_balance_summary(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_director_related_party_balance_summary(text) TO authenticated, service_role;

-- 5. Canonical RPC: record_director_related_party_bank_transaction
CREATE OR REPLACE FUNCTION public.record_director_related_party_bank_transaction(
  p_bank_line_id uuid,
  p_director_name text DEFAULT 'Vijay Lunkad',
  p_notes text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE;
  v_is_credit boolean;
  v_amount numeric;
  v_currency text;
  v_rate numeric := 1;
  v_bank_account public.bank_accounts%ROWTYPE;
  v_due_to_director numeric := 0;
  v_due_from_director numeric := 0;
  v_open_loan public.loans%ROWTYPE;
  v_repay_amount numeric;
  v_remaining_amount numeric;
  v_loan_payload jsonb;
  v_repay_payload jsonb;
  v_loan_res jsonb;
  v_repay_res jsonb;
  v_je_id uuid;
  v_result jsonb;
  v_description text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();

  -- 1. Fetch and lock bank statement line
  SELECT * INTO v_line
  FROM public.bank_statement_lines
  WHERE id = p_bank_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  IF v_line.matched_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bank statement line is already linked';
  END IF;

  SELECT * INTO v_bank_account
  FROM public.bank_accounts
  WHERE id = v_line.bank_account_id AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank account not found or inactive';
  END IF;

  v_currency := upper(COALESCE(v_line.currency, v_bank_account.currency, 'IDR'));

  -- Validate direction & amount
  IF COALESCE(v_line.credit_amount, 0) > 0 AND COALESCE(v_line.debit_amount, 0) = 0 THEN
    v_is_credit := true;
    v_amount := v_line.credit_amount;
  ELSIF COALESCE(v_line.debit_amount, 0) > 0 AND COALESCE(v_line.credit_amount, 0) = 0 THEN
    v_is_credit := false;
    v_amount := v_line.debit_amount;
  ELSE
    RAISE EXCEPTION 'Bank statement line must have either a positive debit or positive credit amount';
  END IF;

  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Transaction amount must be greater than zero';
  END IF;

  IF v_currency = 'USD' THEN
    IF v_bank_account.currency <> 'USD' THEN
      RAISE EXCEPTION 'Currency mismatch between line and bank account';
    END IF;
    -- For USD bank account, functional rate must be valid
    v_rate := 1; -- In underlying loans table, IDR is functional
  END IF;

  -- 2. Calculate current GL balances for Director
  -- Due TO Director (Account 2105 - Liability: Credit minus Debit)
  SELECT COALESCE(sum(jel.credit - jel.debit), 0) INTO v_due_to_director
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '2105'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false);

  -- Due FROM Director (Account 1310 - Asset: Debit minus Credit)
  SELECT COALESCE(sum(jel.debit - jel.credit), 0) INTO v_due_from_director
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE coa.code = '1310'
    AND je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false);

  v_description := COALESCE(NULLIF(trim(p_notes), ''), v_line.description, 'Director transaction');

  -- 3. Automatic Purpose & Accounting Direction Execution
  IF v_is_credit THEN
    -- MONEY IN FROM DIRECTOR (Bank Credit: Dr Bank)
    -- If director owes money (1310 > 0), settle 1310 first (Cr 1310).
    IF v_due_from_director > 0 THEN
      -- Find active 'given' loan if one exists
      SELECT * INTO v_open_loan
      FROM public.loans
      WHERE loan_type = 'given'
        AND status = 'active'
        AND outstanding_balance > 0
        AND counterparty_name ILIKE ('%' || trim(p_director_name) || '%')
      ORDER BY loan_date
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        v_repay_amount := LEAST(v_amount, v_open_loan.outstanding_balance);
        v_remaining_amount := v_amount - v_repay_amount;

        v_repay_payload := jsonb_build_object(
          'loan_id', v_open_loan.id,
          'transaction_date', v_line.transaction_date,
          'principal_amount', v_repay_amount,
          'interest_amount', 0,
          'bank_account_id', v_line.bank_account_id,
          'transaction_currency', v_currency,
          'exchange_rate', v_rate,
          'description', 'Settlement of Due from Director - ' || p_director_name
        );

        v_repay_res := public.save_finance_loan_repayment(v_repay_payload, p_bank_line_id);
        v_je_id := (v_repay_res->>'journal_entry_id')::uuid;

        -- If received amount exceeds open loan balance, record excess as new director funding (2105)
        IF v_remaining_amount > 0 THEN
          v_loan_payload := jsonb_build_object(
            'loan_date', v_line.transaction_date,
            'loan_type', 'taken',
            'counterparty_name', p_director_name,
            'counterparty_type', 'person',
            'principal_amount', v_remaining_amount,
            'bank_account_id', v_line.bank_account_id,
            'transaction_currency', v_currency,
            'exchange_rate', v_rate,
            'description', 'Director funding (excess) - ' || p_director_name
          );
          v_loan_res := public.save_finance_loan(v_loan_payload, NULL);
        END IF;

        v_result := jsonb_build_object(
          'action', 'settle_due_from_director',
          'repayment', v_repay_res,
          'journal_entry_id', v_je_id,
          'excess_loan', v_loan_res
        );
      ELSE
        -- No active given loan row, post journal directly to 1310
        v_result := public.save_bank_linked_finance_journal(
          p_bank_line_id,
          'Settlement of Due from Director - ' || p_director_name,
          '1310',
          'debit',
          v_currency,
          v_rate
        );
      END IF;
    ELSE
      -- Director is funding company -> Increase 2105 (Cr 2105)
      v_loan_payload := jsonb_build_object(
        'loan_date', v_line.transaction_date,
        'loan_type', 'taken',
        'counterparty_name', p_director_name,
        'counterparty_type', 'person',
        'principal_amount', v_amount,
        'bank_account_id', v_line.bank_account_id,
        'transaction_currency', v_currency,
        'exchange_rate', v_rate,
        'description', 'Director funding - ' || p_director_name
      );

      v_loan_res := public.save_finance_loan(v_loan_payload, p_bank_line_id);
      v_result := jsonb_build_object(
        'action', 'new_director_funding',
        'loan', v_loan_res,
        'journal_entry_id', (v_loan_res->>'journal_entry_id')::uuid
      );
    END IF;

  ELSE
    -- MONEY OUT TO DIRECTOR (Bank Debit: Cr Bank)
    -- If company owes director (2105 > 0), settle 2105 first (Dr 2105).
    IF v_due_to_director > 0 THEN
      -- Find active 'taken' loan if one exists
      SELECT * INTO v_open_loan
      FROM public.loans
      WHERE loan_type = 'taken'
        AND status = 'active'
        AND outstanding_balance > 0
        AND counterparty_name ILIKE ('%' || trim(p_director_name) || '%')
      ORDER BY loan_date
      LIMIT 1
      FOR UPDATE;

      IF FOUND THEN
        v_repay_amount := LEAST(v_amount, v_open_loan.outstanding_balance);
        v_remaining_amount := v_amount - v_repay_amount;

        v_repay_payload := jsonb_build_object(
          'loan_id', v_open_loan.id,
          'transaction_date', v_line.transaction_date,
          'principal_amount', v_repay_amount,
          'interest_amount', 0,
          'bank_account_id', v_line.bank_account_id,
          'transaction_currency', v_currency,
          'exchange_rate', v_rate,
          'description', 'Settlement of Due to Director - ' || p_director_name
        );

        v_repay_res := public.save_finance_loan_repayment(v_repay_payload, p_bank_line_id);
        v_je_id := (v_repay_res->>'journal_entry_id')::uuid;

        -- If paid amount exceeds open loan balance, record excess as advance to director (1310)
        IF v_remaining_amount > 0 THEN
          v_loan_payload := jsonb_build_object(
            'loan_date', v_line.transaction_date,
            'loan_type', 'given',
            'counterparty_name', p_director_name,
            'counterparty_type', 'person',
            'principal_amount', v_remaining_amount,
            'bank_account_id', v_line.bank_account_id,
            'transaction_currency', v_currency,
            'exchange_rate', v_rate,
            'description', 'Money given to Director (excess) - ' || p_director_name
          );
          v_loan_res := public.save_finance_loan(v_loan_payload, NULL);
        END IF;

        v_result := jsonb_build_object(
          'action', 'settle_due_to_director',
          'repayment', v_repay_res,
          'journal_entry_id', v_je_id,
          'excess_loan', v_loan_res
        );
      ELSE
        -- No active taken loan row, post journal directly to 2105 (e.g. settling petty cash liability)
        v_result := public.save_bank_linked_finance_journal(
          p_bank_line_id,
          'Settlement of Due to Director - ' || p_director_name,
          '2105',
          'credit',
          v_currency,
          v_rate
        );
      END IF;
    ELSE
      -- Company gives money to director -> Increase 1310 (Dr 1310)
      v_loan_payload := jsonb_build_object(
        'loan_date', v_line.transaction_date,
        'loan_type', 'given',
        'counterparty_name', p_director_name,
        'counterparty_type', 'person',
        'principal_amount', v_amount,
        'bank_account_id', v_line.bank_account_id,
        'transaction_currency', v_currency,
        'exchange_rate', v_rate,
        'description', 'Money given to Director - ' || p_director_name
      );

      v_loan_res := public.save_finance_loan(v_loan_payload, p_bank_line_id);
      v_result := jsonb_build_object(
        'action', 'money_given_to_director',
        'loan', v_loan_res,
        'journal_entry_id', (v_loan_res->>'journal_entry_id')::uuid
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'bank_line_id', p_bank_line_id,
    'direction', CASE WHEN v_is_credit THEN 'received_from_director' ELSE 'paid_to_director' END,
    'amount', v_amount,
    'director_name', p_director_name,
    'details', v_result
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_director_related_party_bank_transaction(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_director_related_party_bank_transaction(uuid, text, text) TO authenticated, service_role;
