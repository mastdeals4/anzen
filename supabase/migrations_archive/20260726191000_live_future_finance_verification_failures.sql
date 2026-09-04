-- Phase 2 live verification feed. These views compute current failures from
-- existing Finance data, so future problems appear without CSV generation,
-- another repair run, or a new persistence table.

CREATE OR REPLACE VIEW public.finance_live_verification_failures
WITH (security_invoker = true) AS
WITH bank_failures AS (
  SELECT b.*,ba.coa_id AS bank_coa_id,ba.bank_name,ba.account_name,ba.account_number,
    ba.currency AS bank_currency,je.id AS active_journal_id,je.entry_number,
    CASE
      WHEN ba.coa_id IS NULL THEN 'The selected bank is missing its posting account.'
      WHEN je.id IS NULL THEN 'The linked bank transaction has no active journal.'
      WHEN NOT EXISTS(SELECT 1 FROM public.journal_entry_lines x WHERE x.journal_entry_id=je.id AND x.account_id=ba.coa_id)
        THEN 'The linked journal uses a different account from the Bank Master.'
      ELSE 'The amount or money-in/money-out direction differs between the bank transaction and journal.'
    END AS problem
  FROM public.bank_statement_lines b
  LEFT JOIN public.bank_accounts ba ON ba.id=b.bank_account_id
  LEFT JOIN public.journal_entries je ON je.id=b.matched_entry_id
    AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
  WHERE (b.reconciliation_status IN ('matched','recorded') OR b.matched_entry_id IS NOT NULL)
    AND (ba.coa_id IS NULL OR je.id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.journal_entry_lines x
      WHERE x.journal_entry_id=je.id AND x.account_id=ba.coa_id
        AND ((COALESCE(b.credit_amount,0)>0 AND COALESCE(b.debit_amount,0)=0
              AND COALESCE(NULLIF(x.transaction_debit,0),x.debit)=b.credit_amount)
          OR (COALESCE(b.debit_amount,0)>0 AND COALESCE(b.credit_amount,0)=0
              AND COALESCE(NULLIF(x.transaction_credit,0),x.credit)=b.debit_amount))
    ))
), bank_rows AS (
  SELECT
    'live:bank_reconciliation:'||b.id::text AS row_id,NULL::bigint exception_id,
    (SELECT run_id FROM public.finance_historical_repair_summary ORDER BY started_at DESC LIMIT 1) run_id,
    'bank_reconciliation'::text document_type,b.id document_id,b.transaction_date AS date,
    COALESCE(NULLIF(b.reference,''),'Bank transaction')::text voucher_number,b.entry_number::text journal_number,
    COALESCE(NULLIF(b.debit_amount,0),b.credit_amount)::numeric amount,COALESCE(b.currency,b.bank_currency,'Unknown')::text currency,
    concat_ws(' · ',b.bank_name,b.account_name,b.account_number,b.bank_currency)::text bank,
    COALESCE(c.company_name,s.company_name)::text customer_supplier,b.payment_kind::text current_category,
    concat_ws(' · ',coa.code,coa.name)::text current_gl_account,'Verification failed'::text status,b.problem::text,
    'The current bank link does not satisfy the Bank Master, amount and direction checks.'::text why_not_automatic,
    'Review the original bank transaction and source document, then select the confirmed bank and account. If the amounts differ, ask the accountant whether a formal correction is required.'::text recommended_action,
    b.bank_account_id AS current_bank_account_id,b.active_journal_id AS journal_entry_id,
    current_line.id AS journal_line_id,current_line.account_id AS current_account_id,
    NULL::uuid current_tax_code_id,b.payment_kind::text current_payment_type,
    je.source_module::text current_document_classification,NULL::text current_faktur_pajak_number,NULL::numeric expense_exchange_rate
  FROM bank_failures b
  LEFT JOIN public.journal_entries je ON je.id=b.active_journal_id
  LEFT JOIN public.receipt_vouchers rv ON rv.id=b.matched_receipt_id
  LEFT JOIN public.payment_vouchers pv ON pv.id=b.matched_payment_id
  LEFT JOIN public.finance_expenses fe ON fe.id=b.matched_expense_id
  LEFT JOIN public.customers c ON c.id=rv.customer_id
  LEFT JOIN public.suppliers s ON s.id=COALESCE(pv.supplier_id,fe.supplier_id)
  LEFT JOIN LATERAL (
    SELECT x.id,x.account_id FROM public.journal_entry_lines x
    WHERE x.journal_entry_id=b.active_journal_id
    ORDER BY CASE WHEN (COALESCE(b.credit_amount,0)>0 AND COALESCE(NULLIF(x.transaction_debit,0),x.debit)=b.credit_amount)
      OR (COALESCE(b.debit_amount,0)>0 AND COALESCE(NULLIF(x.transaction_credit,0),x.credit)=b.debit_amount) THEN 0 ELSE 1 END,x.line_number
    LIMIT 1
  ) current_line ON true
  LEFT JOIN public.chart_of_accounts coa ON coa.id=current_line.account_id
), journal_rows AS (
  SELECT 'live:journal:'||u.id::text,NULL::bigint,
    (SELECT run_id FROM public.finance_historical_repair_summary ORDER BY started_at DESC LIMIT 1),
    'journal'::text,u.id,u.entry_date,u.entry_number::text,u.entry_number::text,u.total_debit::numeric,'IDR'::text,
    NULL::text,NULL::text,u.description::text,NULL::text,'Verification failed'::text,
    'This posted journal is not balanced.'::text,
    'Finance reports require every posted journal to have equal debits and credits.'::text,
    'Review the source document and journal with the accountant. Do not change historical amounts without an authorised correction.'::text,
    NULL::uuid,u.id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::numeric
  FROM public.unbalanced_journal_entries u
), faktur_rows AS (
  SELECT 'live:sales_invoice:'||si.id::text,NULL::bigint,
    (SELECT run_id FROM public.finance_historical_repair_summary ORDER BY started_at DESC LIMIT 1),
    'sales_invoice'::text,si.id,si.invoice_date,si.invoice_number::text,je.entry_number::text,si.total_amount::numeric,'IDR'::text,
    NULL::text,c.company_name::text,'Taxed Sale'::text,NULL::text,'Verification failed'::text,
    'A taxed invoice is missing its Faktur Pajak number.'::text,
    'Tax reporting cannot complete the invoice without the official number.'::text,
    'Confirm and enter the issued Faktur Pajak number.'::text,
    NULL::uuid,si.journal_entry_id,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,je.source_module::text,
    si.faktur_pajak_number::text,NULL::numeric
  FROM public.sales_invoices si
  LEFT JOIN public.customers c ON c.id=si.customer_id
  LEFT JOIN public.journal_entries je ON je.id=si.journal_entry_id
  WHERE si.tax_amount>0 AND si.tax_period_id IS NOT NULL AND NULLIF(btrim(si.faktur_pajak_number),'') IS NULL
)
SELECT * FROM bank_rows
UNION ALL SELECT * FROM journal_rows
UNION ALL SELECT * FROM faktur_rows;

ALTER VIEW public.finance_exception_correction_dashboard
  RENAME TO finance_exception_accountant_review_dashboard;

CREATE VIEW public.finance_exception_correction_dashboard
WITH (security_invoker = true) AS
SELECT * FROM public.finance_exception_accountant_review_dashboard
UNION ALL
SELECT live.* FROM public.finance_live_verification_failures live
WHERE NOT EXISTS (
  SELECT 1 FROM public.finance_exception_accountant_review_dashboard open_item
  WHERE open_item.document_type=live.document_type AND open_item.document_id=live.document_id
);

GRANT SELECT ON public.finance_live_verification_failures,
  public.finance_exception_accountant_review_dashboard,
  public.finance_exception_correction_dashboard TO authenticated;

NOTIFY pgrst,'reload schema';
