-- ============================================================================
-- Fix Fund Transfer to Petty Cash Withdrawal & Category Assignment Bug
-- ============================================================================
-- Problem:
-- 1. When creating a Fund Transfer with to_account_type = 'petty_cash',
--    the deferred constraint trigger `trg_validate_petty_cash_transfer_commit`
--    checks that a matching row exists in `petty_cash_transactions(fund_transfer_id)`.
-- 2. However, `create_fund_transfer_with_posting` was missing the INSERT into
--    `petty_cash_transactions`.
-- 3. Furthermore, the trigger `trg_validate_petty_cash_category_assignment`
--    enforced that `expense_category` must not be null on all rows in
--    `petty_cash_transactions`, failing on `transaction_type = 'withdraw'`
--    (since a cash replenishment/withdrawal into the petty cash box is not an expense).
--
-- Solution:
-- 1. Exempt `transaction_type = 'withdraw'` in `validate_expense_category_assignment()`.
-- 2. Restore the canonical `INSERT INTO public.petty_cash_transactions` in
--    `create_fund_transfer_with_posting()`.
-- ============================================================================

BEGIN;

-- 1. Update validate_expense_category_assignment to skip 'withdraw' transactions
CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_category public.expense_categories%ROWTYPE;
  v_coa public.chart_of_accounts%ROWTYPE;
BEGIN
  -- A petty cash withdrawal is a cash replenishment/transfer, not an expense
  IF TG_TABLE_NAME = 'petty_cash_transactions' AND (to_jsonb(NEW) ->> 'transaction_type') = 'withdraw' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.expense_category = 'utilities'
     AND NEW.expense_category = 'utilities' THEN
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.expense_category), '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_category
    FROM public.expense_categories
   WHERE category_key = NEW.expense_category;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category "%" does not exist in Expense Category Master.',
      NEW.expense_category USING ERRCODE = '23514';
  END IF;
  IF NOT v_category.is_active THEN
    RAISE EXCEPTION 'Expense category "%" is inactive.', v_category.name
      USING ERRCODE = '23514';
  END IF;
  IF NOT v_category.is_posting_category THEN
    RAISE EXCEPTION 'Expense category "%" is a grouping category. Select an active posting leaf.',
      v_category.name USING ERRCODE = '23514';
  END IF;
  IF v_category.coa_account_id IS NULL THEN
    RAISE EXCEPTION 'Expense category "%" has no configured Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_coa
    FROM public.chart_of_accounts
   WHERE id = v_category.coa_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category "%" references a missing Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;
  IF NOT v_coa.is_active OR v_coa.is_header THEN
    RAISE EXCEPTION 'Expense category "%" must use an active non-header Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

-- 2. Update create_fund_transfer_with_posting to create the canonical petty cash withdrawal
CREATE OR REPLACE FUNCTION public.create_fund_transfer_with_posting(
  p_transfer_date date,
  p_from_amount numeric,
  p_to_amount numeric,
  p_from_account_type text,
  p_to_account_type text,
  p_description text DEFAULT NULL::text,
  p_from_bank_account_id uuid DEFAULT NULL::uuid,
  p_to_bank_account_id uuid DEFAULT NULL::uuid,
  p_from_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_to_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_exchange_rate numeric DEFAULT NULL::numeric,
  p_created_by uuid DEFAULT NULL::uuid
) RETURNS fund_transfers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
  v_transfer_number text;
  v_transfer public.fund_transfers;
  v_source_account_name text;
BEGIN
  v_user_id := COALESCE(p_created_by, auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_transfer_number := public.generate_fund_transfer_number();

  INSERT INTO public.fund_transfers (
    transfer_number,
    transfer_date,
    amount,
    from_amount,
    to_amount,
    exchange_rate,
    from_account_type,
    to_account_type,
    from_bank_account_id,
    to_bank_account_id,
    from_bank_statement_line_id,
    to_bank_statement_line_id,
    description,
    created_by
  ) VALUES (
    v_transfer_number,
    p_transfer_date,
    p_from_amount,
    p_from_amount,
    p_to_amount,
    p_exchange_rate,
    p_from_account_type,
    p_to_account_type,
    CASE WHEN p_from_account_type = 'bank' THEN p_from_bank_account_id ELSE NULL END,
    CASE WHEN p_to_account_type = 'bank' THEN p_to_bank_account_id ELSE NULL END,
    p_from_bank_statement_line_id,
    p_to_bank_statement_line_id,
    NULLIF(p_description, ''),
    v_user_id
  )
  RETURNING * INTO v_transfer;

  IF v_transfer.to_account_type = 'petty_cash' THEN
    IF v_transfer.from_account_type = 'bank' THEN
      SELECT COALESCE(ba.alias, ba.bank_name, 'Bank')
        INTO v_source_account_name
      FROM public.bank_accounts ba
      WHERE ba.id = v_transfer.from_bank_account_id;
    ELSE
      v_source_account_name := 'Cash on Hand';
    END IF;

    INSERT INTO public.petty_cash_transactions (
      transaction_date,
      transaction_type,
      amount,
      description,
      bank_account_id,
      bank_statement_line_id,
      source,
      fund_transfer_id,
      approval_status,
      created_by
    ) VALUES (
      v_transfer.transfer_date,
      'withdraw',
      v_transfer.to_amount,
      COALESCE(v_transfer.description, 'Fund transfer from ' || COALESCE(v_source_account_name, 'Bank')),
      v_transfer.from_bank_account_id,
      v_transfer.from_bank_statement_line_id,
      'Fund Transfer ' || v_transfer.transfer_number,
      v_transfer.id,
      'approved',
      v_user_id
    )
    ON CONFLICT (fund_transfer_id) WHERE fund_transfer_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN v_transfer;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
