-- Reconcile the production cleanup summary to the complete Finance scope now
-- covered by the final audit. Counts are reporting metadata only; no Finance
-- document or accounting value is modified.

WITH latest_run AS (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
), universe AS (
  SELECT 'expense'::text document_type, id document_id FROM public.finance_expenses
  UNION ALL SELECT 'receipt', id FROM public.receipt_vouchers
  UNION ALL SELECT 'payment', id FROM public.payment_vouchers
  UNION ALL SELECT 'fund_transfer', id FROM public.fund_transfers
  UNION ALL SELECT 'journal', id FROM public.journal_entries
  UNION ALL SELECT 'bank_reconciliation', id FROM public.bank_statement_lines
  UNION ALL SELECT 'loan', id FROM public.loans
  UNION ALL SELECT 'loan_repayment', id FROM public.loan_transactions
  UNION ALL SELECT 'capital_contribution', id FROM public.capital_contributions
  UNION ALL SELECT 'petty_cash', id FROM public.petty_cash_transactions
  UNION ALL SELECT 'tax_payment', id FROM public.tax_payments
  UNION ALL SELECT 'sales_invoice', id FROM public.sales_invoices
  UNION ALL SELECT 'purchase_invoice', id FROM public.purchase_invoices
), counts AS (
  SELECT
    count(*) AS total_records_scanned,
    count(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.finance_historical_repair_items i
        WHERE i.run_id = (SELECT run_id FROM latest_run)
          AND i.document_type = u.document_type
          AND i.document_id = u.document_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.finance_historical_repair_exceptions e
        WHERE e.run_id = (SELECT run_id FROM latest_run)
          AND e.document_type = u.document_type
          AND e.document_id = u.document_id
          AND e.status = 'manual_review'
      )
    ) AS records_skipped
  FROM universe u
)
UPDATE public.finance_historical_repair_runs r
SET total_records_scanned = c.total_records_scanned,
    records_manual_review = (
      SELECT count(DISTINCT (e.document_type, e.document_id))
      FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id = r.id AND e.status = 'manual_review'
    ),
    records_skipped = c.records_skipped,
    notes = 'Deterministic metadata/link repair plus full Finance source and tax exception audit. Accounting amounts are immutable.'
FROM counts c
WHERE r.id = (SELECT run_id FROM latest_run)
