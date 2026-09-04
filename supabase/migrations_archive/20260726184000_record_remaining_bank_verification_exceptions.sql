-- Phase 1 post-repair verification: every remaining Bank Reconciliation / Bank
-- Ledger failure must be represented by a manual exception. This migration
-- records audit metadata only; it does not change any Finance source or GL row.

WITH latest_run AS (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
), failures AS (
  SELECT
    b.id AS bank_line_id,
    NULLIF(b.reference, '') AS document_number,
    b.matched_entry_id,
    b.matched_expense_id,
    b.matched_receipt_id,
    b.matched_payment_id,
    b.matched_fund_transfer_id,
    b.matched_petty_cash_id,
    b.matched_tax_payment_id,
    CASE
      WHEN b.bank_account_id IS NULL OR ba.coa_id IS NULL
        THEN 'Linked bank line has no complete Bank Master GL mapping'
      WHEN je.id IS NULL
        THEN 'Linked bank line has no active posted journal'
      WHEN NOT EXISTS (
        SELECT 1
        FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.account_id = ba.coa_id
      )
        THEN 'Linked journal does not post to the Bank Master GL and the existing non-bank classification is not deterministically Cash on Hand'
      ELSE 'Linked journal Bank Master GL amount or direction does not match the bank statement line'
    END AS reason,
    CASE
      WHEN b.bank_account_id IS NULL OR ba.coa_id IS NULL
        THEN ARRAY['bank_account_id', 'bank_accounts.coa_id']::text[]
      WHEN je.id IS NULL
        THEN ARRAY['matched_entry_id']::text[]
      WHEN NOT EXISTS (
        SELECT 1
        FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.account_id = ba.coa_id
      )
        THEN ARRAY['journal_entry_lines.account_id', 'bank_accounts.coa_id']::text[]
      ELSE ARRAY['debit_amount', 'credit_amount', 'journal_entry_lines']::text[]
    END AS inconsistent_fields
  FROM public.bank_statement_lines b
  LEFT JOIN public.bank_accounts ba ON ba.id = b.bank_account_id
  LEFT JOIN public.journal_entries je
    ON je.id = b.matched_entry_id
   AND je.is_posted = true
   AND COALESCE(je.is_reversed, false) = false
  WHERE (b.reconciliation_status IN ('matched', 'recorded') OR b.matched_entry_id IS NOT NULL)
    AND (
      ba.coa_id IS NULL
      OR je.id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.account_id = ba.coa_id
          AND (
            (
              COALESCE(b.credit_amount, 0) > 0
              AND COALESCE(b.debit_amount, 0) = 0
              AND COALESCE(NULLIF(jel.transaction_debit, 0), jel.debit) = b.credit_amount
            )
            OR
            (
              COALESCE(b.debit_amount, 0) > 0
              AND COALESCE(b.credit_amount, 0) = 0
              AND COALESCE(NULLIF(jel.transaction_credit, 0), jel.credit) = b.debit_amount
            )
          )
      )
    )
), undocumented AS (
  SELECT f.*
  FROM failures f
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.finance_historical_repair_exceptions e
    WHERE e.run_id = (SELECT run_id FROM latest_run)
      AND e.status = 'manual_review'
      AND (
        (e.document_type = 'bank_reconciliation' AND e.document_id = f.bank_line_id)
        OR (e.document_type = 'expense' AND e.document_id = f.matched_expense_id)
        OR (e.document_type = 'receipt' AND e.document_id = f.matched_receipt_id)
        OR (e.document_type = 'payment' AND e.document_id = f.matched_payment_id)
        OR (e.document_type = 'fund_transfer' AND e.document_id = f.matched_fund_transfer_id)
        OR (e.document_type = 'petty_cash' AND e.document_id = f.matched_petty_cash_id)
        OR (e.document_type = 'tax_payment' AND e.document_id = f.matched_tax_payment_id)
        OR (e.document_type = 'journal' AND e.document_id = f.matched_entry_id)
      )
  )
)
INSERT INTO public.finance_historical_repair_exceptions(
  run_id, document_type, document_id, document_number, inconsistent_fields,
  reason, manual_information_required, status
)
SELECT
  (SELECT run_id FROM latest_run),
  'bank_reconciliation',
  bank_line_id,
  document_number,
  inconsistent_fields,
  reason,
  'Accountant confirmation of the correct source journal, Bank Master GL, amount and direction; then relink or post an authorised correction without rewriting history',
  'manual_review'
FROM undocumented

UPDATE public.finance_historical_repair_runs r
SET records_manual_review = (
      SELECT count(DISTINCT (e.document_type, e.document_id))
      FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id = r.id AND e.status = 'manual_review'
    ),
    records_partially_repaired = (
      SELECT count(DISTINCT (i.document_type, i.document_id))
      FROM public.finance_historical_repair_items i
      WHERE i.run_id = r.id
        AND EXISTS (
          SELECT 1 FROM public.finance_historical_repair_exceptions e
          WHERE e.run_id = r.id
            AND e.document_type = i.document_type
            AND e.document_id = i.document_id
            AND e.status = 'manual_review'
        )
    )
WHERE r.id = (
  SELECT run_id
  FROM public.finance_historical_repair_summary
  ORDER BY started_at DESC
  LIMIT 1
)

NOTIFY pgrst, 'reload schema'
