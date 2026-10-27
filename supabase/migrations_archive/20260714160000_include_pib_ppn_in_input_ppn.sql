-- ============================================================================
-- Input PPN — include PIB import PPN from finance_expenses
-- ============================================================================
-- Root cause:
--   * compute_period_ppn() PPN branch sums finance_expenses.ppn_amount only.
--     PIB import expenses store their PPN component in pib_ppn_amount (a
--     separate column, kept separate because BM / PPN / PPh 22 are a
--     regulated breakdown, not a normal invoice). Result: import PPN
--     credit was silently dropped from Input PPN, understating the
--     creditable balance and inflating Net PPN payable.
--
--   * auto_attribute_finance_expense_tax_period() only fires when
--     ppn_amount OR pph_amount is > 0. A pure PIB import row (pib_ppn_amount
--     > 0, ppn_amount = 0) therefore never received a tax_period_id, so
--     even after the compute fix below, existing rows would still be
--     invisible to the aggregation.
--
-- Fix:
--   1. Extend auto_attribute_finance_expense_tax_period to also fire when
--      pib_ppn_amount > 0 or pib_pph_amount > 0. Existing behaviour is
--      preserved for non-PIB rows.
--   2. Update compute_period_ppn PPN branch to add pib_ppn_amount to the
--      Input PPN sum.
--   3. Backfill: attribute any existing PIB-only rows to their PPN period
--      then recompute every PPN period so tax_periods.input_ppn_total /
--      net_ppn / carry_forward_out reflect the corrected engine.
--
-- Additive-only, idempotent, no schema changes beyond what already exists.
-- ============================================================================

BEGIN;

-- 1. Extend attribution trigger to include PIB columns ------------------------
CREATE OR REPLACE FUNCTION public.auto_attribute_finance_expense_tax_period()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
  v_year int;
  v_month int;
BEGIN
  IF NEW.tax_period_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Fire whenever any PPN- or PPh-carrying column is populated, INCLUDING
  -- the PIB breakdown columns (previously overlooked).
  IF COALESCE(NEW.ppn_amount,     0) <= 0
     AND COALESCE(NEW.pph_amount, 0) <= 0
     AND COALESCE(NEW.pib_ppn_amount, 0) <= 0
     AND COALESCE(NEW.pib_pph_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.expense_date IS NULL THEN
    RETURN NEW;
  END IF;

  v_year  := EXTRACT(YEAR  FROM NEW.expense_date)::int;
  v_month := EXTRACT(MONTH FROM NEW.expense_date)::int;

  SELECT id INTO v_period_id
  FROM tax_periods
  WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';

  IF v_period_id IS NULL THEN
    v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
  END IF;

  NEW.tax_period_id := v_period_id;
  RETURN NEW;
END $$;

-- 2. Extend compute_period_ppn — add pib_ppn_amount to Input PPN --------------
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
    -- INPUT PPN = purchase_invoices.tax_amount
    --          + finance_expenses.ppn_amount        (regular purchases)
    --          + finance_expenses.pib_ppn_amount    (PIB import breakdown)
    SELECT
      COALESCE((SELECT SUM(tax_amount) FROM purchase_invoices
                 WHERE tax_period_id = p_period_id AND tax_amount > 0), 0)
    + COALESCE((SELECT SUM(ppn_amount) FROM finance_expenses
                 WHERE tax_period_id = p_period_id AND ppn_amount > 0), 0)
    + COALESCE((SELECT SUM(pib_ppn_amount) FROM finance_expenses
                 WHERE tax_period_id = p_period_id AND pib_ppn_amount > 0), 0)
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
    -- PPh period — unchanged from 20260713200000_fix_pph_period_computation.
    -- Look up by calendar year+month so all rows for the month attribute
    -- to the correct PPh period regardless of what's in tax_period_id.
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

-- 3. Backfill: attribute PIB-only rows then recompute every PPN period --------
DO $$
DECLARE v_row record; v_period_id uuid; v_year int; v_month int;
BEGIN
  FOR v_row IN
    SELECT id, expense_date
      FROM finance_expenses
     WHERE tax_period_id IS NULL
       AND expense_date IS NOT NULL
       AND (COALESCE(pib_ppn_amount, 0) > 0 OR COALESCE(pib_pph_amount, 0) > 0)
  LOOP
    v_year  := EXTRACT(YEAR  FROM v_row.expense_date)::int;
    v_month := EXTRACT(MONTH FROM v_row.expense_date)::int;
    SELECT id INTO v_period_id
      FROM tax_periods
     WHERE fiscal_year = v_year AND period_month = v_month AND tax_type = 'PPN';
    IF v_period_id IS NULL THEN
      v_period_id := upsert_tax_period(v_year, v_month, 'PPN');
    END IF;
    UPDATE finance_expenses SET tax_period_id = v_period_id WHERE id = v_row.id;
  END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods WHERE tax_type = 'PPN' ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
