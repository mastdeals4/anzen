-- 20261104082000_harden_security_definer_functions.sql
-- SAPJ ERP: Security Hardening & Principle of Least Privilege for SECURITY DEFINER Functions
-- 1. Revoke public/anon execute on calculate_finance_expense_payable
-- 2. Revoke public/anon execute on trg_import_containers_ndpbm_sync
-- 3. Add privileged role guard and revoke public/anon on update_container_customs_ndpbm
-- 4. Preserve lookup_login_email for unauthenticated username resolution

-- 1. calculate_finance_expense_payable
REVOKE ALL ON FUNCTION public.calculate_finance_expense_payable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_finance_expense_payable(uuid) TO authenticated, service_role;

-- 2. trg_import_containers_ndpbm_sync
REVOKE ALL ON FUNCTION public.trg_import_containers_ndpbm_sync() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trg_import_containers_ndpbm_sync() TO authenticated, service_role;

-- 3. update_container_customs_ndpbm
CREATE OR REPLACE FUNCTION public.update_container_customs_ndpbm(p_container_id uuid, p_customs_ndpbm_rate numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec record;
  v_batch_total_bm numeric;
  v_batch_unit_bm numeric;
  v_total_calculated_bm numeric := 0;
  v_has_duty_batches boolean := false;
  v_pib record;
BEGIN
  -- Authorization guard for direct invocations:
  -- Allow internal superuser/service_role and trigger execution; require privileged role for direct user calls
  IF session_user NOT IN ('postgres', 'service_role') AND current_user NOT IN ('postgres', 'service_role') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('admin', 'director', 'accounts')
    ) THEN
      RAISE EXCEPTION 'Access Denied: update_container_customs_ndpbm requires admin, director, or accounts authorization';
    END IF;
  END IF;

  -- 1. Update container NDPBM rate
  UPDATE public.import_containers
     SET customs_ndpbm_rate = p_customs_ndpbm_rate,
         updated_at = now()
   WHERE id = p_container_id;

  -- 2. Recalculate BM for each linked batch using:
  -- Foreign Currency Assessable Value * Customs NDPBM FX * Duty Percentage
  -- Rounded up to nearest thousand IDR per official DJBC Bea Cukai billing rules
  FOR v_rec IN
    SELECT b.id,
           b.batch_number,
           b.import_quantity,
           b.import_price_usd,
           COALESCE(b.duty_percent, 0) AS duty_percent
      FROM public.batches b
     WHERE b.import_container_id = p_container_id
  LOOP
    IF COALESCE(v_rec.duty_percent, 0) > 0 AND COALESCE(v_rec.import_price_usd, 0) > 0 THEN
      -- DJBC billing rule: Total BM is rounded up to the nearest thousand IDR
      v_batch_total_bm := CEIL((v_rec.import_price_usd * p_customs_ndpbm_rate * (v_rec.duty_percent / 100.0) * COALESCE(v_rec.import_quantity, 1)) / 1000.0) * 1000.0;
      v_batch_unit_bm := ROUND(v_batch_total_bm / NULLIF(v_rec.import_quantity, 0), 2);
      v_total_calculated_bm := v_total_calculated_bm + v_batch_total_bm;
      v_has_duty_batches := true;

      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(v_rec.import_price_usd * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = v_batch_total_bm,
             estimated_duty_charges = v_batch_total_bm,
             duty_charges = v_batch_unit_bm,
             updated_at = now()
       WHERE id = v_rec.id;
    ELSE
      UPDATE public.batches
         SET customs_ndpbm_rate = p_customs_ndpbm_rate,
             customs_assessable_value_idr = ROUND(COALESCE(v_rec.import_price_usd, 0) * p_customs_ndpbm_rate * COALESCE(v_rec.import_quantity, 1), 2),
             actual_duty_charges = 0.00,
             estimated_duty_charges = 0.00,
             duty_charges = 0.00,
             updated_at = now()
       WHERE id = v_rec.id;
    END IF;
  END LOOP;

  -- 3. Update existing PIB expense pib_bm_amount & total amount
  IF v_has_duty_batches AND v_total_calculated_bm > 0 THEN
    FOR v_pib IN
      SELECT id, pib_ppn_amount, pib_pph_amount
        FROM public.finance_expenses
       WHERE import_container_id = p_container_id
         AND expense_category = 'pib_import'
    LOOP
      UPDATE public.finance_expenses
         SET pib_bm_amount = v_total_calculated_bm,
             amount = v_total_calculated_bm + COALESCE(v_pib.pib_ppn_amount, 0) + COALESCE(v_pib.pib_pph_amount, 0)
       WHERE id = v_pib.id;
    END LOOP;
  END IF;

  -- 4. Reallocate container costs and propagate into layers, inventory, and COGS
  PERFORM public.reallocate_container_costs(p_container_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_container_customs_ndpbm(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_container_customs_ndpbm(uuid, numeric) TO authenticated, service_role;

