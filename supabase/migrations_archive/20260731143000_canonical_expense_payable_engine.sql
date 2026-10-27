-- One backend payable calculation for ordinary and customs-broker expenses.
CREATE OR REPLACE FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN fe.expense_category = 'import_broker'
      THEN COALESCE((SELECT c.final_cash_payable FROM public.vw_customs_broker_accounting c WHERE c.expense_id=fe.id),0)
    ELSE COALESCE(fe.amount,0)
       + COALESCE(fe.ppn_amount,0)
       - COALESCE(fe.pph_amount,0)
       + COALESCE(fe.stamp_duty_amount,0)
       + CASE WHEN fe.expense_category='utilities' THEN COALESCE(fe.bank_charges_amount,0) ELSE 0 END
  END
  FROM public.finance_expenses fe WHERE fe.id=p_expense_id;
$$;

DROP FUNCTION IF EXISTS public.get_outstanding_expense_bills(date);
CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(p_as_of_date date DEFAULT current_date)
RETURNS TABLE(id uuid,supplier_id uuid,supplier_name text,staff_id uuid,staff_name text,invoice_number text,invoice_date date,due_date date,
  expense_category text,description text,amount numeric,paid_amount numeric,balance_amount numeric,days_overdue integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT fe.id,fe.supplier_id,s.company_name::text,fe.staff_id,sm.full_name::text,fe.invoice_number::text,fe.expense_date,fe.due_date,
    fe.expense_category::text,fe.description::text,
    public.calculate_finance_expense_payable(fe.id),COALESCE(fe.paid_amount,0),
    public.calculate_finance_expense_payable(fe.id)-COALESCE(fe.paid_amount,0),
    CASE WHEN fe.due_date IS NOT NULL AND fe.due_date<p_as_of_date THEN (p_as_of_date-fe.due_date)::integer ELSE 0 END
  FROM public.finance_expenses fe LEFT JOIN public.suppliers s ON s.id=fe.supplier_id
  LEFT JOIN public.finance_staff_master sm ON sm.id=fe.staff_id
  WHERE fe.payment_method IS NULL AND fe.expense_date<=p_as_of_date
    AND public.calculate_finance_expense_payable(fe.id)>COALESCE(fe.paid_amount,0)
  ORDER BY COALESCE(fe.due_date,fe.expense_date);
END; $$;
GRANT EXECUTE ON FUNCTION public.calculate_finance_expense_payable(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(date) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
