-- ==============================================================================
-- MIGRATION: 20261102050000_close_historical_landed_cost_and_trading_reconciliation.sql
-- Description: Close historical landed-cost and trading-profit reconciliation across three approved scopes:
--              1. First 20MT FCL NOV 25: Reallocate Rp 19,333,700 BM into cost layers & propagate COGS.
--              2. Jul26 Mix: Align preliminary voucher duty Rp 36,446,575.02 to official BM Rp 37,079,000.00
--                 under billing code 640260805810981, posting Rp 632,424.98 AP clearing & propagating COGS.
--                 Directly linked to expense voucher EXP/26/221 with supplier_id = NULL to prevent
--                 contaminating trade AP subledger of Anzen Exports.
--              3. Pregabalin E0000117/2627: Align cost layer FX rate (17,750) to purchase invoice contractual
--                 rate (18,000), resolving Rp 1,012,500 difference & propagating COGS.
-- Safeguards:
--              - Forward-only, idempotent corrections (safe to rerun with zero drift).
--              - Deterministic system admin posting identity (admin@anzen.com).
--              - Zero deletion or rewriting of historical posted journals.
--              - Automatic reconciliation of GL 1130, cost layers, FIFO COGS, and closing stock valuation.
-- ==============================================================================

DO $$
DECLARE
  v_admin_id uuid;
  v_cogs_id uuid;
  v_inv_id uuid;
  v_ap_id uuid;
  v_period_id uuid;
  v_je_id uuid;
  v_batch_record record;
  v_fcl1_landed numeric;
  v_jul26_duty numeric;
  v_preg_rate numeric;
  v_exp_id uuid := 'c0682356-2f3c-478b-be86-0c07e07c9c5b'::uuid;
BEGIN
  -- 0. Retrieve deterministic admin user identity (Admin User: admin@anzen.com)
  SELECT id INTO v_admin_id 
  FROM public.user_profiles 
  WHERE role = 'admin' AND email = 'admin@anzen.com' AND is_active = true 
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    SELECT id INTO v_admin_id 
    FROM public.user_profiles 
    WHERE role = 'admin' AND is_active = true 
    ORDER BY email ASC 
    LIMIT 1;
  END IF;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Fatal: No active admin user profile found for posting identity';
  END IF;

  SELECT id INTO v_cogs_id FROM public.chart_of_accounts WHERE code = '5100' LIMIT 1;
  SELECT id INTO v_inv_id FROM public.chart_of_accounts WHERE code = '1130' LIMIT 1;
  SELECT id INTO v_ap_id FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;

  SELECT id INTO v_period_id FROM public.accounting_periods 
   WHERE '2026-11-02'::date BETWEEN start_date AND end_date 
   ORDER BY start_date DESC LIMIT 1;

  -- ============================================================================
  -- 1. CORRECTION 1: 1st 20MT FCL NOV 25 (Container: 5f2a79f6-4cd4-4e24-9195-161a6b99cfd5)
  -- ============================================================================
  SELECT COALESCE(SUM(pbcl.landed_cost_amount), 0) INTO v_fcl1_landed
  FROM public.purchase_batch_cost_layers pbcl
  JOIN public.batches b ON b.id = pbcl.batch_id
  WHERE b.import_container_id = '5f2a79f6-4cd4-4e24-9195-161a6b99cfd5';

  IF v_fcl1_landed < 40000000 THEN
    UPDATE public.purchase_batch_cost_layers pbcl
    SET 
      landed_cost_amount = b.import_cost_allocated + b.actual_duty_charges,
      final_functional_unit_cost = ROUND(pbcl.functional_unit_cost + ((b.import_cost_allocated + b.actual_duty_charges) / NULLIF(pbcl.quantity, 0)), 4)
    FROM public.batches b
    WHERE b.id = pbcl.batch_id
      AND b.import_container_id = '5f2a79f6-4cd4-4e24-9195-161a6b99cfd5';

    UPDATE public.batches b
    SET 
      cost_per_unit = pbcl.final_functional_unit_cost,
      landed_cost_per_unit = pbcl.final_functional_unit_cost,
      final_landed_cost = ROUND(pbcl.final_functional_unit_cost * b.import_quantity, 2),
      updated_at = now()
    FROM public.purchase_batch_cost_layers pbcl
    WHERE pbcl.batch_id = b.id
      AND b.import_container_id = '5f2a79f6-4cd4-4e24-9195-161a6b99cfd5';

    FOR v_batch_record IN
      SELECT id FROM public.batches
       WHERE import_container_id = '5f2a79f6-4cd4-4e24-9195-161a6b99cfd5'
         AND actual_duty_charges > 0
    LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_record.id);
    END LOOP;
  END IF;

  -- ============================================================================
  -- 2. CORRECTION 2: Jul26 Mix (Container: aa8ca1d3-0fe9-4c2f-8864-d4c98b430549)
  -- ============================================================================
  SELECT COALESCE(SUM(actual_duty_charges), 0) INTO v_jul26_duty
  FROM public.batches
  WHERE import_container_id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549';

  IF v_jul26_duty < 37000000 THEN
    -- Post forward-only AP clearing journal linked directly to EXP/26/221
    -- supplier_id is set to NULL to prevent polluting the trade AP subledger of Anzen Exports
    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entries 
       WHERE reference_number = 'EXP/26/221-DUTY-ADJ' 
         AND NOT COALESCE(is_reversed, false)
    ) THEN
      INSERT INTO public.journal_entries (
        entry_number, entry_date, period_id, source_module, reference_id, reference_number,
        description, total_debit, total_credit, is_posted, posted_by, created_by
      ) VALUES (
        'JE2611-ADJ-JUL26-DUTY', '2026-11-02', v_period_id, 'customs_duty_adjustment', v_exp_id, 'EXP/26/221-DUTY-ADJ',
        'Customs Duty True-Up: EXP/26/221 alignment to official BM billing code 640260805810981 (Jul26 Mix)',
        632424.98, 632424.98, true, v_admin_id, v_admin_id
      ) RETURNING id INTO v_je_id;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id, line_number, account_id, supplier_id, description, debit, credit
      ) VALUES 
        (v_je_id, 1, v_inv_id, NULL, 'Inventory duty true-up: EXP/26/221 (Billing code 640260805810981)', 632424.98, 0.00),
        (v_je_id, 2, v_ap_id, NULL, 'Customs clearing AP: EXP/26/221 to BSL 00ecc051-1118-471d-b58c-b57ed5525ac7', 0.00, 632424.98);
    END IF;

    UPDATE public.batches b
    SET 
      actual_duty_charges = ROUND((b.actual_duty_charges / 36446575.02) * 37079000.00, 2),
      updated_at = now()
    WHERE b.import_container_id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549';

    UPDATE public.purchase_batch_cost_layers pbcl
    SET 
      landed_cost_amount = b.import_cost_allocated + b.actual_duty_charges,
      final_functional_unit_cost = ROUND(pbcl.functional_unit_cost + ((b.import_cost_allocated + b.actual_duty_charges) / NULLIF(pbcl.quantity, 0)), 4)
    FROM public.batches b
    WHERE b.id = pbcl.batch_id
      AND b.import_container_id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549';

    UPDATE public.batches b
    SET 
      cost_per_unit = pbcl.final_functional_unit_cost,
      landed_cost_per_unit = pbcl.final_functional_unit_cost,
      final_landed_cost = ROUND(pbcl.final_functional_unit_cost * b.import_quantity, 2),
      updated_at = now()
    FROM purchase_batch_cost_layers pbcl
    WHERE pbcl.batch_id = b.id
      AND b.import_container_id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549';

    FOR v_batch_record IN
      SELECT id FROM public.batches
       WHERE import_container_id = 'aa8ca1d3-0fe9-4c2f-8864-d4c98b430549'
    LOOP
      PERFORM public.propagate_batch_cost_change(v_batch_record.id);
    END LOOP;
  END IF;

  -- ============================================================================
  -- 3. CORRECTION 3: Pregabalin E0000117/2627 (Batch: PRGI/B2606008, ID: 68dea860-bbdd-4bf9-b1eb-c41922939776)
  -- ============================================================================
  SELECT COALESCE(exchange_rate, 0) INTO v_preg_rate
  FROM public.purchase_batch_cost_layers
  WHERE batch_id = '68dea860-bbdd-4bf9-b1eb-c41922939776';

  IF v_preg_rate < 18000 THEN
    UPDATE public.purchase_batch_cost_layers
    SET 
      exchange_rate = 18000.0000,
      functional_unit_cost = 729000.00,
      functional_total_cost = 72900000.00,
      final_functional_unit_cost = 1027176.8700
    WHERE batch_id = '68dea860-bbdd-4bf9-b1eb-c41922939776';

    UPDATE public.batches
    SET 
      exchange_rate_usd_to_idr = 18000.0000,
      import_price = 729000.00,
      cost_per_unit = 1027176.87,
      landed_cost_per_unit = 1027176.87,
      final_landed_cost = 102717687.00,
      updated_at = now()
    WHERE id = '68dea860-bbdd-4bf9-b1eb-c41922939776';

    PERFORM public.propagate_batch_cost_change('68dea860-bbdd-4bf9-b1eb-c41922939776'::uuid);
  END IF;

END $$;
