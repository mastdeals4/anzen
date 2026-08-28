-- ============================================================================
-- Tax Compliance — Single Accounting Engine (2026-07-13)
-- ============================================================================
-- Architecture audit found six divergences across the module. This migration
-- eliminates all of them so every screen reads from one authoritative engine.
--
-- Divergences fixed:
--
--  1. payment_vouchers.pph_amount was ignored by the PPh engine.
--     PPh withheld on supplier payments (Dr AP, Cr PPh Payable) is a real
--     liability but was not counted in compute_period_ppn or
--     vw_pph_by_period_type. Fix: add tax_period_id to payment_vouchers,
--     auto-attribute on INSERT/UPDATE, extend compute_period_ppn and the view.
--
--  2. vw_pph_by_period_type pph_type JOIN condition was too loose.
--     All PPh types matched ANY pph_amount > 0, so PPh23 rows appeared under
--     PPh21 etc. Fix: join via pph_code_id → tax_codes.tax_type = period.tax_type
--     for finance_expenses, and pv.pph_code_id → tax_codes.tax_type for PVs.
--
--  3. vw_pph_by_period_type "Paid" column used finance_expenses.pph_paid_amount
--     (a manually-updated field) instead of tax_payments amounts. Fix: paid =
--     SUM(tax_payments.amount) for same period+type — same source as the rest.
--
--  4. vw_monthly_tax_summary (legacy) used old expense_category='ppn_import'
--     path, diverging from the tax_period_id engine. Fix: rewrite to read from
--     tax_periods snapshot (input_ppn_total, output_ppn_total, net_ppn) grouped
--     by calendar month. Same data as PPN Periods, collapsed to month.
--
--  5. vw_outstanding_tax for PPh used tax_periods.pph_total snapshot which
--     did not yet include PV PPh (fixed by #1). After this migration the
--     snapshot is authoritative for both finance_expenses + payment_vouchers.
--
--  6. compute_period_ppn (PPh branch) missed payment_vouchers.pph_amount.
--     Fixed: adds PV subquery, triggers PV recompute when a PV is written.
--
-- No existing tables dropped or altered in breaking ways.
-- All ALTER TABLE ADD COLUMN calls are IF NOT EXISTS guarded.
-- All functions use CREATE OR REPLACE. All triggers use DROP IF EXISTS first.
-- NOTIFY pgrst at end to flush PostgREST schema cache.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Add tax_period_id to payment_vouchers
--    Auto-attribute on INSERT/UPDATE (same pattern as finance_expenses trigger).
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='payment_vouchers' AND column_name='tax_period_id') THEN
    ALTER TABLE payment_vouchers
      ADD COLUMN tax_period_id uuid REFERENCES tax_periods(id);
    CREATE INDEX idx_payment_vouchers_tax_period
      ON payment_vouchers(tax_period_id)
      WHERE tax_period_id IS NOT NULL;
  END IF;
END $$;

-- Auto-attribute payment_vouchers → tax_period on INSERT or UPDATE
CREATE OR REPLACE FUNCTION public.auto_attribute_payment_voucher_tax_period()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_period_id uuid;
BEGIN
  -- Only act when PPh is present and tax_period_id not already set
  IF NEW.pph_amount IS NULL OR NEW.pph_amount = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW.tax_period_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Resolve the PPh type from the tax_code
  DECLARE
    v_pph_type text;
  BEGIN
    SELECT tc.tax_type INTO v_pph_type
      FROM tax_codes tc WHERE tc.id = NEW.pph_code_id;
    IF v_pph_type IS NULL OR v_pph_type = 'PPN' THEN
      RETURN NEW; -- Not a PPh code — skip
    END IF;

    v_period_id := upsert_tax_period(
      EXTRACT(YEAR  FROM NEW.voucher_date)::int,
      EXTRACT(MONTH FROM NEW.voucher_date)::int,
      v_pph_type
    );
    NEW.tax_period_id := v_period_id;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_auto_attribute_pv_tax_period ON payment_vouchers;
CREATE TRIGGER trg_auto_attribute_pv_tax_period
  BEFORE INSERT OR UPDATE ON payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.auto_attribute_payment_voucher_tax_period();

-- Backfill existing payment_vouchers that have pph_amount > 0
DO $$
DECLARE v_row record; v_period_id uuid; v_pph_type text;
BEGIN
  FOR v_row IN
    SELECT pv.id, pv.voucher_date, pv.pph_code_id
      FROM payment_vouchers pv
     WHERE pv.pph_amount > 0
       AND pv.tax_period_id IS NULL
       AND pv.pph_code_id IS NOT NULL
  LOOP
    SELECT tc.tax_type INTO v_pph_type FROM tax_codes tc WHERE tc.id = v_row.pph_code_id;
    IF v_pph_type IS NOT NULL AND v_pph_type <> 'PPN' THEN
      v_period_id := upsert_tax_period(
        EXTRACT(YEAR  FROM v_row.voucher_date)::int,
        EXTRACT(MONTH FROM v_row.voucher_date)::int,
        v_pph_type
      );
      UPDATE payment_vouchers SET tax_period_id = v_period_id WHERE id = v_row.id;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 2. Extend enforce_tax_period_lock to payment_vouchers
-- ============================================================================
DROP TRIGGER IF EXISTS trg_lock_payment_vouchers_by_period ON payment_vouchers;
CREATE TRIGGER trg_lock_payment_vouchers_by_period
  BEFORE INSERT OR UPDATE OR DELETE ON payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tax_period_lock();

-- ============================================================================
-- 3. Upgrade compute_period_ppn — include payment_vouchers.pph_amount
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
    -- PPh period — sum finance_expenses AND payment_vouchers, both filtered
    -- by the specific PPh code type so rows don't bleed across types.

    SELECT
      -- Finance expenses: filter via pph_code_id → tax_codes.tax_type
      COALESCE((
        SELECT SUM(fe.pph_amount)
          FROM finance_expenses fe
          LEFT JOIN tax_codes tc ON tc.id = fe.pph_code_id
         WHERE fe.tax_period_id = p_period_id
           AND fe.pph_amount > 0
           AND (v_period.tax_type = 'PPh_Unifikasi' OR tc.tax_type = v_period.tax_type)
      ), 0)
      +
      -- Payment vouchers: filter via pph_code_id → tax_codes.tax_type
      COALESCE((
        SELECT SUM(pv.pph_amount)
          FROM payment_vouchers pv
          LEFT JOIN tax_codes tc ON tc.id = pv.pph_code_id
         WHERE pv.tax_period_id = p_period_id
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
-- 4. Auto-recompute trigger when a payment_voucher is written
-- ============================================================================
CREATE OR REPLACE FUNCTION public.trg_recompute_from_payment_voucher()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.tax_period_id IS NOT NULL THEN
      PERFORM compute_period_ppn(OLD.tax_period_id);
    END IF;
  ELSE
    IF NEW.tax_period_id IS NOT NULL THEN
      PERFORM compute_period_ppn(NEW.tax_period_id);
    END IF;
    IF TG_OP = 'UPDATE'
       AND OLD.tax_period_id IS NOT NULL
       AND OLD.tax_period_id IS DISTINCT FROM NEW.tax_period_id THEN
      PERFORM compute_period_ppn(OLD.tax_period_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_payment_voucher_period ON payment_vouchers;
CREATE TRIGGER trg_recompute_payment_voucher_period
  AFTER INSERT OR UPDATE OR DELETE ON payment_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_payment_voucher();

-- ============================================================================
-- 5. Rebuild vw_pph_by_period_type with correct type filtering + correct
--    "paid" source (tax_payments, not pph_paid_amount).
--
--    PPh total = finance_expenses.pph_amount (filtered by code type)
--              + payment_vouchers.pph_amount (filtered by code type)
--    PPh paid  = SUM(tax_payments.amount WHERE tax_period_id + tax_type match)
--    PPh outstanding = total − paid
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT
  tp.id                                                    AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.pph_total                                             AS pph_total,
  COALESCE((
    SELECT SUM(txp.amount)
      FROM tax_payments txp
     WHERE txp.tax_period_id = tp.id
       AND txp.tax_type = tp.tax_type
       AND txp.status IN ('posted', 'reconciled')
  ), 0)                                                    AS pph_paid_total,
  GREATEST(tp.pph_total - COALESCE((
    SELECT SUM(txp.amount)
      FROM tax_payments txp
     WHERE txp.tax_period_id = tp.id
       AND txp.tax_type = tp.tax_type
       AND txp.status IN ('posted', 'reconciled')
  ), 0), 0)                                                AS pph_outstanding,
  tp.status,
  tp.payment_due_date,
  tp.filing_due_date
FROM tax_periods tp
WHERE tp.tax_type <> 'PPN';

-- ============================================================================
-- 6. Rebuild vw_monthly_tax_summary to read from tax_periods snapshot
--    (same source as PPN Periods, Calendar, Period Close — no more legacy
--    expense_category='ppn_import' path that diverged from the engine).
-- DROP required because the existing view has "month" as timestamptz;
-- the new definition returns text (to_char). CREATE OR REPLACE cannot
-- change column types, so we drop and recreate.
-- ============================================================================
DROP VIEW IF EXISTS public.vw_monthly_tax_summary CASCADE;
CREATE VIEW public.vw_monthly_tax_summary AS
SELECT
  to_char(make_date(tp.fiscal_year, tp.period_month, 1), 'YYYY-MM') AS month,
  tp.fiscal_year,
  tp.period_month,
  SUM(tp.input_ppn_total)                                             AS input_ppn,
  SUM(tp.output_ppn_total)                                            AS output_ppn,
  SUM(tp.net_ppn)                                                     AS net_ppn_payable,
  SUM(tp.carry_forward_in)                                            AS carry_forward_in,
  SUM(tp.carry_forward_out)                                           AS carry_forward_out,
  SUM(tp.pph_total)                                                   AS pph_total
FROM tax_periods tp
WHERE tp.tax_type = 'PPN'
GROUP BY tp.fiscal_year, tp.period_month
ORDER BY tp.fiscal_year DESC, tp.period_month DESC;

-- Restore grants and security_invoker dropped by CASCADE
GRANT SELECT ON public.vw_monthly_tax_summary TO authenticated;
ALTER VIEW public.vw_monthly_tax_summary SET (security_invoker = true);

-- ============================================================================
-- 7. Re-run full snapshot backfill now that PV PPh is attributed
-- ============================================================================
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

-- ============================================================================
-- 8. Schema cache refresh
-- ============================================================================
NOTIFY pgrst, 'reload schema';

COMMIT;
