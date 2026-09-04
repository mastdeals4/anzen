-- ============================================================================
-- Input PPN — include per-line PPN from finance_expenses.broker_items JSONB
-- ============================================================================
-- Rule of the module: "Tax registers are a derived view of the source
-- documents. There must be one source of truth."
--
-- vw_input_ppn_report (migration 20260706120000_broker_items_supplier_comment)
-- correctly emits one row per broker_items[i] with ppn_amount > 0 (Branch 5)
-- while excluding the same expense's parent-level ppn_amount from Branch 3
-- when broker items own PPN. That view was the source of truth.
--
-- compute_period_ppn() never learned about that Branch-5 world: its PPN
-- branch only sums finance_expenses.ppn_amount (parent-level). So the
-- tax_periods snapshot — which Compliance Centre and the Command Center
-- read for their headline totals — understated Input PPN by exactly the
-- sum of broker-line PPN. Two representations of "the same thing" diverged.
--
-- Fix: extend compute_period_ppn PPN branch to also sum
--   finance_expenses.broker_items[i].ppn_amount
-- via jsonb_array_elements. Same date-range attribution (tax_period_id),
-- same summation, no new storage, no manual sync surface.
--
-- 20260706120000 Branch 3 already prevents double-count by excluding
-- parent ppn_amount when any broker item carries ppn_amount > 0. The
-- compute needs a mirror of that exclusion so it stays symmetric with the
-- view.
--
-- Additive-only, idempotent. Backfills every PPN period at the end.
-- ============================================================================

BEGIN;

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
    -- INPUT PPN — mirrors vw_input_ppn_report exactly:
    --   Branch 1/4  purchase_invoices.tax_amount
    --   Branch 2    (pib_ppn_amount handled below)
    --   Branch 3    parent-level ppn_amount EXCLUDING rows whose broker_items
    --               carry per-line PPN (they contribute via Branch 5 instead)
    --   Branch 5    broker_items[i].ppn_amount from the JSONB array
    --   PIB import  finance_expenses.pib_ppn_amount
    SELECT
      COALESCE((
        SELECT SUM(tax_amount) FROM purchase_invoices
         WHERE tax_period_id = p_period_id AND tax_amount > 0
      ), 0)
      +
      -- Branch 3: parent ppn_amount, excluding expenses whose broker_items
      -- carry per-line PPN (to avoid double-count with Branch 5).
      COALESCE((
        SELECT SUM(fe.ppn_amount)
          FROM finance_expenses fe
         WHERE fe.tax_period_id = p_period_id
           AND fe.ppn_amount > 0
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
              WHERE COALESCE((item->>'ppn_amount')::numeric, 0) > 0
           )
      ), 0)
      +
      -- Branch 5: broker-line PPN from the JSONB array.
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      -- PIB import PPN (added in 20260714160000).
      COALESCE((
        SELECT SUM(pib_ppn_amount) FROM finance_expenses
         WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

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
    -- PPh period — unchanged from 20260713200000. Date-based match, filtered
    -- by pph_code_id → tax_codes.tax_type so PPh21/22/23/4(2)/Unifikasi
    -- totals do not bleed into each other.
    SELECT
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

-- Backfill every PPN period so the corrected sum lands on tax_periods.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods WHERE tax_type = 'PPN' ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
