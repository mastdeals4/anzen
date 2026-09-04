-- Expense save and bank reconciliation are separate workflow actions.
-- The former combined RPC used to approve the expense internally, which
-- caused an accountant recording/linking their own pending expense to hit the
-- intentional self-approval guard. Keep the legacy signature available for
-- old clients, but fail explicitly instead of creating a journal or link.
CREATE OR REPLACE FUNCTION public.save_and_link_finance_expense_atomic(
  p_expense_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL,
  p_allocation_amount numeric DEFAULT NULL,
  p_approved_by uuid DEFAULT NULL,
  p_apply_salary_advances boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public._sec_check_finance_role();
  RAISE EXCEPTION 'Expense save and bank linking are separate actions; explicitly approve the expense before reconciliation';
END;
$$;

REVOKE ALL ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
