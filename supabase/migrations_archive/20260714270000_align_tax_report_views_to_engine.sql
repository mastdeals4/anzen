-- ============================================================================
-- Align tax report VIEWS to the accounting engine (single source of truth)
-- ============================================================================
-- Consistency audit finding: two report views re-derived PPN totals with
-- formulas that diverge from compute_period_ppn's stored snapshot, so the
-- same period could show two different numbers on different screens.
--
--   1. vw_ppn_net_by_period
--        WAS:  net_ppn_payable = output - input - carry_forward_in   (no floor)
--              carry_forward_out = GREATEST(input - output, 0)       (ignores cf_in)
--        Engine (compute_period_ppn, 20260714190000) stores:
--              net_ppn           = GREATEST(output - input - cf_in, 0)
--              carry_forward_out = GREATEST(input + cf_in - output, 0)
--        For a credit period (input > output) the view showed a NEGATIVE
--        net payable while the engine stored 0 + carry-forward. Fixed by
--        selecting the engine's stored columns verbatim (tp.net_ppn,
--        tp.carry_forward_out) instead of recomputing them.
--
--   2. vw_output_ppn_report
--        WAS:  per-invoice gross sales_invoices.tax_amount only.
--        Engine nets approved credit_notes.tax_amount from Output PPN
--        (since 20260714190000). The register therefore overstated Output
--        PPN by the approved-credit-note PPN and never reconciled to the
--        period's output_ppn_total. Fixed by appending approved credit
--        notes as negative-PPN rows so the register SUM equals the engine.
--
-- Pure view redefinitions. No table changes, no data changes, idempotent.
--
-- NOTE: uses DROP VIEW + CREATE (not CREATE OR REPLACE). CREATE OR REPLACE
-- cannot change a column's data type (net_ppn_payable numeric -> numeric(18,2))
-- nor insert a column mid-list (document_type), which raises 42P16. Nothing
-- else depends on these two views, so a plain DROP is safe.
-- ============================================================================

BEGIN;

-- ── 1. vw_ppn_net_by_period: read engine snapshot columns verbatim ──────────
DROP VIEW IF EXISTS public.vw_ppn_net_by_period;
CREATE VIEW public.vw_ppn_net_by_period AS
SELECT
  tp.id                AS tax_period_id,
  tp.fiscal_year,
  tp.period_month,
  tp.period_start,
  tp.period_end,
  tp.status,
  tp.filing_status,
  tp.input_ppn_total,
  tp.output_ppn_total,
  tp.carry_forward_in,
  -- Engine-stored values (compute_period_ppn), NOT re-derived here.
  -- net_ppn is GREATEST(output - input - cf_in, 0); expose it under the
  -- name the UI already consumes (net_ppn_payable) so no frontend churn.
  tp.net_ppn                                             AS net_ppn_payable,
  tp.carry_forward_out                                   AS carry_forward_out,
  tp.payment_due_date,
  tp.filing_due_date
FROM tax_periods tp
WHERE tp.tax_type = 'PPN';

ALTER VIEW public.vw_ppn_net_by_period SET (security_invoker = true);
GRANT SELECT ON public.vw_ppn_net_by_period TO authenticated;

COMMENT ON VIEW public.vw_ppn_net_by_period IS
'Net PPN per period. Reads engine-stored tax_periods columns (net_ppn,
carry_forward_out) verbatim so every screen reconciles 100% with
compute_period_ppn. net_ppn_payable is an alias of tax_periods.net_ppn.';

-- ── 2. vw_output_ppn_report: net approved credit notes (matches engine) ─────
-- Column names are preserved exactly (month, invoice_date, invoice_number,
-- customer, customer_npwp, subtotal, ppn_amount, total_amount,
-- payment_status, created_at) so the existing frontend query
-- (.gte('invoice_date',…).order('invoice_date')) keeps working unchanged.
-- A document_type column is added to distinguish the credit-note rows.
DROP VIEW IF EXISTS public.vw_output_ppn_report;
CREATE VIEW public.vw_output_ppn_report AS
-- Sales invoices: positive Output PPN
SELECT
  DATE_TRUNC('month', si.invoice_date) AS month,
  si.invoice_date,
  si.invoice_number,
  'Sales Invoice'                       AS document_type,
  c.company_name                        AS customer,
  c.npwp                                AS customer_npwp,
  si.subtotal,
  si.tax_amount                         AS ppn_amount,
  si.total_amount,
  si.payment_status,
  si.created_at
FROM sales_invoices si
JOIN customers c ON si.customer_id = c.id
WHERE si.tax_amount > 0

UNION ALL

-- Approved credit notes: negative Output PPN (reversal), so the register
-- SUM(ppn_amount) equals the engine's netted output_ppn_total.
SELECT
  DATE_TRUNC('month', cn.credit_note_date) AS month,
  cn.credit_note_date                      AS invoice_date,
  cn.credit_note_number                    AS invoice_number,
  'Credit Note'                            AS document_type,
  c.company_name                           AS customer,
  c.npwp                                   AS customer_npwp,
  -cn.subtotal                             AS subtotal,
  -cn.tax_amount                           AS ppn_amount,
  -cn.total_amount                         AS total_amount,
  NULL                                     AS payment_status,
  cn.created_at
FROM credit_notes cn
JOIN customers c ON cn.customer_id = c.id
WHERE cn.status = 'approved'
  AND cn.tax_amount > 0;

ALTER VIEW public.vw_output_ppn_report SET (security_invoker = true);
GRANT SELECT ON public.vw_output_ppn_report TO authenticated;

COMMENT ON VIEW public.vw_output_ppn_report IS
'Output PPN register. Sales invoices as positive PPN, approved credit notes
as negative PPN, so SUM(ppn_amount) reconciles to the engine-netted
tax_periods.output_ppn_total. Aligned with compute_period_ppn 20260714190000.';

NOTIFY pgrst, 'reload schema';

COMMIT;
