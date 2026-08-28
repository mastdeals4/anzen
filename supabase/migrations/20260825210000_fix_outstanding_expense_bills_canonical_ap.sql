-- Report-only AP fix: payment method is not a reliable indicator of whether
-- an expense still has an outstanding payable.  The canonical paid_amount
-- (maintained by payment/application flows) determines the residual balance.
CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  id UUID, supplier_id UUID, supplier_name TEXT, staff_id UUID, staff_name TEXT,
  invoice_number TEXT, invoice_date DATE, due_date DATE, expense_category TEXT,
  description TEXT, amount NUMERIC, paid_amount NUMERIC, balance_amount NUMERIC,
  days_overdue INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT fe.id, fe.supplier_id, s.company_name::TEXT, fe.staff_id,
    sm.full_name::TEXT, fe.invoice_number::TEXT, fe.expense_date, fe.due_date,
    fe.expense_category::TEXT, fe.description::TEXT,
    CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable ELSE fe.amount END,
    COALESCE(fe.paid_amount, 0),
    CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable ELSE fe.amount END - COALESCE(fe.paid_amount, 0),
    CASE WHEN fe.due_date IS NOT NULL AND fe.due_date < p_as_of_date
      THEN (p_as_of_date - fe.due_date)::INTEGER ELSE 0 END
  FROM public.finance_expenses fe
  LEFT JOIN public.suppliers s ON s.id = fe.supplier_id
  LEFT JOIN public.finance_staff_master sm ON sm.id = fe.staff_id
  LEFT JOIN public.vw_customs_broker_accounting c ON c.expense_id = fe.id
  WHERE (CASE WHEN fe.expense_category='import_broker' THEN c.final_cash_payable ELSE fe.amount END) > COALESCE(fe.paid_amount, 0)
    AND fe.expense_date <= p_as_of_date
  ORDER BY COALESCE(fe.due_date, fe.expense_date);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(DATE) TO authenticated;
