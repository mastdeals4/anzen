-- Complete the existing Staff Master manual-PPh21 option through the same
-- canonical calculator used by Salary Create/Edit.
BEGIN;

DROP FUNCTION IF EXISTS public.calculate_staff_salary(uuid,date,numeric);
CREATE FUNCTION public.calculate_staff_salary(
  p_staff_id uuid,
  p_salary_date date DEFAULT current_date,
  p_gross_override numeric DEFAULT NULL,
  p_pph21_override numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  v_staff public.finance_staff_master%rowtype;
  v_gross numeric;
  v_advance numeric;
  v_pph21 numeric;
  v_bpjs numeric:=0;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_staff FROM public.finance_staff_master WHERE id=p_staff_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active staff member not found'; END IF;
  v_gross:=COALESCE(p_gross_override,v_staff.monthly_salary,0);
  IF v_gross<0 THEN RAISE EXCEPTION 'Gross salary cannot be negative'; END IF;
  SELECT COALESCE(sum(available_amount),0) INTO v_advance
    FROM public.get_outstanding_salary_advances(p_staff_id,COALESCE(p_salary_date,current_date));
  v_pph21:=CASE
    WHEN NOT v_staff.pph21_applicable THEN 0
    WHEN v_staff.pph21_method='percentage' THEN round(v_gross*v_staff.pph21_percentage/100,2)
    ELSE COALESCE(p_pph21_override,0) END;
  IF v_pph21<0 OR v_pph21>v_gross THEN RAISE EXCEPTION 'PPh21 must be between zero and gross salary'; END IF;
  v_advance:=least(v_advance,greatest(v_gross-v_pph21-v_bpjs,0));
  RETURN jsonb_build_object(
    'staff_id',v_staff.id,'monthly_salary',v_staff.monthly_salary,'salary_type',v_staff.salary_type,
    'gross_salary',v_gross,'outstanding_salary_advances',v_advance,
    'pph21_applicable',v_staff.pph21_applicable,'pph21_method',v_staff.pph21_method,
    'pph21_percentage',v_staff.pph21_percentage,'pph21_amount',v_pph21,
    'bpjs_amount',v_bpjs,'net_salary_payable',greatest(v_gross-v_advance-v_pph21-v_bpjs,0),
    'default_payment_method',v_staff.default_payment_method);
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_staff_salary(uuid,date,numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.calculate_staff_salary(uuid,date,numeric,numeric) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
