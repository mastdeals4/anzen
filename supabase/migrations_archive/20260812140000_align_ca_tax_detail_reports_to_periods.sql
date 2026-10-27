-- CA/Tax reporting-layer alignment only.
--
-- Accounting amounts remain journal-native. Source documents provide the
-- explicit Tax Compliance period attribution used by monthly CA exports.
-- No source transaction, journal, tax payment or historical row is changed.

BEGIN;

CREATE OR REPLACE VIEW public.vw_input_ppn_report AS
WITH tax_lines AS (
  SELECT je.id AS journal_id, je.entry_date, je.source_module, je.reference_id,
    je.reference_number, je.description, je.created_at, je.total_debit,
    SUM(jel.debit - jel.credit) AS ppn_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND coa.code = '1150'
  GROUP BY je.id
  HAVING SUM(jel.debit - jel.credit) > 0
)
SELECT
  date_trunc('month', t.entry_date::timestamptz) AS month,
  t.entry_date AS expense_date,
  CASE
    WHEN t.source_module = 'purchase_invoice' THEN 'Purchase Invoice'
    WHEN fe.expense_category = 'pib_import' THEN 'PIB Import'
    WHEN fe.expense_category = 'ppn_import' THEN 'PPN Import (Legacy)'
    ELSE 'Supplier Invoice'
  END::text AS document_type,
  COALESCE(pi.invoice_number, fe.invoice_number, fe.voucher_number,
    t.reference_number, t.journal_id::text)::varchar AS reference,
  COALESCE(s.company_name, '-')::varchar AS supplier,
  COALESCE(s.npwp, '-')::varchar AS supplier_npwp,
  CASE WHEN fe.expense_category = 'import_broker' THEN
    COALESCE(fe.dpp_amount, 0) + COALESCE((
      SELECT SUM(COALESCE(NULLIF(item->>'dpp_amount', '')::numeric, 0))
      FROM jsonb_array_elements(COALESCE(fe.broker_items, '[]'::jsonb)) item
    ), 0)
  ELSE GREATEST(t.total_debit - t.ppn_amount, 0) END::numeric AS dpp_amount,
  t.ppn_amount::numeric AS ppn_amount,
  COALESCE(fe.description, pi.notes, t.description)::text AS description,
  t.created_at,
  COALESCE(fe.tax_period_id, pi.tax_period_id, date_period.id) AS tax_period_id
FROM tax_lines t
LEFT JOIN public.finance_expenses fe
  ON t.source_module IN ('expense', 'expenses') AND fe.id = t.reference_id
LEFT JOIN public.purchase_invoices pi
  ON t.source_module = 'purchase_invoice' AND pi.id = t.reference_id
LEFT JOIN public.suppliers s ON s.id = COALESCE(fe.supplier_id, pi.supplier_id)
LEFT JOIN public.tax_periods date_period
  ON date_period.tax_type = 'PPN'
 AND t.entry_date BETWEEN date_period.period_start AND date_period.period_end
ORDER BY t.entry_date DESC;

CREATE OR REPLACE VIEW public.vw_output_ppn_report AS
WITH tax_lines AS (
  SELECT je.id AS journal_id, je.entry_date, je.source_module, je.reference_id,
    je.reference_number, je.description, je.created_at, je.total_credit,
    SUM(jel.credit - jel.debit) AS ppn_amount
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND coa.code = '2130'
  GROUP BY je.id
  HAVING SUM(jel.credit - jel.debit) > 0
)
SELECT
  date_trunc('month', t.entry_date::timestamptz) AS month,
  t.entry_date AS invoice_date,
  COALESCE(si.invoice_number, t.reference_number, t.journal_id::text)::text AS invoice_number,
  CASE WHEN t.source_module = 'correction' THEN 'Correction' ELSE 'Sales Invoice' END::text AS document_type,
  COALESCE(c.company_name, '-')::text AS customer,
  COALESCE(c.npwp, '-')::text AS customer_npwp,
  GREATEST(t.total_credit - t.ppn_amount, 0)::numeric AS subtotal,
  t.ppn_amount::numeric AS ppn_amount,
  t.total_credit::numeric AS total_amount,
  si.payment_status::text,
  t.created_at,
  COALESCE(si.tax_period_id, date_period.id) AS tax_period_id
FROM tax_lines t
LEFT JOIN public.sales_invoices si ON si.id = t.reference_id
LEFT JOIN public.customers c ON c.id = si.customer_id
LEFT JOIN public.tax_periods date_period
  ON date_period.tax_type = 'PPN'
 AND t.entry_date BETWEEN date_period.period_start AND date_period.period_end;

ALTER VIEW public.vw_input_ppn_report SET (security_invoker = true);
ALTER VIEW public.vw_output_ppn_report SET (security_invoker = true);
GRANT SELECT ON public.vw_input_ppn_report, public.vw_output_ppn_report TO authenticated;

COMMENT ON VIEW public.vw_input_ppn_report IS
  'Journal-native Input PPN amounts with canonical source tax_period_id attribution for Tax Compliance and CA exports.';
COMMENT ON VIEW public.vw_output_ppn_report IS
  'Journal-native Output PPN amounts with canonical source tax_period_id attribution for Tax Compliance and CA exports.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.vw_input_ppn_report v
    JOIN public.finance_expenses fe ON fe.voucher_number = v.reference
    WHERE fe.tax_period_id IS NOT NULL
      AND v.tax_period_id IS DISTINCT FROM fe.tax_period_id
  ) THEN RAISE EXCEPTION 'Input PPN report lost explicit expense period attribution'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.vw_output_ppn_report v
    JOIN public.sales_invoices si ON si.invoice_number = v.invoice_number
    WHERE si.tax_period_id IS NOT NULL
      AND v.tax_period_id IS DISTINCT FROM si.tax_period_id
  ) THEN RAISE EXCEPTION 'Output PPN report lost explicit invoice period attribution'; END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
