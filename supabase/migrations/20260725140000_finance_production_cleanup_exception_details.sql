/*
  Finance production cleanup: complete exception classification and details.

  This migration does not change document amounts, journal debit/credit values,
  posted account mappings, or accounting history. It records deterministic
  audit findings that require an accountant decision and exposes the complete
  production exception report requested by Finance.
*/

DO $$
DECLARE
  v_run uuid;
BEGIN
  SELECT id INTO v_run
  FROM public.finance_historical_repair_runs
  WHERE completed_at IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_run IS NULL THEN
    RAISE EXCEPTION 'A completed Finance historical repair run is required';
  END IF;

  -- A reconciled Expense whose journal does not use the selected bank GL is
  -- deterministically inconsistent. Changing the posted account would rewrite
  -- ledger history, so record it for an accountant-authorised correction.
  INSERT INTO public.finance_historical_repair_exceptions(
    run_id,document_type,document_id,document_number,inconsistent_fields,
    reason,manual_information_required,status)
  SELECT v_run,'expense',fe.id,fe.voucher_number,
    ARRAY['journal_entry_lines.account_id','bank_account_id'],
    'Posted expense journal does not use the Expense bank account GL account; legacy logic posted Cash on Hand or another account',
    'Accountant decision: retain history and post an authorised correcting/reclassification entry, or formally reverse and repost the document',
    'manual_review'
  FROM public.finance_expenses fe
  JOIN public.bank_accounts ba ON ba.id=fe.bank_account_id
  JOIN LATERAL (
    SELECT je.id
    FROM public.journal_entries je
    WHERE je.source_module='expenses'
      AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
      AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    ORDER BY je.created_at DESC
    LIMIT 1
  ) je ON true
  WHERE fe.approval_status='approved'
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id=je.id AND jel.account_id=ba.coa_id
    )
    AND EXISTS (
      SELECT 1 FROM public.bank_statement_lines bsl
      WHERE bsl.matched_expense_id=fe.id OR bsl.matched_entry_id=je.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id=v_run AND e.document_type='expense' AND e.document_id=fe.id
        AND e.reason LIKE 'Posted expense journal does not use%'
    );

  -- Record the same issue against the affected reconciliation row so no bank
  -- record remains hidden merely because its source Expense is also reported.
  INSERT INTO public.finance_historical_repair_exceptions(
    run_id,document_type,document_id,document_number,inconsistent_fields,
    reason,manual_information_required,status)
  SELECT v_run,'bank_reconciliation',bsl.id,NULLIF(bsl.reference,''),
    ARRAY['matched_entry_id','journal_entry_lines.account_id','bank_account_id'],
    'Reconciled bank line points to an Expense journal that does not post to this bank account GL',
    'Accountant decision for the linked Expense: correcting/reclassification entry or formal reversal and reposting; do not silently change the posted journal account',
    'manual_review'
  FROM public.bank_statement_lines bsl
  JOIN public.finance_expenses fe ON fe.id=bsl.matched_expense_id
  JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
  JOIN public.journal_entries je ON je.id=bsl.matched_entry_id
  WHERE je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id=je.id AND jel.account_id=ba.coa_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id=v_run AND e.document_type='bank_reconciliation' AND e.document_id=bsl.id
        AND e.reason LIKE 'Reconciled bank line points to an Expense journal%'
    );

  -- More than one typed source link is never silently cleared: the stored row
  -- does not prove which document relationship is authoritative.
  INSERT INTO public.finance_historical_repair_exceptions(
    run_id,document_type,document_id,document_number,inconsistent_fields,
    reason,manual_information_required,status)
  SELECT v_run,'bank_reconciliation',bsl.id,NULLIF(bsl.reference,''),
    ARRAY['matched_expense_id','matched_receipt_id','matched_payment_id',
      'matched_petty_cash_id','matched_fund_transfer_id','matched_tax_payment_id'],
    'Bank line has multiple typed document links and the authoritative source cannot be proven automatically',
    'Confirm the single authoritative source document and manually relink the bank line',
    'manual_review'
  FROM public.bank_statement_lines bsl
  WHERE num_nonnulls(bsl.matched_expense_id,bsl.matched_receipt_id,bsl.matched_payment_id,
    bsl.matched_petty_cash_id,bsl.matched_fund_transfer_id,bsl.matched_tax_payment_id)>1
    AND NOT EXISTS (
      SELECT 1 FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id=v_run AND e.document_type='bank_reconciliation' AND e.document_id=bsl.id
        AND e.reason LIKE 'Bank line has multiple typed%'
    );

  UPDATE public.finance_historical_repair_runs r SET
    records_repaired=(
      SELECT count(DISTINCT (i.document_type,i.document_id))
      FROM public.finance_historical_repair_items i
      WHERE i.run_id=v_run AND NOT EXISTS(
        SELECT 1 FROM public.finance_historical_repair_exceptions e
        WHERE e.run_id=v_run AND e.status='manual_review'
          AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_partially_repaired=(
      SELECT count(DISTINCT (i.document_type,i.document_id))
      FROM public.finance_historical_repair_items i
      WHERE i.run_id=v_run AND EXISTS(
        SELECT 1 FROM public.finance_historical_repair_exceptions e
        WHERE e.run_id=v_run AND e.status='manual_review'
          AND e.document_type=i.document_type AND e.document_id=i.document_id)),
    records_manual_review=(
      SELECT count(DISTINCT (e.document_type,e.document_id))
      FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id=v_run AND e.status='manual_review'),
    records_skipped=(
      SELECT count(DISTINCT (e.document_type,e.document_id))
      FROM public.finance_historical_repair_exceptions e
      WHERE e.run_id=v_run AND e.status='skipped'
        AND NOT EXISTS(
          SELECT 1 FROM public.finance_historical_repair_exceptions m
          WHERE m.run_id=v_run AND m.status='manual_review'
            AND m.document_type=e.document_type AND m.document_id=e.document_id))
  WHERE r.id=v_run;
END $$;

CREATE OR REPLACE VIEW public.finance_historical_repair_exception_details
WITH (security_invoker=true) AS
WITH exceptions AS (
  SELECT e.*,
    CASE
      WHEN e.reason ILIKE '%USD%rate%' OR e.reason ILIKE '%USD-source Contra%'
        OR e.reason ILIKE '%does not use the Expense bank account%'
        OR e.reason ILIKE '%does not post to this bank account%'
        THEN 'Historical accounting decision required'
      WHEN e.reason ILIKE '%multiple typed%' OR e.reason ILIKE '%no provable active journal%'
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
  WHERE e.status='manual_review'
), details AS (
  SELECT e.run_id,e.document_type,e.document_number,e.document_id AS database_id,
    fe.expense_date AS document_date,fe.amount,
    COALESCE(fe.transaction_currency,fe.currency_code,fe.payment_currency,fe.bank_account_currency,ba.currency) AS currency,
    s.company_name AS customer_supplier,
    concat_ws(' · ',ba.bank_name,ba.account_number,ba.currency) AS bank_account,
    je.entry_number AS journal_number,e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.finance_expenses fe ON e.document_type='expense' AND fe.id=e.document_id
  LEFT JOIN public.suppliers s ON s.id=fe.supplier_id
  LEFT JOIN public.bank_accounts ba ON ba.id=fe.bank_account_id
  LEFT JOIN LATERAL (
    SELECT j.entry_number FROM public.journal_entries j
    WHERE j.source_module='expenses' AND (j.reference_id=fe.id OR j.reference_number='EXP-'||fe.id::text)
      AND COALESCE(j.is_reversed,false)=false
    ORDER BY j.is_posted DESC,j.created_at DESC LIMIT 1
  ) je ON true
  UNION ALL
  SELECT e.run_id,e.document_type,e.document_number,e.document_id,
    rv.voucher_date,rv.amount,
    COALESCE(rv.transaction_currency,rv.currency_code,rv.payment_currency,rv.bank_account_currency,ba.currency),
    c.company_name,concat_ws(' · ',ba.bank_name,ba.account_number,ba.currency),je.entry_number,
    e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.receipt_vouchers rv ON e.document_type='receipt' AND rv.id=e.document_id
  LEFT JOIN public.customers c ON c.id=rv.customer_id
  LEFT JOIN public.bank_accounts ba ON ba.id=rv.bank_account_id
  LEFT JOIN public.journal_entries je ON je.id=rv.journal_entry_id
  UNION ALL
  SELECT e.run_id,e.document_type,e.document_number,e.document_id,
    pv.voucher_date,pv.amount,
    COALESCE(pv.transaction_currency,pv.currency_code,pv.payment_currency,pv.bank_account_currency,ba.currency),
    s.company_name,concat_ws(' · ',ba.bank_name,ba.account_number,ba.currency),je.entry_number,
    e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.payment_vouchers pv ON e.document_type='payment' AND pv.id=e.document_id
  LEFT JOIN public.suppliers s ON s.id=pv.supplier_id
  LEFT JOIN public.bank_accounts ba ON ba.id=pv.bank_account_id
  LEFT JOIN public.journal_entries je ON je.id=pv.journal_entry_id
  UNION ALL
  SELECT e.run_id,e.document_type,e.document_number,e.document_id,
    ft.transfer_date,ft.amount,
    CASE WHEN fba.currency=tba.currency THEN fba.currency ELSE concat_ws(' -> ',fba.currency,tba.currency) END,
    NULL::text,concat_ws(' -> ',concat_ws(' · ',fba.bank_name,fba.account_number,fba.currency),
      concat_ws(' · ',tba.bank_name,tba.account_number,tba.currency)),je.entry_number,
    e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.fund_transfers ft ON e.document_type='fund_transfer' AND ft.id=e.document_id
  LEFT JOIN public.bank_accounts fba ON fba.id=ft.from_bank_account_id
  LEFT JOIN public.bank_accounts tba ON tba.id=ft.to_bank_account_id
  LEFT JOIN public.journal_entries je ON je.id=ft.journal_entry_id
  UNION ALL
  SELECT e.run_id,e.document_type,e.document_number,e.document_id,
    je.entry_date,je.total_debit,COALESCE(je.transaction_currency,je.functional_currency,'IDR'),
    parties.party,bank_accounts.bank,je.entry_number,
    e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.journal_entries je ON e.document_type='journal' AND je.id=e.document_id
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT x.name,'; ') AS party FROM (
      SELECT c.company_name AS name FROM public.journal_entry_lines l JOIN public.customers c ON c.id=l.customer_id WHERE l.journal_entry_id=je.id
      UNION SELECT s.company_name FROM public.journal_entry_lines l JOIN public.suppliers s ON s.id=l.supplier_id WHERE l.journal_entry_id=je.id
    ) x
  ) parties ON true
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT concat_ws(' · ',ba.bank_name,ba.account_number,ba.currency),'; ') AS bank
    FROM public.journal_entry_lines l JOIN public.bank_accounts ba ON ba.coa_id=l.account_id
    WHERE l.journal_entry_id=je.id
  ) bank_accounts ON true
  UNION ALL
  SELECT e.run_id,e.document_type,COALESCE(e.document_number,NULLIF(bsl.reference,'')),e.document_id,
    bsl.transaction_date,COALESCE(NULLIF(bsl.debit_amount,0),bsl.credit_amount),
    COALESCE(bsl.currency,ba.currency),COALESCE(c.company_name,s.company_name),
    concat_ws(' · ',ba.bank_name,ba.account_number,ba.currency),je.entry_number,
    e.inconsistent_fields,e.reason,e.manual_information_required,e.classification,e.created_at
  FROM exceptions e JOIN public.bank_statement_lines bsl ON e.document_type='bank_reconciliation' AND bsl.id=e.document_id
  LEFT JOIN public.bank_accounts ba ON ba.id=bsl.bank_account_id
  LEFT JOIN public.receipt_vouchers rv ON rv.id=bsl.matched_receipt_id
  LEFT JOIN public.customers c ON c.id=rv.customer_id
  LEFT JOIN public.payment_vouchers pv ON pv.id=bsl.matched_payment_id
  LEFT JOIN public.finance_expenses fe ON fe.id=bsl.matched_expense_id
  LEFT JOIN public.suppliers s ON s.id=COALESCE(pv.supplier_id,fe.supplier_id)
  LEFT JOIN public.journal_entries je ON je.id=bsl.matched_entry_id
)
SELECT run_id,document_type,COALESCE(document_number,'(none)') AS document_number,database_id,
  document_date AS date,amount,COALESCE(currency,'Unknown') AS currency,
  customer_supplier,bank_account,journal_number,
  array_to_string(inconsistent_fields,', ') AS exact_problem_fields,
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
FROM details;

GRANT SELECT ON public.finance_historical_repair_exception_details TO authenticated;

NOTIFY pgrst,'reload schema';
