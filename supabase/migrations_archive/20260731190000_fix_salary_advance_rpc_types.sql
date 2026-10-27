-- Stabilize Salary Advance RPC result types for PostgreSQL/PostgREST callers.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_outstanding_salary_advances(
  p_staff_id uuid,
  p_as_of_date date DEFAULT current_date
)
RETURNS TABLE (
  advance_id uuid,
  voucher_number text,
  voucher_date date,
  staff_id uuid,
  staff_name text,
  amount numeric,
  applied_amount numeric,
  available_amount numeric,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    pv.id,
    pv.voucher_number::text,
    pv.voucher_date,
    pv.staff_id,
    sm.full_name::text,
    pv.amount::numeric,
    COALESCE(sum(sa.applied_amount), 0)::numeric,
    greatest(pv.amount - COALESCE(sum(sa.applied_amount), 0), 0)::numeric,
    (
      CASE
        WHEN COALESCE(sum(sa.applied_amount), 0) >= pv.amount THEN 'settled'
        WHEN COALESCE(sum(sa.applied_amount), 0) > 0 THEN 'partially_settled'
        ELSE 'outstanding'
      END
    )::text
  FROM public.payment_vouchers pv
  JOIN public.finance_staff_master sm ON sm.id = pv.staff_id
  LEFT JOIN public.salary_advance_applications sa
    ON sa.advance_payment_voucher_id = pv.id
  WHERE pv.payment_purpose = 'salary_advance'
    AND pv.is_posted = true
    AND pv.staff_id = p_staff_id
    AND pv.voucher_date <= p_as_of_date
  GROUP BY
    pv.id,
    pv.voucher_number,
    pv.voucher_date,
    pv.staff_id,
    sm.full_name,
    pv.amount
  HAVING pv.amount > COALESCE(sum(sa.applied_amount), 0)
  ORDER BY pv.voucher_date, pv.created_at, pv.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_salary_advance_applications(
  p_salary_expense_id uuid
)
RETURNS TABLE (
  application_id uuid,
  advance_payment_voucher_id uuid,
  advance_voucher_number text,
  salary_expense_id uuid,
  salary_voucher_number text,
  settlement_payment_voucher_id uuid,
  settlement_voucher_number text,
  applied_amount numeric,
  applied_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    sa.id,
    sa.advance_payment_voucher_id,
    advance.voucher_number::text,
    sa.salary_expense_id,
    salary.voucher_number::text,
    sa.settlement_payment_voucher_id,
    settlement.voucher_number::text,
    sa.applied_amount::numeric,
    sa.applied_at
  FROM public.salary_advance_applications sa
  JOIN public.payment_vouchers advance
    ON advance.id = sa.advance_payment_voucher_id
  JOIN public.finance_expenses salary
    ON salary.id = sa.salary_expense_id
  JOIN public.payment_vouchers settlement
    ON settlement.id = sa.settlement_payment_voucher_id
  WHERE sa.salary_expense_id = p_salary_expense_id
  ORDER BY sa.applied_at, sa.id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_outstanding_salary_advances(uuid, date)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_salary_advance_applications(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_outstanding_salary_advances(uuid, date),
  public.get_salary_advance_applications(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
