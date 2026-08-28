-- ============================================================================
-- Fix PPh Register showing Rp 0 (2026-07-13)
-- ============================================================================
-- Root cause:
--   auto_attribute_finance_expense_tax_period() always writes the PPN period
--   into finance_expenses.tax_period_id (line 108 of migration 20260713150000).
--   compute_period_ppn() PPh branch filtered WHERE fe.tax_period_id = p_period_id,
--   but no expense ever has a PPh period id — they all point to the PPN period.
--   Result: every PPh period always computed pph_total = 0.
--
-- Fix:
--   Change compute_period_ppn() PPh branch to look up expenses and payment
--   vouchers by (fiscal_year, period_month) date match instead of tax_period_id.
--   The rest of the chain is correct:
--     recompute trigger → recompute_periods_for_date() → compute_period_ppn()
--                      → tax_periods.pph_total → vw_pph_by_period_type → UI
--
-- No schema changes. No new tables. Idempotent (CREATE OR REPLACE).
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Fix compute_period_ppn — PPh branch uses date-based lookup
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period    tax_periods%ROWTYPE;
  v_input     numeric(18,2);
  v_output    numeric(18,2);
  v_prior_cf  numeric(18,2);
  v_pph_total numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- INPUT PPN = purchase_invoices.tax_amount + finance_expenses.ppn_amount
    SELECT COALESCE((SELECT SUM(tax_amount) FROM purchase_invoices
                      WHERE tax_period_id = p_period_id AND tax_amount > 0), 0)
         + COALESCE((SELECT SUM(ppn_amount) FROM finance_expenses
                      WHERE tax_period_id = p_period_id AND ppn_amount > 0), 0)
    INTO v_input;

    -- OUTPUT PPN = sales_invoices.tax_amount
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    -- Carry forward from prior PPN period
    SELECT COALESCE(carry_forward_out, 0) INTO v_prior_cf
      FROM tax_periods
     WHERE tax_type = 'PPN'
       AND (fiscal_year, period_month) < (v_period.fiscal_year, v_period.period_month)
     ORDER BY fiscal_year DESC, period_month DESC
     LIMIT 1;
    v_prior_cf := COALESCE(v_prior_cf, 0);

    UPDATE tax_periods SET
      input_ppn_total   = v_input,
      output_ppn_total  = v_output,
      carry_forward_in  = v_prior_cf,
      net_ppn           = GREATEST(v_output - v_input - v_prior_cf, 0),
      carry_forward_out = GREATEST(v_input + v_prior_cf - v_output, 0),
      updated_at        = now()
    WHERE id = p_period_id;

  ELSE
    -- PPh period — look up by date (year/month) rather than tax_period_id.
    --
    -- WHY: auto_attribute_finance_expense_tax_period always writes the PPN period
    -- into finance_expenses.tax_period_id, so no expense ever has a PPh period id.
    -- Using date-based lookup matches expenses and payment vouchers to the PPh
    -- period for the same calendar month, which is the correct attribution.
    -- The PPh code type filter prevents bleeding across types.

    SELECT
      -- Finance expenses for this calendar month with matching PPh code type
      COALESCE((
        SELECT SUM(fe.pph_amount)
          FROM finance_expenses fe
          LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
         WHERE EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND fe.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
      +
      -- Payment vouchers for this calendar month with matching PPh code type
      COALESCE((
        SELECT SUM(pv.pph_amount)
          FROM payment_vouchers pv
          LEFT JOIN tax_codes tc ON tc.id = pv.pph_code_id
         WHERE EXTRACT(YEAR  FROM pv.voucher_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM pv.voucher_date)::int = v_period.period_month
           AND pv.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
    INTO v_pph_total;

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END $$;

-- ============================================================================
-- 2. Backfill all PPh periods — recompute with corrected logic
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT id FROM tax_periods
    WHERE tax_type <> 'PPN'
    ORDER BY fiscal_year, period_month
  LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

-- ============================================================================
-- 3. Schema cache refresh (harmless if no schema change)
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
