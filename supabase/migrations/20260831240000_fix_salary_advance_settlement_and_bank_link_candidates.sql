BEGIN;

-- Salary advances are a settlement of the salary obligation, not a second
-- cash payment. Include posted applications in the same canonical outstanding
-- balance used by Payables and salary-facing views.
CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date date DEFAULT current_date
)
RETURNS TABLE(
  id uuid, supplier_id uuid, supplier_name text, staff_id uuid, staff_name text,
  invoice_number text, invoice_date date, due_date date, expense_category text,
  description text, amount numeric, paid_amount numeric, balance_amount numeric,
  days_overdue integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  WITH payable_documents AS MATERIALIZED (
    SELECT fe.id, fe.supplier_id,
      COALESCE(s.company_name::text,
        CASE WHEN fe.supplier_id IS NULL AND fe.staff_id IS NULL
          THEN NULLIF(regexp_replace(COALESCE(fe.description, ''), '^.*[-–—]\\s*', ''), COALESCE(fe.description, ''))
        END) AS supplier_name,
      fe.staff_id, sm.full_name::text AS staff_name,
      fe.invoice_number::text, fe.expense_date AS invoice_date, fe.due_date,
      fe.expense_category::text, fe.description::text,
      public.calculate_finance_expense_payable(fe.id) AS payable_amount,
      COALESCE((SELECT sum(va.allocated_amount)
        FROM public.voucher_allocations va
        LEFT JOIN public.payment_vouchers pv ON pv.id = va.payment_voucher_id
        WHERE va.finance_expense_id = fe.id
          AND COALESCE(va.payment_kind, 'supplier') = 'supplier'
          AND COALESCE(pv.payment_purpose, 'general') NOT IN ('salary_advance', 'salary_advance_settlement')
          AND (va.payment_voucher_id IS NULL OR pv.is_posted = true)), 0)
      + COALESCE((SELECT sum(a.allocation_amount)
        FROM public.bank_statement_allocations a
        WHERE a.document_type = 'expense' AND a.document_id = fe.id
          AND COALESCE(a.payment_kind, 'supplier') = 'supplier'), 0)
      + COALESCE((SELECT sum(COALESCE(NULLIF(b.debit_amount, 0), b.credit_amount, 0))
        FROM public.bank_statement_lines b
        WHERE b.matched_expense_id = fe.id AND b.payment_kind = 'supplier'
          AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id = b.id)), 0)
      + COALESCE((SELECT sum(sa.applied_amount)
        FROM public.salary_advance_applications sa
        JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
        WHERE sa.salary_expense_id = fe.id AND settlement.is_posted = true), 0) AS allocated_paid_amount
    FROM public.finance_expenses fe
    JOIN public.effective_expense_posting_state eps ON eps.expense_id = fe.id
      AND eps.effective_posting_state IN ('ACTIVE', 'REPLACED')
    LEFT JOIN public.suppliers s ON s.id = fe.supplier_id
    LEFT JOIN public.finance_staff_master sm ON sm.id = fe.staff_id
    WHERE fe.approval_status = 'approved' AND fe.expense_date <= p_as_of_date
      AND EXISTS (SELECT 1 FROM public.journal_entry_lines jel
        JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
        WHERE jel.journal_entry_id = eps.effective_journal_id
          AND coa.code = '2110' AND jel.credit > jel.debit + 0.01)
  ), current_state AS (
    SELECT p.*, LEAST(GREATEST(p.allocated_paid_amount, 0), GREATEST(p.payable_amount, 0)) AS current_paid_amount
    FROM payable_documents p
  )
  SELECT p.id, p.supplier_id, p.supplier_name, p.staff_id, p.staff_name,
    p.invoice_number, p.invoice_date, p.due_date, p.expense_category, p.description,
    p.payable_amount, p.current_paid_amount, p.payable_amount - p.current_paid_amount,
    CASE WHEN p.due_date IS NOT NULL AND p.due_date < p_as_of_date
      THEN (p_as_of_date - p.due_date)::integer ELSE 0 END
  FROM current_state p
  WHERE p.payable_amount > p.current_paid_amount + 0.01
  ORDER BY COALESCE(p.due_date, p.invoice_date), p.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_outstanding_expense_bills(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(date) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
