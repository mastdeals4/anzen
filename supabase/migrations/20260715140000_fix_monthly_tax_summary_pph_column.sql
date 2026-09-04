-- ============================================================================
-- Fix vw_monthly_tax_summary so the PPh column reflects real PPh periods
-- ============================================================================
-- Problem (found in final tax-module audit):
--   vw_monthly_tax_summary (current def 20260713190000) filtered
--       WHERE tp.tax_type = 'PPN'
--   then did SUM(tp.pph_total). But the engine stores pph_total on the PPh
--   period rows (PPh22/PPh23/PPh4(2)/PPh_Unifikasi), NOT on PPN rows — so the
--   filter excluded every row that actually carries a PPh figure, and the
--   Monthly Summary's PPh column always read 0 even when the PPh Register
--   showed a value. That looks like a broken tax engine to a user.
--
-- Fix:
--   Drop the tax_type filter and aggregate ALL period types per month. This is
--   safe and introduces NO independent calculation: every tax_periods numeric
--   column is NOT NULL DEFAULT 0 (see 20260713140000), and the engine only ever
--   writes PPN columns on PPN periods and pph_total on PPh periods. So:
--     • SUM(input/output/net/cf) still draws only from PPN rows (PPh rows = 0)
--     • SUM(pph_total)          still draws only from PPh rows (PPN rows = 0)
--   The numbers remain verbatim engine snapshots from tax_periods.
--
-- Does NOT touch compute_period_ppn, any table, or column types. Column
-- names/order/types are identical to the prior view, so CREATE OR REPLACE VIEW
-- is safe (no 42P16). Idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.vw_monthly_tax_summary AS
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
GROUP BY tp.fiscal_year, tp.period_month
ORDER BY tp.fiscal_year DESC, tp.period_month DESC;

-- Preserve the RLS-respecting invoker semantics + grant (match sibling views).
ALTER VIEW public.vw_monthly_tax_summary SET (security_invoker = true);
GRANT SELECT ON public.vw_monthly_tax_summary TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
