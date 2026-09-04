/*
 * Unify future landed-cost valuation and accounting treatment.
 * Historical rows are not rewritten by this migration.
 */

CREATE OR REPLACE FUNCTION public.is_capitalizable_landed_cost_category(p_category text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(replace(COALESCE(p_category, ''), ' ', '_')) IN (
    'duty_customs', 'duty', 'duty_import',
    'freight_import', 'freight', 'clearing_forwarding',
    'container_handling', 'loading_import', 'port_charges',
    'transport_import', 'import_broker', 'other_import'
  );
$$;

-- The allocator and accounting now share the same explicit category policy.
CREATE OR REPLACE FUNCTION public.calculate_container_landed_cost_pool(p_container_id uuid)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_expenses numeric := 0; v_petty numeric := 0; v_other numeric := 0;
BEGIN
  SELECT COALESCE(other_import_costs,0) INTO v_other FROM import_containers WHERE id=p_container_id;
  SELECT COALESCE(SUM(CASE
    WHEN fe.expense_category='import_broker' THEN
      fe.amount-COALESCE(fe.ppn_amount,0)
      +COALESCE((SELECT SUM(
        CASE WHEN (x->>'invoice_amount_authoritative')::boolean=true THEN (x->>'amount')::numeric
             ELSE COALESCE(NULLIF((x->>'amount')::numeric,0),(x->>'dpp_amount')::numeric+COALESCE((x->>'ppn_amount')::numeric,0)) END
        -COALESCE((x->>'ppn_amount')::numeric,0)) FROM jsonb_array_elements(fe.broker_items) x),0)
      +COALESCE(fe.stamp_duty_amount,0)
    ELSE fe.amount END),0)
    INTO v_expenses
    FROM finance_expenses fe
   WHERE fe.import_container_id=p_container_id
     AND public.is_capitalizable_landed_cost_category(fe.expense_category)
     AND COALESCE(fe.include_in_landed_cost,true);
  SELECT COALESCE(SUM(amount),0) INTO v_petty FROM petty_cash_transactions
   WHERE import_container_id=p_container_id
     AND public.is_capitalizable_landed_cost_category(expense_category)
     AND COALESCE(include_in_landed_cost,true);
  RETURN v_expenses+v_petty+v_other;
END; $$;

-- Keep the existing allocator implementation; only its pool source is changed above.

-- Preserve the existing account map for non-capitalizable categories, while
-- directing only the explicit capitalizable set to Inventory.
DO $migration$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('public.auto_post_expense_accounting()'::regprocedure) INTO d;
  d := replace(d,
    'v_expense_account_id:=public.get_expense_account_id(NEW.expense_category);',
    'v_expense_account_id:=CASE WHEN public.is_capitalizable_landed_cost_category(NEW.expense_category) THEN (SELECT id FROM public.chart_of_accounts WHERE code=''1130'' LIMIT 1) ELSE public.get_expense_account_id(NEW.expense_category) END;');
  IF d = pg_get_functiondef('public.auto_post_expense_accounting()'::regprocedure) THEN
    RAISE EXCEPTION 'Unexpected auto_post_expense_accounting definition';
  END IF;
  EXECUTE d;
END;
$migration$;

-- Broker recognition uses the same policy for service/reimbursement/stamp
-- lines; PPN remains 1150 and PPh remains 2132.
DO $migration$
DECLARE d text;
BEGIN
  SELECT pg_get_functiondef('public.post_customs_broker_canonical()'::regprocedure) INTO d;
  d := replace(d, $$SELECT id INTO v_expense_account FROM public.chart_of_accounts WHERE code='5300' LIMIT 1;$$, $$SELECT id INTO v_expense_account FROM public.chart_of_accounts WHERE code='1130' LIMIT 1;$$);
  d := replace(d, $$SELECT id INTO v_stamp_account     FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;$$, $$SELECT id INTO v_stamp_account     FROM public.chart_of_accounts WHERE code='1130' LIMIT 1;$$);
  EXECUTE d;
END;
$migration$;

COMMENT ON FUNCTION public.is_capitalizable_landed_cost_category(text)
IS 'Authoritative future landed-cost capitalization policy; excludes PPN, PPh, BPOM and operational expenses.';
