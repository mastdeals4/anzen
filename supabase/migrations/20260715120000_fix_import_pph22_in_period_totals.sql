-- ============================================================================
-- Fix PPh period totals = 0 for import PPh 22 (engine gap)
-- ============================================================================
-- Root cause:
--   Import PPh 22 is NOT stored in finance_expenses.pph_amount. It lives in:
--     • pib_import  rows → finance_expenses.pib_pph_amount   (dedicated column)
--     • pph_import  rows → finance_expenses.amount           (whole expense)
--   (See 20260619120000 and vw_pph22_advance_tax_report, which already maps it
--    this exact way.)
--
--   compute_period_ppn's PPh branch only summed fe.pph_amount + pv.pph_amount,
--   so import PPh 22 was invisible → PPh period total = 0 for import-only data.
--   This is the PPh-side twin of the PPN fix in 20260714170000/190000, which
--   added pib_ppn_amount to Input PPN. Here we add import PPh 22 to pph_total.
--
-- Attribution is by expense_date (unchanged for PPh), and import PPh 22 is
-- tax_type 'PPh22', so it only contributes to PPh22 periods and the
-- consolidated PPh_Unifikasi period — never PPh21/23/4(2).
--
-- No double counting: the regular fe.pph_amount branch is restricted to
-- non-import categories; import categories are summed only in the new branch.
--
-- Also re-backfills every PPh period so live totals are corrected immediately.
-- CREATE OR REPLACE keeps the exact signature (RETURNS void). Idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.compute_period_ppn(p_period_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period       tax_periods%ROWTYPE;
  v_input        numeric(18,2);
  v_output_gross numeric(18,2);
  v_output_cn    numeric(18,2);
  v_output       numeric(18,2);
  v_prior_cf     numeric(18,2);
  v_pph_total    numeric(18,2);
BEGIN
  SELECT * INTO v_period FROM tax_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tax period % not found', p_period_id;
  END IF;

  IF v_period.tax_type = 'PPN' THEN
    -- INPUT PPN (unchanged): purchase_invoices + finance_expenses
    -- (regular ppn_amount excluding broker rows) + broker_items[i].ppn_amount
    -- + pib_ppn_amount.
    SELECT
      COALESCE((
        SELECT SUM(tax_amount) FROM purchase_invoices
         WHERE tax_period_id = p_period_id AND tax_amount > 0
      ), 0)
      +
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
      COALESCE((
        SELECT SUM(COALESCE((item->>'ppn_amount')::numeric, 0))
          FROM finance_expenses fe
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
         WHERE fe.tax_period_id = p_period_id
           AND COALESCE((item->>'ppn_amount')::numeric, 0) > 0
      ), 0)
      +
      COALESCE((
        SELECT SUM(pib_ppn_amount) FROM finance_expenses
         WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0
      ), 0)
    INTO v_input;

    -- OUTPUT PPN = gross sales_invoices.tax_amount − approved credit notes.
    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_gross
      FROM sales_invoices
     WHERE tax_period_id = p_period_id AND tax_amount > 0;

    SELECT COALESCE(SUM(tax_amount), 0) INTO v_output_cn
      FROM credit_notes
     WHERE tax_period_id = p_period_id
       AND status = 'approved'
       AND tax_amount > 0;

    v_output := GREATEST(v_output_gross - v_output_cn, 0);

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
    -- PPh period. Three additive sources, all attributed by document date:
    --   (a) finance_expenses.pph_amount  — regular withholding on NON-import
    --       expenses (matched to the period's PPh type via tax_codes).
    --   (b) payment_vouchers.pph_amount  — withholding on vouchers.
    --   (c) IMPORT PPh 22 — pib_import.pib_pph_amount + pph_import.amount.
    --       Always PPh22, so only counted for PPh22 / PPh_Unifikasi periods.
    SELECT
      COALESCE((
        SELECT SUM(fe.pph_amount)
          FROM finance_expenses fe
          LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
         WHERE EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
           AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
           AND fe.pph_amount > 0
           AND COALESCE(fe.expense_category, '') NOT IN ('pib_import', 'pph_import')
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
      +
      CASE WHEN v_period.tax_type IN ('PPh22', 'PPh_Unifikasi') THEN
        -- (c1) PIB single-document import: PPh 22 portion in pib_pph_amount
        COALESCE((
          SELECT SUM(fe.pib_pph_amount)
            FROM finance_expenses fe
           WHERE fe.expense_category = 'pib_import'
             AND EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
             AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
             AND COALESCE(fe.pib_pph_amount, 0) > 0
        ), 0)
        +
        -- (c2) Standalone import PPh 22 expense: whole amount is the tax
        COALESCE((
          SELECT SUM(fe.amount)
            FROM finance_expenses fe
           WHERE fe.expense_category = 'pph_import'
             AND EXTRACT(YEAR  FROM fe.expense_date)::int = v_period.fiscal_year
             AND EXTRACT(MONTH FROM fe.expense_date)::int = v_period.period_month
             AND COALESCE(fe.amount, 0) > 0
        ), 0)
      ELSE 0 END
    INTO v_pph_total;

    UPDATE tax_periods SET
      pph_total  = v_pph_total,
      updated_at = now()
    WHERE id = p_period_id;
  END IF;
END $$;

-- Re-backfill every PPh period with the corrected engine.
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

NOTIFY pgrst, 'reload schema';

COMMIT;
