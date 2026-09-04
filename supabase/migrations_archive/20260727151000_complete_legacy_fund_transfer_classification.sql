-- Include already-resolved pre-cutover legacy Fund Transfers in the durable
-- Legacy Accepted registry. This is classification metadata only and does not
-- reopen or alter the historical exception.

INSERT INTO public.finance_legacy_accepted_documents(
  document_type, document_id, classification, acceptance_reason
)
SELECT
  'fund_transfer', ft.id, 'legacy_accepted',
  'Legacy Accepted: posted before the 2026-01-08 FX-method cutover. The Fund Transfer amounts and exchange rate are internally consistent; the USD-source journal uses the historical functional-column convention.'
FROM public.fund_transfers ft
WHERE ft.status = 'posted'
  AND ft.transfer_date < DATE '2026-01-08'
  AND EXISTS (
    SELECT 1
    FROM public.finance_historical_repair_exceptions e
    WHERE e.document_type = 'fund_transfer'
      AND e.document_id = ft.id
      AND e.reason = 'Legacy USD-source Contra stored the USD source amount in functional GL columns; posted values were not rewritten'
  )
ON CONFLICT (document_type, document_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
