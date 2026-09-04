/*
# Add payment_purpose column and create save_payment_voucher_with_purpose RPC

1. Modified Tables
   - `payment_vouchers`: added `payment_purpose` text column (default 'general')
     Tracks whether a payment is a general supplier payment, salary advance, or
     salary advance settlement.

2. New Functions
   - `save_payment_voucher_with_purpose(uuid, jsonb, jsonb, text)`: wrapper around
     `save_payment_voucher_command` that stamps the payment_purpose on the saved
     voucher row.

3. Security
   - EXECUTE granted to authenticated + service_role only.

4. Notes
   - The salary_advance_workflow migration never applied to this database, so
     both the column and the function were missing. This migration adds them
     idempotently.
*/

-- 1. Add the missing column (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'payment_vouchers'
      AND column_name  = 'payment_purpose'
  ) THEN
    ALTER TABLE public.payment_vouchers
      ADD COLUMN payment_purpose text NOT NULL DEFAULT 'general';
  END IF;
END $$;

-- 2. Create / replace the wrapper function
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
    RAISE EXCEPTION 'Unsupported payment purpose: %', p_payment_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(p_voucher_id, p_payload, p_allocations);
  v_id     := (v_result->>'id')::uuid;

  UPDATE public.payment_vouchers
     SET payment_purpose = p_payment_purpose
   WHERE id = v_id;

  RETURN v_result;
END;
$$;

-- 3. Grant access
REVOKE ALL ON FUNCTION public.save_payment_voucher_with_purpose(uuid, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_payment_voucher_with_purpose(uuid, jsonb, jsonb, text)
  TO authenticated, service_role;

-- 4. Force API layer to pick up the new function + column
NOTIFY pgrst, 'reload schema';
