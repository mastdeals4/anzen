-- The wrapper function save_payment_voucher_with_purpose was missing from the
-- database. It wraps save_payment_voucher_command and stamps payment_purpose.
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(
  p_voucher_id      uuid   DEFAULT NULL,
  p_payload         jsonb  DEFAULT '{}'::jsonb,
  p_allocations     jsonb  DEFAULT '[]'::jsonb,
  p_payment_purpose text   DEFAULT 'general'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_id     uuid;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_payment_purpose NOT IN ('general', 'salary_advance', 'salary_advance_settlement') THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', p_payment_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(p_voucher_id, p_payload, p_allocations);
  v_id     := (v_result->>'id')::uuid;

  UPDATE public.payment_vouchers
     SET payment_purpose = p_payment_purpose
   WHERE id = v_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_purpose(uuid, jsonb, jsonb, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
