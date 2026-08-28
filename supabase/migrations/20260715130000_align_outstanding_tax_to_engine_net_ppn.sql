-- ============================================================================
-- Align vw_outstanding_tax to the engine's net_ppn (single source of truth)
-- ============================================================================
-- Root cause (found in final tax-module audit):
--   vw_outstanding_tax (defined in 20260713140000) re-derived the PPN period
--   liability inline as:
--       GREATEST(output_ppn_total - input_ppn_total - carry_forward_in
--                - SUM(payments), 0)
--   instead of reading the engine's already-computed tp.net_ppn.
--
--   compute_period_ppn is the ONE source of truth and already stores
--       net_ppn = GREATEST(output_ppn_total - input_ppn_total
--                          - carry_forward_in, 0)
--   (with any excess pushed into carry_forward_out). The inline formula is
--   arithmetically equal today, but it is a SECOND formula for the same figure:
--   if the engine's net_ppn definition ever changes (rounding, how
--   carry_forward_in is applied), this view would silently diverge.
--
--   This is the exact class of divergence 20260714270000 removed from the
--   sibling view vw_ppn_net_by_period. We apply the same alignment here so that
--   the Dashboard cards, Period Close blockers, and the Outstanding Tax report
--   all resolve to tp.net_ppn.
--
-- PPh branch is unchanged: it already reads the engine snapshot tp.pph_total.
--
-- Column names/order/types are identical to the prior definition (only the
-- PPN branch of outstanding_amount changes), so CREATE OR REPLACE VIEW is safe
-- (no 42P16 column-type/position change). Idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.vw_outstanding_tax AS
SELECT
  tp.id                                          AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.tax_type,
  tp.status,
  tp.payment_due_date,
  CASE
    WHEN tp.tax_type = 'PPN' THEN GREATEST(
      -- Read the engine's stored net PPN, then subtract remittances.
      tp.net_ppn
      - COALESCE((SELECT SUM(amount) FROM tax_payments
                  WHERE tax_period_id = tp.id AND status IN ('posted','reconciled')), 0),
      0)
    ELSE GREATEST(
      tp.pph_total
      - COALESCE((SELECT SUM(amount) FROM tax_payments
                  WHERE tax_period_id = tp.id AND status IN ('posted','reconciled')), 0),
      0)
  END                                            AS outstanding_amount
FROM tax_periods tp
WHERE tp.status NOT IN ('paid','closed');

GRANT SELECT ON public.vw_outstanding_tax TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
