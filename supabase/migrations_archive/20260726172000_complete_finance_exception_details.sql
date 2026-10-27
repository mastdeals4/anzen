-- The production exception report must include every canonical Finance source
-- type. The previous view omitted Loan, Loan Repayment, Capital Contribution,
-- Petty Cash and Tax Payment exceptions, causing the CSV total to be lower than
-- the repair summary even though the underlying exceptions were recorded.

CREATE OR REPLACE VIEW public.finance_historical_repair_exception_details
WITH (security_invoker = true) AS
WITH exceptions AS (
  SELECT e.*,
    CASE
      WHEN e.reason ILIKE '%USD%rate%'
        OR e.reason ILIKE '%USD-source Contra%'
        OR e.reason ILIKE '%does not use the Expense bank account%'
        OR e.reason ILIKE '%does not post to this bank account%'
        THEN 'Historical accounting decision required'
      WHEN e.reason ILIKE '%multiple typed%'
        OR e.reason ILIKE '%no provable active journal%'
        THEN 'Manual relink required'
      WHEN e.reason ILIKE '%Approved expense has no active journal%'
        OR e.reason ILIKE '%Journal metadata cannot be derived%'
        THEN 'Missing source document'
      WHEN e.reason ILIKE '%No unique authoritative relationship%'
        OR e.reason ILIKE '%metadata conflicts%'
        THEN 'Manual edit required'
      ELSE 'Investigate further'
    END AS classification
  FROM public.finance_historical_repair_exceptions e
  WHERE e.status = 'manual_review'
), details AS (
  SELECT
    e.run_id,
    e.document_type,
    COALESCE(e.document_number, NULLIF(bsl.reference, '')) AS document_number,
    e.document_id AS database_id,
    COALESCE(
      fe.expense_date,
      rv.voucher_date,
      pv.voucher_date,
      ft.transfer_date,
      l.loan_date,
      lt.transaction_date,
      cc.voucher_date,
      pc.transaction_date,
      tp.payment_date,
      je.entry_date,
      bsl.transaction_date
    ) AS document_date,
    COALESCE(
      fe.amount,
      rv.amount,
      pv.amount,
      ft.amount,
      l.principal_amount,
      lt.amount,
      cc.amount,
      pc.amount,
      tp.amount,
      je.total_debit,
      NULLIF(bsl.debit_amount, 0),
      bsl.credit_amount
    ) AS amount,
    COALESCE(
      fe.transaction_currency, fe.currency_code, fe.payment_currency, fe.bank_account_currency,
      rv.transaction_currency, rv.currency_code, rv.payment_currency, rv.bank_account_currency,
      pv.transaction_currency, pv.currency_code, pv.payment_currency::text, pv.bank_account_currency,
      l.transaction_currency, l.currency, l.bank_account_currency,
      lt.transaction_currency, lt.bank_account_currency,
      cc.transaction_currency, cc.bank_account_currency,
      je.transaction_currency, je.functional_currency,
      bsl.currency, ba.currency,
      CASE WHEN ft.id IS NOT NULL AND fba.currency = tba.currency THEN fba.currency END,
      'IDR'
    ) AS currency,
    COALESCE(
      expense_supplier.company_name,
      receipt_customer.company_name,
      payment_supplier.company_name,
      l.counterparty_name,
      parent_loan.counterparty_name,
      NULLIF(pc.paid_to, '')
    ) AS customer_supplier,
    CASE
      WHEN ft.id IS NOT NULL THEN concat_ws(
        ' -> ',
        concat_ws(' · ', fba.bank_name, fba.account_number, fba.currency),
        concat_ws(' · ', tba.bank_name, tba.account_number, tba.currency)
      )
      ELSE concat_ws(' · ', ba.bank_name, ba.account_number, ba.currency)
    END AS bank_account,
    source_je.entry_number AS journal_number,
    e.inconsistent_fields,
    e.reason,
    e.manual_information_required,
    e.classification,
    e.created_at
  FROM exceptions e
  LEFT JOIN public.finance_expenses fe
    ON e.document_type = 'expense' AND fe.id = e.document_id
  LEFT JOIN public.receipt_vouchers rv
    ON e.document_type = 'receipt' AND rv.id = e.document_id
  LEFT JOIN public.payment_vouchers pv
    ON e.document_type = 'payment' AND pv.id = e.document_id
  LEFT JOIN public.fund_transfers ft
    ON e.document_type = 'fund_transfer' AND ft.id = e.document_id
  LEFT JOIN public.loans l
    ON e.document_type = 'loan' AND l.id = e.document_id
  LEFT JOIN public.loan_transactions lt
    ON e.document_type IN ('loan_transaction', 'loan_repayment') AND lt.id = e.document_id
  LEFT JOIN public.loans parent_loan ON parent_loan.id = lt.loan_id
  LEFT JOIN public.capital_contributions cc
    ON e.document_type = 'capital_contribution' AND cc.id = e.document_id
  LEFT JOIN public.petty_cash_transactions pc
    ON e.document_type = 'petty_cash' AND pc.id = e.document_id
  LEFT JOIN public.tax_payments tp
    ON e.document_type = 'tax_payment' AND tp.id = e.document_id
  LEFT JOIN public.journal_entries je
    ON e.document_type = 'journal' AND je.id = e.document_id
  LEFT JOIN public.bank_statement_lines bsl
    ON e.document_type = 'bank_reconciliation' AND bsl.id = e.document_id
  LEFT JOIN public.suppliers expense_supplier ON expense_supplier.id = fe.supplier_id
  LEFT JOIN public.customers receipt_customer ON receipt_customer.id = rv.customer_id
  LEFT JOIN public.suppliers payment_supplier ON payment_supplier.id = pv.supplier_id
  LEFT JOIN public.bank_accounts fba ON fba.id = ft.from_bank_account_id
  LEFT JOIN public.bank_accounts tba ON tba.id = ft.to_bank_account_id
  LEFT JOIN public.bank_accounts ba ON ba.id = COALESCE(
    fe.bank_account_id,
    rv.bank_account_id,
    pv.bank_account_id,
    l.bank_account_id,
    lt.bank_account_id,
    cc.bank_account_id,
    pc.bank_account_id,
    tp.bank_account_id,
    bsl.bank_account_id
  )
  LEFT JOIN LATERAL (
    SELECT j.entry_number
    FROM public.journal_entries j
    WHERE
      (e.document_type = 'journal' AND j.id = je.id)
      OR (e.document_type = 'expense' AND j.source_module IN ('expense', 'expenses')
        AND (j.reference_id = fe.id OR j.reference_number = 'EXP-' || fe.id::text))
      OR (e.document_type = 'receipt' AND j.id = rv.journal_entry_id)
      OR (e.document_type = 'payment' AND j.id = pv.journal_entry_id)
      OR (e.document_type = 'fund_transfer' AND j.id = ft.journal_entry_id)
      OR (e.document_type = 'loan' AND j.id = l.journal_entry_id)
      OR (e.document_type IN ('loan_transaction', 'loan_repayment') AND j.id = lt.journal_entry_id)
      OR (e.document_type = 'capital_contribution' AND j.id = cc.journal_entry_id)
      OR (e.document_type = 'petty_cash' AND j.source_module = 'petty_cash' AND j.reference_id = pc.id)
      OR (e.document_type = 'tax_payment' AND j.id = tp.journal_entry_id)
      OR (e.document_type = 'bank_reconciliation' AND j.id = bsl.matched_entry_id)
    ORDER BY j.is_posted DESC, COALESCE(j.is_reversed, false), j.created_at DESC
    LIMIT 1
  ) source_je ON true
)
SELECT
  run_id,
  document_type,
  COALESCE(document_number, '(none)') AS document_number,
  database_id,
  document_date AS date,
  amount,
  COALESCE(currency, 'Unknown') AS currency,
  customer_supplier,
  bank_account,
  journal_number,
  array_to_string(inconsistent_fields, ', ') AS exact_problem_fields,
  reason AS exact_problem,
  reason AS why_cannot_repair_automatically,
  classification,
  CASE classification
    WHEN 'Historical accounting decision required' THEN manual_information_required
    WHEN 'Manual relink required' THEN manual_information_required
    WHEN 'Missing source document' THEN manual_information_required
    WHEN 'Manual edit required' THEN manual_information_required
    ELSE 'Investigate the source document, journal, bank line, and audit trail before making any change'
  END AS recommended_action,
  false AS safe_to_delete_and_recreate,
  'Keep — deletion/recreation could remove audit evidence or rewrite posted history; resolve through an authorised manual correction'::text AS disposition,
  created_at
FROM details

GRANT SELECT ON public.finance_historical_repair_exception_details TO authenticated

NOTIFY pgrst, 'reload schema'
