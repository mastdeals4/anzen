-- Classify the remaining USD-source Fund Transfer exceptions without changing
-- any accounting record. The former FX posting method was superseded on
-- 2026-01-08. Transfers before that date retain their original, approved
-- historical presentation; post-cutover transfers must remain review items.

CREATE TABLE IF NOT EXISTS public.finance_legacy_accepted_documents (
  document_type text NOT NULL CHECK (document_type = 'fund_transfer'),
  document_id uuid NOT NULL REFERENCES public.fund_transfers(id),
  classification text NOT NULL CHECK (classification = 'legacy_accepted'),
  acceptance_reason text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_type, document_id)
);

ALTER TABLE public.finance_legacy_accepted_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finance_legacy_accepted_documents_read ON public.finance_legacy_accepted_documents;
CREATE POLICY finance_legacy_accepted_documents_read
  ON public.finance_legacy_accepted_documents
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.role IN ('admin', 'accounts', 'auditor_ca')
  ));

-- Group A: the 2025 USD-source transfers were posted before the current FX
-- method existed. Their source amounts, destination amounts and stored rates
-- agree, and the only mismatch is the legacy functional-column convention.
-- This inserts classification metadata only; it does not touch the transfer,
-- its journal, journal lines, banks, rates, or reconciliation rows.
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
      AND e.status = 'manual_review'
      AND e.reason = 'Legacy USD-source Contra stored the USD source amount in functional GL columns; posted values were not rewritten'
  )
ON CONFLICT (document_type, document_id) DO NOTHING;

-- Close every historical copy of Group A as an explicit Legacy Accepted
-- classification. "skipped" is intentionally used because it is already an
-- immutable, non-actionable exception state and is excluded from correction.
UPDATE public.finance_historical_repair_exceptions e
SET status = 'skipped',
    reason = 'Legacy Accepted: historical USD-source Fund Transfer posted before the 2026-01-08 FX-method cutover',
    manual_information_required = 'None. Retained under the historical FX accounting policy; no journal, amount, rate, bank, or reconciliation change is authorised.'
WHERE e.document_type = 'fund_transfer'
  AND EXISTS (
    SELECT 1
    FROM public.finance_legacy_accepted_documents a
    WHERE a.document_type = e.document_type AND a.document_id = e.document_id
  );

-- The post-cutover transfer remains Group B. Its transfer source is complete,
-- but JE2601-0032 stores USD 500 as both functional debit and credit instead
-- of the IDR 8,130,000 destination amount. It therefore needs an accountant's
-- documented decision on a controlled correction/reversal; this migration
-- deliberately makes no accounting change.
UPDATE public.finance_historical_repair_exceptions e
SET manual_information_required =
      'Review FT2601-0024 with JE2601-0032: confirm the approved post-cutover FX treatment and whether an authorised controlled correction/reversal is required. The current posted journal has USD 500 functional debit/credit while the Fund Transfer destination is IDR 8,130,000 at 16,260.',
    reason =
      'Post-cutover USD-source Fund Transfer retains the retired functional-column FX posting method; accountant review is required'
WHERE e.document_type = 'fund_transfer'
  AND e.document_number = 'FT2601-0024'
  AND e.status = 'manual_review';

-- Suppress Legacy Accepted documents from the accountant dashboard and from
-- the live integrity feed, including any future historical-audit run. Group B
-- records continue to flow through unchanged.
CREATE OR REPLACE VIEW public.finance_exception_correction_dashboard
WITH (security_invoker = true) AS
WITH base AS (
  SELECT review.*
  FROM public.finance_exception_accountant_review_dashboard review
  WHERE NOT EXISTS (
    SELECT 1 FROM public.finance_legacy_accepted_documents accepted
    WHERE accepted.document_type = review.document_type
      AND accepted.document_id = review.document_id
  )
  UNION ALL
  SELECT live.*
  FROM public.finance_live_verification_failures live
  WHERE NOT EXISTS (
    SELECT 1 FROM public.finance_exception_accountant_review_dashboard open_item
    WHERE open_item.document_type = live.document_type
      AND open_item.document_id = live.document_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.finance_legacy_accepted_documents accepted
    WHERE accepted.document_type = live.document_type
      AND accepted.document_id = live.document_id
  )
)
SELECT b.*,
  fe.expense_type::text AS current_subcategory,
  COALESCE(fe.invoice_number,rv.reference_number,pv.reference_number,bsl.reference,je.reference_number)::text AS current_reference,
  COALESCE(fe.supplier_id,pv.supplier_id,pi.supplier_id,jel.supplier_id) AS current_supplier_id,
  COALESCE(rv.customer_id,si.customer_id,jel.customer_id) AS current_customer_id,
  ft.from_bank_account_id,ft.to_bank_account_id,
  COALESCE(from_bank.alias,from_bank.account_name,from_bank.bank_name)::text AS from_bank_alias,
  COALESCE(to_bank.alias,to_bank.account_name,to_bank.bank_name)::text AS to_bank_alias,
  COALESCE(current_bank.alias,current_bank.account_name,current_bank.bank_name)::text AS bank_alias,
  COALESCE(
    CASE WHEN b.document_type='bank_reconciliation' THEN b.document_id END,
    linked_bank_line.id
  ) AS bank_statement_line_id,
  COALESCE(fe.invoice_number,rv.voucher_number,pv.voucher_number,ft.transfer_number,
    l.loan_number,lt.transaction_number,cc.voucher_number,tp.billing_code,
    si.invoice_number,pi.invoice_number,je.reference_number,b.voucher_number)::text AS current_source_document,
  COALESCE(l.loan_type,cc.contribution_type)::text AS current_finance_classification
FROM base b
LEFT JOIN public.finance_expenses fe ON b.document_type='expense' AND fe.id=b.document_id
LEFT JOIN public.receipt_vouchers rv ON b.document_type='receipt' AND rv.id=b.document_id
LEFT JOIN public.payment_vouchers pv ON b.document_type='payment' AND pv.id=b.document_id
LEFT JOIN public.fund_transfers ft ON b.document_type='fund_transfer' AND ft.id=b.document_id
LEFT JOIN public.loans l ON b.document_type='loan' AND l.id=b.document_id
LEFT JOIN public.loan_transactions lt ON b.document_type IN ('loan_transaction','loan_repayment') AND lt.id=b.document_id
LEFT JOIN public.capital_contributions cc ON b.document_type='capital_contribution' AND cc.id=b.document_id
LEFT JOIN public.tax_payments tp ON b.document_type='tax_payment' AND tp.id=b.document_id
LEFT JOIN public.sales_invoices si ON b.document_type='sales_invoice' AND si.id=b.document_id
LEFT JOIN public.purchase_invoices pi ON b.document_type='purchase_invoice' AND pi.id=b.document_id
LEFT JOIN public.bank_statement_lines bsl ON b.document_type='bank_reconciliation' AND bsl.id=b.document_id
LEFT JOIN public.journal_entries je ON je.id=b.journal_entry_id
LEFT JOIN public.journal_entry_lines jel ON jel.id=b.journal_line_id
LEFT JOIN public.bank_accounts current_bank ON current_bank.id=b.current_bank_account_id
LEFT JOIN public.bank_accounts from_bank ON from_bank.id=ft.from_bank_account_id
LEFT JOIN public.bank_accounts to_bank ON to_bank.id=ft.to_bank_account_id
LEFT JOIN LATERAL (
  SELECT x.id FROM public.bank_statement_lines x
  WHERE (b.document_type='expense' AND x.matched_expense_id=b.document_id)
     OR (b.document_type='receipt' AND x.matched_receipt_id=b.document_id)
     OR (b.document_type='payment' AND x.matched_payment_id=b.document_id)
     OR (b.document_type='fund_transfer' AND x.matched_fund_transfer_id=b.document_id)
     OR (b.document_type='petty_cash' AND x.matched_petty_cash_id=b.document_id)
     OR (b.document_type='tax_payment' AND x.matched_tax_payment_id=b.document_id)
     OR (x.matched_entry_id=b.journal_entry_id AND b.journal_entry_id IS NOT NULL)
  ORDER BY x.transaction_date DESC LIMIT 1
) linked_bank_line ON true;

GRANT SELECT ON public.finance_exception_correction_dashboard TO authenticated;

NOTIFY pgrst, 'reload schema';
