-- Taxed invoices assigned to a tax period require the official Faktur Pajak
-- number. The number cannot be derived from accounting records, so preserve the
-- invoice and journal and place each omission in the manual Exception Report.

WITH latest_run AS (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
)
INSERT INTO public.finance_historical_repair_exceptions(
  run_id,
  document_type,
  document_id,
  document_number,
  inconsistent_fields,
  reason,
  manual_information_required,
  status
)
SELECT
  r.run_id,
  'sales_invoice',
  si.id,
  si.invoice_number,
  ARRAY['faktur_pajak_number'],
  'Taxed sales invoice assigned to a tax period is missing Faktur Pajak number',
  'Enter the official Faktur Pajak number from the issued tax invoice; do not alter the sales amount, tax amount or posted journal',
  'manual_review'
FROM latest_run r
CROSS JOIN public.sales_invoices si
WHERE COALESCE(si.tax_amount, 0) > 0
  AND si.tax_period_id IS NOT NULL
  AND NULLIF(trim(si.faktur_pajak_number), '') IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.finance_historical_repair_exceptions e
    WHERE e.run_id = r.run_id
      AND e.document_type = 'sales_invoice'
      AND e.document_id = si.id
      AND e.status = 'manual_review'
      AND e.reason ILIKE '%missing Faktur Pajak%'
  )

UPDATE public.finance_historical_repair_runs r
SET records_manual_review = (
  SELECT count(DISTINCT (e.document_type, e.document_id))
  FROM public.finance_historical_repair_exceptions e
  WHERE e.run_id = r.id AND e.status = 'manual_review'
)
WHERE r.id = (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
)
