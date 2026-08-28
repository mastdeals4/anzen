-- Salary Advance uses the existing Payment Voucher engine with a staff payee.
-- The legacy payee constraint only allowed suppliers or direct GL accounts.

BEGIN;

ALTER TABLE public.payment_vouchers
  DROP CONSTRAINT IF EXISTS pv_supplier_or_account_required;

ALTER TABLE public.payment_vouchers
  ADD CONSTRAINT pv_supplier_or_account_required
  CHECK (
    supplier_id IS NOT NULL
    OR staff_id IS NOT NULL
    OR coa_account_id IS NOT NULL
  );

CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(
  p_voucher_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT 'general'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_payment_purpose NOT IN (
    'general',
    'salary_advance',
    'salary_advance_settlement'
  ) THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', p_payment_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(
    p_voucher_id,
    p_payload,
    p_allocations
  );
  v_id := (v_result->>'id')::uuid;

  UPDATE public.payment_vouchers
     SET payment_purpose = p_payment_purpose,
         salary_advance_status = CASE p_payment_purpose
           WHEN 'salary_advance' THEN 'outstanding'
           ELSE 'not_applicable'
         END
   WHERE id = v_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.save_payment_voucher_with_purpose(
  uuid,
  jsonb,
  jsonb,
  text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_purpose(
  uuid,
  jsonb,
  jsonb,
  text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
