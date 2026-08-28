-- A journal that posts to the canonical Director Loan control account is not a
-- genuine Manual Journal. When the stored data does not prove all fields needed
-- for a native Loan source row, preserve the posting and surface it for manual
-- source-document completion instead of guessing loan terms.

WITH latest_run AS (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
), candidates AS (
  SELECT DISTINCT je.id, je.entry_number
  FROM public.journal_entries je
  JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.source_module = 'manual'
    AND je.is_posted = true
    AND COALESCE(je.is_reversed, false) = false
    AND jel.credit > 0
    AND coa.code = '2105'
    AND NOT EXISTS (
      SELECT 1 FROM public.loans l WHERE l.journal_entry_id = je.id
    )
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
  'journal',
  c.id,
  c.entry_number,
  ARRAY['source_module', 'reference_id'],
  'Journal metadata cannot be derived into a native Loan source document from stored data',
  'Confirm the lender identity, loan terms, maturity and opening outstanding balance; then create and relink the native Loan source document without reposting the journal',
  'manual_review'
FROM latest_run r
CROSS JOIN candidates c
WHERE NOT EXISTS (
  SELECT 1
  FROM public.finance_historical_repair_exceptions e
  WHERE e.run_id = r.run_id
    AND e.document_type = 'journal'
    AND e.document_id = c.id
    AND e.status = 'manual_review'
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
