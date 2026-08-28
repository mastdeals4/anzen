-- Finance V1 release blockers:
-- 1. Remove anonymous/PUBLIC execution from privileged finance functions.
-- 2. Validate canonical currency metadata constraints.
-- 3. Remove default-argument ambiguity from reporting RPC overloads.
--
-- This migration does not alter accounting data or journal amounts.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      p.oid,
      p.oid::regprocedure AS function_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (
        p.proname ~* '(finance|journal|payment|receipt|expense|tax|ppn|pph|ledger|balance|trial|customs_broker|faktur|bank_statement|fund_transfer|petty_cash|salary|loan|credit_note|purchase_invoice|sales_invoice)'
        OR pg_get_functiondef(p.oid) ~* '(finance_expenses|journal_entries|journal_entry_lines|payment_vouchers|receipt_vouchers|tax_periods|tax_payments|bank_statement_lines|fund_transfers|petty_cash_transactions|salary_advances)'
      )
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon',
      r.function_signature
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role',
      r.function_signature
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (
        p.proname ~* '(finance|journal|payment|receipt|expense|tax|ppn|pph|ledger|balance|trial|customs_broker|faktur|bank_statement|fund_transfer|petty_cash|salary|loan|credit_note|purchase_invoice|sales_invoice)'
        OR pg_get_functiondef(p.oid) ~* '(finance_expenses|journal_entries|journal_entry_lines|payment_vouchers|receipt_vouchers|tax_periods|tax_payments|bank_statement_lines|fund_transfers|petty_cash_transactions|salary_advances)'
      )
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'Finance SECURITY DEFINER functions remain executable by anon';
  END IF;
END;
$$;

DO $$
DECLARE
  v_two_arg_definition text;
  v_three_arg_definition text;
BEGIN
  SELECT pg_get_functiondef('public.get_trial_balance(date,date)'::regprocedure)
    INTO v_two_arg_definition;
  SELECT pg_get_functiondef('public.get_trial_balance(date,date,numeric)'::regprocedure)
    INTO v_three_arg_definition;

  v_three_arg_definition := regexp_replace(
    v_three_arg_definition,
    'p_usd_rate numeric DEFAULT [^,)]+',
    'p_usd_rate numeric',
    'i'
  );

  DROP FUNCTION public.get_trial_balance(date, date);
  DROP FUNCTION public.get_trial_balance(date, date, numeric);
  EXECUTE v_three_arg_definition;
  EXECUTE v_two_arg_definition;
END;
$$;

DO $$
DECLARE
  v_one_arg_definition text;
  v_two_arg_definition text;
BEGIN
  SELECT pg_get_functiondef('public.get_balance_sheet(date)'::regprocedure)
    INTO v_one_arg_definition;
  SELECT pg_get_functiondef('public.get_balance_sheet(date,numeric)'::regprocedure)
    INTO v_two_arg_definition;

  v_two_arg_definition := regexp_replace(
    v_two_arg_definition,
    'p_usd_rate numeric DEFAULT [^,)]+',
    'p_usd_rate numeric',
    'i'
  );

  DROP FUNCTION public.get_balance_sheet(date);
  DROP FUNCTION public.get_balance_sheet(date, numeric);
  EXECUTE v_two_arg_definition;
  EXECUTE v_one_arg_definition;
END;
$$;

ALTER TABLE public.finance_expenses
  VALIDATE CONSTRAINT finance_expenses_currency_metadata_check;

ALTER TABLE public.payment_vouchers
  VALIDATE CONSTRAINT payment_vouchers_currency_metadata_check;

ALTER TABLE public.receipt_vouchers
  VALIDATE CONSTRAINT receipt_vouchers_currency_metadata_check;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_currency_metadata_check;

ALTER TABLE public.journal_entry_lines
  VALIDATE CONSTRAINT journal_entry_lines_currency_metadata_check;

REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pnl_summary(date, date)
  FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_pnl_summary(date, date, numeric)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_trial_balance(date, date, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_balance_sheet(date, numeric)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pnl_summary(date, date)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pnl_summary(date, date, numeric)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
