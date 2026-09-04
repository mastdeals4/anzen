-- ============================================================================
-- Tax Compliance — Settlement recognition + snapshot freshness (2026-07-20)
-- ============================================================================
-- Root-cause consolidation of the tax module. The engine (compute_period_ppn
-- → tax_periods snapshot → vw_* views) already exists; this migration closes
-- the three remaining gaps that made screens disagree:
--
--   ROOT CAUSE 1 — No recompute trigger on finance_expenses.
--     Every other tax-bearing source table (sales_invoices, purchase_invoices,
--     credit_notes, payment_vouchers) has an AFTER trigger that calls
--     recompute_periods_for_date / compute_period_ppn. finance_expenses had
--     NONE, so editing/deleting an expense left tax_periods.{pph_total,
--     input_ppn_total} STALE while the register drill-downs read live
--     finance_expenses. Symptom: "register shows Rp120,000 but No source
--     documents found", and Calendar/Register disagreeing. Fix: add the
--     missing trigger (mirrors trg_recompute_from_purchase_invoice), keyed on
--     expense_date, plus the row's tax_period_id for PPN attribution.
--
--   ROOT CAUSE 2 — Payment status was manual, never derived.
--     tax_periods.status is user-set; Calendar derived "overdue" from it while
--     the Register derived "paid" from tax_payments. Symptom: Paid > 0 yet
--     "Payment Pending"; Calendar "Overdue" vs Register "Paid". Fix: one
--     derived payment_status = f(outstanding, due_date) exposed on every view
--     so Calendar == Register == Period Close == Dashboard. Lifecycle states
--     (filed/closed) are preserved and take precedence.
--
--   ROOT CAUSE 3 — "Paid" side ignored PIB expense settlement.
--     Import PPh 22 is added to the liability (pph_total) but the paid side
--     summed only tax_payments, so a PIB import already paid via
--     Expense → Payment → Bank Reconciliation showed outstanding forever and
--     forced a duplicate Tax Payment. Fix: recognise a SETTLED PIB expense
--     (balance <= 0 AND a matched bank_statement_line exists) as payment of
--     its Import PPh 22, de-duplicated against any Tax Payment via LEAST().
--
-- Scope decisions (confirmed): Import PPN stays an input credit (already nets
-- down net_ppn — untouched here); BM (Bea Masuk) is NOT a tax-register line;
-- "settled" = expense balance <= 0 AND a matched bank line.
--
-- No new tables. No duplicate payment records (LEAST() dedup). Extends the
-- existing SQL-view + trigger architecture only. All idempotent:
-- CREATE OR REPLACE, DROP TRIGGER IF EXISTS. Column names/types/positions of
-- existing view columns are unchanged (new columns are appended), so
-- CREATE OR REPLACE VIEW is safe (no 42P16).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Shared settlement helpers — the ONE place "paid / status / source" is
--    defined. SECURITY INVOKER (default) so they respect the caller's RLS
--    exactly like the inline subqueries they replace.
-- ----------------------------------------------------------------------------

-- Import PPh 22 settled through a paid + bank-reconciled PIB expense, for a
-- given month. Only PPh22 / PPh_Unifikasi periods can carry it (import PPh is
-- always PPh22). Mirrors compute_period_ppn's import branch exactly, but adds
-- the "settled" predicate (balance cleared AND a matched bank line).
CREATE OR REPLACE FUNCTION public.fn_settled_import_pph22(
  p_year int, p_month int, p_tax_type text
) RETURNS numeric
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN p_tax_type IN ('PPh22', 'PPh_Unifikasi') THEN COALESCE((
    SELECT SUM(
      CASE WHEN fe.expense_category = 'pib_import' THEN COALESCE(fe.pib_pph_amount, 0)
           ELSE COALESCE(fe.amount, 0)          -- pph_import: whole amount is the tax
      END)
      FROM finance_expenses fe
     WHERE fe.expense_category IN ('pib_import', 'pph_import')
       AND EXTRACT(YEAR  FROM fe.expense_date)::int = p_year
       AND EXTRACT(MONTH FROM fe.expense_date)::int = p_month
       AND (COALESCE(fe.amount,0) - COALESCE(fe.paid_amount, 0)) <= 0.01   -- fully paid
       AND EXISTS (                                                        -- bank-reconciled
         SELECT 1 FROM bank_statement_lines bsl
          WHERE bsl.matched_expense_id = fe.id
            AND bsl.reconciliation_status IN ('matched', 'recorded'))
  ), 0) ELSE 0 END;
$$;

-- Tax Payments (posted/reconciled) remitted for a period. Period id is already
-- type-specific, so no tax_type filter needed (matches vw_outstanding_tax).
CREATE OR REPLACE FUNCTION public.fn_tax_payments_paid(p_period_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT COALESCE((
    SELECT SUM(amount) FROM tax_payments
     WHERE tax_period_id = p_period_id
       AND status IN ('posted', 'reconciled')
  ), 0);
$$;

-- Single derived payment status. Lifecycle states win; otherwise derived from
-- settlement. This is what makes Calendar == Register == Period Close.
CREATE OR REPLACE FUNCTION public.fn_period_payment_status(
  p_status text, p_outstanding numeric, p_due date
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_status IN ('closed', 'filed')            THEN p_status
    WHEN COALESCE(p_outstanding, 0) <= 0.01         THEN 'paid'
    WHEN p_due IS NOT NULL AND p_due < CURRENT_DATE  THEN 'overdue'
    ELSE 'payment_pending'
  END;
$$;

-- Where the settlement came from (display only; not part of the math).
CREATE OR REPLACE FUNCTION public.fn_period_payment_source(
  p_liability numeric, p_txp numeric, p_imp numeric
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN COALESCE(p_liability, 0) <= 0.01 THEN 'none'
    WHEN LEAST(p_liability, COALESCE(p_txp,0) + COALESCE(p_imp,0)) < p_liability - 0.01 THEN
      CASE WHEN COALESCE(p_txp,0) > 0 OR COALESCE(p_imp,0) > 0 THEN 'partial' ELSE 'unpaid' END
    WHEN COALESCE(p_txp,0) > 0 AND COALESCE(p_imp,0) > 0 THEN 'both'
    WHEN COALESCE(p_imp,0) > 0                            THEN 'pib_expense'
    ELSE 'tax_payment'
  END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_settled_import_pph22(int, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tax_payments_paid(uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_period_payment_status(text, numeric, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_period_payment_source(numeric, numeric, numeric) TO authenticated;

-- ----------------------------------------------------------------------------
-- 1. ROOT CAUSE 1 — recompute trigger on finance_expenses.
--    AFTER INSERT/UPDATE/DELETE, refresh the periods for the expense_date month
--    (covers PPh, which is attributed by expense_date, and PPN periods of that
--    month) plus the explicit tax_period_id (covers PPN attributed to a period
--    whose month differs from expense_date). No write-back to finance_expenses,
--    so no trigger recursion.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_recompute_from_expense()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_periods_for_date(OLD.expense_date);
    IF OLD.tax_period_id IS NOT NULL THEN PERFORM compute_period_ppn(OLD.tax_period_id); END IF;
  ELSE
    PERFORM recompute_periods_for_date(NEW.expense_date);
    IF NEW.tax_period_id IS NOT NULL THEN PERFORM compute_period_ppn(NEW.tax_period_id); END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.expense_date IS DISTINCT FROM OLD.expense_date THEN
        PERFORM recompute_periods_for_date(OLD.expense_date);
      END IF;
      IF OLD.tax_period_id IS NOT NULL
         AND OLD.tax_period_id IS DISTINCT FROM NEW.tax_period_id THEN
        PERFORM compute_period_ppn(OLD.tax_period_id);
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_recompute_expense_period ON public.finance_expenses;
CREATE TRIGGER trg_recompute_expense_period
  AFTER INSERT OR UPDATE OR DELETE ON public.finance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_recompute_from_expense();

-- ----------------------------------------------------------------------------
-- 2. ROOT CAUSE 3 — vw_outstanding_tax becomes the single, settlement-aware
--    source of truth for outstanding. One unified formula for PPN and PPh:
--      liability   = PPN ? net_ppn : pph_total
--      settled     = tax_payments + settled_import_pph22   (imp = 0 for PPN)
--      outstanding = GREATEST(liability - LEAST(liability, settled), 0)
--    LEAST() is the de-dup: Expense settlement + a Tax Payment for the same
--    liability can never drive paid above liability (no double counting).
--    Columns/order/types unchanged → CREATE OR REPLACE is safe.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT
  tp.id                AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.payment_due_date,
  GREATEST(
    (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END)
    - LEAST(
        (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END),
        fn_tax_payments_paid(tp.id)
        + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
      ),
    0)                 AS outstanding_amount
FROM tax_periods tp
WHERE tp.status NOT IN ('paid', 'closed');

ALTER VIEW public.vw_outstanding_tax SET (security_invoker = true);
GRANT SELECT ON public.vw_outstanding_tax TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. ROOT CAUSE 3 + 2 — vw_pph_by_period_type: settlement-aware paid/outstanding
--    (same LEAST de-dup) plus derived payment_status + payment_source appended.
--    Existing columns keep name/type/position; two new columns are appended.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_pph_by_period_type AS
SELECT
  tp.id            AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.pph_total     AS pph_total,
  LEAST(tp.pph_total,
        fn_tax_payments_paid(tp.id)
        + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  )                AS pph_paid_total,
  GREATEST(tp.pph_total - LEAST(tp.pph_total,
        fn_tax_payments_paid(tp.id)
        + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  ), 0)            AS pph_outstanding,
  tp.status,
  tp.payment_due_date,
  tp.filing_due_date,
  -- appended:
  fn_period_payment_status(
    tp.status,
    GREATEST(tp.pph_total - LEAST(tp.pph_total,
          fn_tax_payments_paid(tp.id)
          + fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)), 0),
    tp.payment_due_date
  )                AS payment_status,
  fn_period_payment_source(
    tp.pph_total,
    fn_tax_payments_paid(tp.id),
    fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  )                AS payment_source
FROM tax_periods tp
WHERE tp.tax_type <> 'PPN';

ALTER VIEW public.vw_pph_by_period_type SET (security_invoker = true);
GRANT SELECT ON public.vw_pph_by_period_type TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. ROOT CAUSE 2 — vw_tax_period_status (Calendar + Dashboard source) gains
--    paid_amount / outstanding_amount / payment_status / payment_source so the
--    Calendar stops deriving from the stale manual status. Outstanding is read
--    from the single authority (vw_outstanding_tax); paid/closed periods are
--    absent there → COALESCE 0 → treated as fully paid. Existing columns are
--    unchanged; four columns appended.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_tax_period_status AS
SELECT
  tp.id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.filing_status,
  tp.payment_due_date,
  tp.filing_due_date,
  tp.net_ppn,
  tp.pph_total,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status = 'reconciled') AS reconciled_payments_count,
  (SELECT COUNT(*) FROM tax_payments WHERE tax_period_id = tp.id AND status IN ('draft','posted')) AS unreconciled_payments_count,
  (SELECT COUNT(*) FROM sales_invoices si
     WHERE si.tax_period_id = tp.id
       AND (si.faktur_pajak_number IS NULL OR si.faktur_pajak_number = '')
       AND (si.tax_amount > 0)) AS missing_faktur_count,
  -- appended:
  (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END)
    - COALESCE(ot.outstanding_amount, 0)                       AS paid_amount,
  COALESCE(ot.outstanding_amount, 0)                           AS outstanding_amount,
  fn_period_payment_status(tp.status, COALESCE(ot.outstanding_amount, 0), tp.payment_due_date) AS payment_status,
  fn_period_payment_source(
    (CASE WHEN tp.tax_type = 'PPN' THEN tp.net_ppn ELSE tp.pph_total END),
    fn_tax_payments_paid(tp.id),
    fn_settled_import_pph22(tp.fiscal_year, tp.period_month, tp.tax_type)
  )                                                            AS payment_source
FROM tax_periods tp
LEFT JOIN public.vw_outstanding_tax ot ON ot.tax_period_id = tp.id;

ALTER VIEW public.vw_tax_period_status SET (security_invoker = true);
GRANT SELECT ON public.vw_tax_period_status TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. One-time backfill so every snapshot is fresh immediately (the trigger
--    keeps them fresh from here on). Cheap: one compute per period.
-- ----------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM tax_periods ORDER BY fiscal_year, period_month LOOP
    PERFORM compute_period_ppn(r.id);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
