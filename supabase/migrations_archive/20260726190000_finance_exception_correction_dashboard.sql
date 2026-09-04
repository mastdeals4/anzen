-- Finance Stabilization Phase 2: permanent in-application exception repair.
-- Reuses the existing repair audit and Finance sources. No tables, journals,
-- posting paths, debit/credit values, or historical documents are created.

CREATE OR REPLACE VIEW public.finance_exception_correction_dashboard
WITH (security_invoker = true) AS
WITH unresolved AS (
  SELECT
    ('exception:' || e.id::text) AS row_id,
    e.id AS exception_id,
    e.run_id,
    e.document_type,
    e.document_id,
    d.date,
    d.document_number AS voucher_number,
    d.journal_number,
    d.amount,
    d.currency,
    d.bank_account AS bank,
    d.customer_supplier,
    d.classification,
    e.reason,
    e.manual_information_required,
    d.recommended_action,
    e.inconsistent_fields
  FROM public.finance_historical_repair_exceptions e
  JOIN public.finance_historical_repair_exception_details d
    ON d.run_id = e.run_id
   AND d.document_type = e.document_type
   AND d.database_id = e.document_id
   AND d.exact_problem = e.reason
  WHERE e.status = 'manual_review'
), enriched AS (
  SELECT u.*,
    COALESCE(fe.expense_category, pc.expense_category, je.transaction_category,
      l.loan_type, cc.contribution_type, tp.tax_type, pi.purchase_type,
      bsl.payment_kind) AS current_category,
    COALESCE(fe.bank_account_id, rv.bank_account_id, pv.bank_account_id,
      l.bank_account_id, lt.bank_account_id, cc.bank_account_id,
      pc.bank_account_id, tp.bank_account_id, bsl.bank_account_id) AS current_bank_account_id,
    source_je.id AS journal_entry_id,
    current_line.id AS journal_line_id,
    current_line.account_id AS current_account_id,
    concat_ws(' · ', coa.code, coa.name) AS current_gl_account,
    fe.exchange_rate AS expense_exchange_rate,
    COALESCE(fe.pph_code_id, pv.pph_code_id) AS current_tax_code_id,
    COALESCE(fe.payment_method, rv.payment_method, pv.payment_method,
      bsl.payment_kind) AS current_payment_type,
    source_je.source_module AS current_document_classification,
    COALESCE(si.faktur_pajak_number, pi.faktur_pajak_number) AS current_faktur_pajak_number
  FROM unresolved u
  LEFT JOIN public.finance_expenses fe ON u.document_type = 'expense' AND fe.id = u.document_id
  LEFT JOIN public.receipt_vouchers rv ON u.document_type = 'receipt' AND rv.id = u.document_id
  LEFT JOIN public.payment_vouchers pv ON u.document_type = 'payment' AND pv.id = u.document_id
  LEFT JOIN public.fund_transfers ft ON u.document_type = 'fund_transfer' AND ft.id = u.document_id
  LEFT JOIN public.loans l ON u.document_type = 'loan' AND l.id = u.document_id
  LEFT JOIN public.loan_transactions lt ON u.document_type IN ('loan_transaction','loan_repayment') AND lt.id = u.document_id
  LEFT JOIN public.capital_contributions cc ON u.document_type = 'capital_contribution' AND cc.id = u.document_id
  LEFT JOIN public.petty_cash_transactions pc ON u.document_type = 'petty_cash' AND pc.id = u.document_id
  LEFT JOIN public.tax_payments tp ON u.document_type = 'tax_payment' AND tp.id = u.document_id
  LEFT JOIN public.sales_invoices si ON u.document_type = 'sales_invoice' AND si.id = u.document_id
  LEFT JOIN public.purchase_invoices pi ON u.document_type = 'purchase_invoice' AND pi.id = u.document_id
  LEFT JOIN public.journal_entries je ON u.document_type = 'journal' AND je.id = u.document_id
  LEFT JOIN public.bank_statement_lines bsl ON u.document_type = 'bank_reconciliation' AND bsl.id = u.document_id
  LEFT JOIN LATERAL (
    SELECT j.* FROM public.journal_entries j
    WHERE (u.document_type = 'journal' AND j.id = u.document_id)
       OR (u.document_type = 'expense' AND j.source_module IN ('expense','expenses')
          AND (j.reference_id = u.document_id OR j.reference_number = 'EXP-' || u.document_id::text))
       OR (u.document_type = 'receipt' AND j.id = rv.journal_entry_id)
       OR (u.document_type = 'payment' AND j.id = pv.journal_entry_id)
       OR (u.document_type = 'fund_transfer' AND j.id = ft.journal_entry_id)
       OR (u.document_type = 'loan' AND j.id = l.journal_entry_id)
       OR (u.document_type IN ('loan_transaction','loan_repayment') AND j.id = lt.journal_entry_id)
       OR (u.document_type = 'capital_contribution' AND j.id = cc.journal_entry_id)
       OR (u.document_type = 'petty_cash' AND j.source_module = 'petty_cash' AND j.reference_id = u.document_id)
       OR (u.document_type = 'tax_payment' AND j.id = tp.journal_entry_id)
       OR (u.document_type = 'sales_invoice' AND j.id = si.journal_entry_id)
       OR (u.document_type = 'purchase_invoice' AND j.id = pi.journal_entry_id)
       OR (u.document_type = 'bank_reconciliation' AND j.id = bsl.matched_entry_id)
    ORDER BY j.is_posted DESC, COALESCE(j.is_reversed,false), j.created_at DESC
    LIMIT 1
  ) source_je ON true
  LEFT JOIN LATERAL (
    SELECT jl.* FROM public.journal_entry_lines jl
    WHERE jl.journal_entry_id = source_je.id
    ORDER BY
      CASE WHEN u.document_type = 'bank_reconciliation' AND (
        (COALESCE(bsl.credit_amount,0) > 0 AND COALESCE(NULLIF(jl.transaction_debit,0),jl.debit) = bsl.credit_amount)
        OR (COALESCE(bsl.debit_amount,0) > 0 AND COALESCE(NULLIF(jl.transaction_credit,0),jl.credit) = bsl.debit_amount)
      ) THEN 0
      WHEN jl.account_id = COALESCE(l.coa_id,rv.coa_account_id,pv.coa_account_id,fe.fixed_asset_account_id) THEN 0
      ELSE 1 END,
      jl.line_number
    LIMIT 1
  ) current_line ON true
  LEFT JOIN public.chart_of_accounts coa ON coa.id = current_line.account_id
), business_rows AS (
  SELECT e.*,
    CASE
      WHEN reason ILIKE 'No unique authoritative relationship%' THEN
        'The historical record is missing a confirmed payment method, bank, currency, or exchange rate.'
      WHEN reason ILIKE '%no historical transaction-date rate%' OR reason ILIKE '%no authoritative historical rate%' THEN
        'The transaction is confirmed as foreign currency, but its original exchange rate is missing.'
      WHEN reason ILIKE '%USD-source Contra%' THEN
        'The transfer used an older foreign-currency treatment that cannot be corrected without an accountant decision.'
      WHEN reason ILIKE '%does not post to this bank account%' OR reason ILIKE '%does not use the Expense bank account%' THEN
        'The voucher and bank transaction are linked, but the journal uses a different account.'
      WHEN reason ILIKE '%amount or direction does not match%' THEN
        'The amount or money-in/money-out direction differs between the bank transaction and journal.'
      WHEN reason ILIKE '%missing Faktur Pajak%' THEN
        'A taxed invoice is missing its Faktur Pajak number.'
      WHEN reason ILIKE '%without an accrued payable%' THEN
        'A tax payment exists without the earlier tax amount being recorded as payable.'
      WHEN reason ILIKE '%no active journal%' OR reason ILIKE '%no provable active journal%' THEN
        'The document does not have a confirmed active journal.'
      WHEN reason ILIKE '%metadata conflicts%' THEN
        'The voucher details conflict with the linked bank transaction.'
      WHEN reason ILIKE '%Journal metadata cannot be derived%' THEN
        'The journal source or classification cannot be confirmed from the historical record.'
      WHEN reason ILIKE '%no native Loan source document%' THEN
        'The journal is loan-related, but its original loan document is missing.'
      ELSE 'The historical record needs an accountant to confirm its correct classification.'
    END AS problem,
    CASE
      WHEN reason ILIKE '%no historical transaction-date rate%' OR reason ILIKE '%no authoritative historical rate%' THEN
        'The application must not guess a historical exchange rate.'
      WHEN reason ILIKE '%USD-source Contra%' OR reason ILIKE '%amount or direction does not match%' THEN
        'Correcting it automatically could change the meaning of posted accounting amounts.'
      WHEN reason ILIKE '%no active journal%' OR reason ILIKE '%no native Loan source document%' THEN
        'No existing source-to-journal relationship proves a safe automatic correction.'
      WHEN reason ILIKE '%without an accrued payable%' THEN
        'Only an accountant can confirm whether an accrual or reclassification is appropriate.'
      ELSE 'More than one correction is possible from the available historical information.'
    END AS why_not_automatic
  FROM enriched e
)
SELECT row_id,exception_id,run_id,document_type,document_id,date,voucher_number,
  journal_number,amount,currency,bank,customer_supplier,current_category,
  current_gl_account,'Needs accountant review'::text AS status,problem,
  why_not_automatic,recommended_action,current_bank_account_id,journal_entry_id,
  journal_line_id,current_account_id,current_tax_code_id,current_payment_type,
  current_document_classification,current_faktur_pajak_number,expense_exchange_rate
FROM business_rows
UNION ALL
SELECT 'verification:' || vf.document_type || ':' || vf.database_id::text,
  NULL::bigint,vf.run_id,vf.document_type,vf.database_id,NULL::date,
  COALESCE(vf.document_number,'(none)'),NULL::text,NULL::numeric,'Unknown'::text,
  NULL::text,NULL::text,NULL::text,NULL::text,'Verification failed'::text,
  'A Finance verification check still fails for this record.'::text,
  'The current Finance data does not yet satisfy every report check.'::text,
  'Review the source document, journal and linked bank transaction, then save the confirmed classifications.'::text,
  NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text,NULL::numeric
FROM public.finance_historical_repair_verification_failures vf
WHERE NOT EXISTS (
  SELECT 1 FROM unresolved u
  WHERE u.run_id=vf.run_id AND u.document_type=vf.document_type AND u.document_id=vf.database_id
);

GRANT SELECT ON public.finance_exception_correction_dashboard TO authenticated;

CREATE OR REPLACE FUNCTION public.save_finance_exception_corrections(p_corrections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c jsonb;
  v_document_type text;
  v_document_id uuid;
  v_exception_id bigint;
  v_reason text;
  v_journal_id uuid;
  v_line_id uuid;
  v_account_id uuid;
  v_bank_id uuid;
  v_bank_coa_id uuid;
  v_bank_currency text;
  v_tax_code_id uuid;
  v_tax_type text;
  v_exchange_rate numeric;
  v_before_lines jsonb;
  v_after_lines jsonb;
  v_resolved boolean := false;
  v_saved integer := 0;
  v_resolved_count integer := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF jsonb_typeof(p_corrections) <> 'array' OR jsonb_array_length(p_corrections)=0 THEN
    RAISE EXCEPTION 'Select at least one correction before saving';
  END IF;

  -- Existing source triggers read these flags. Metadata corrections must never
  -- regenerate journals or recalculate historical debit/credit values.
  PERFORM set_config('app.finance_historical_repair','on',true);
  PERFORM set_config('app.finance_metadata_repair','on',true);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections)
  LOOP
    v_document_type := c->>'document_type';
    v_document_id := (c->>'document_id')::uuid;
    v_exception_id := NULLIF(c->>'exception_id','')::bigint;
    v_line_id := NULLIF(c->>'journal_line_id','')::uuid;
    v_bank_id := NULLIF(c->>'bank_account_id','')::uuid;
    v_tax_code_id := NULLIF(c->>'tax_code_id','')::uuid;
    v_exchange_rate := NULLIF(c->>'exchange_rate','')::numeric;
    v_resolved := false;

    IF v_exception_id IS NOT NULL THEN
      SELECT reason INTO v_reason
      FROM public.finance_historical_repair_exceptions
      WHERE id=v_exception_id AND document_type=v_document_type
        AND document_id=v_document_id AND status='manual_review'
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'This exception is no longer open'; END IF;
    ELSE
      v_reason := 'Live Finance verification failure';
      IF NOT EXISTS (
        SELECT 1 FROM public.finance_exception_correction_dashboard d
        WHERE d.document_type=v_document_type AND d.document_id=v_document_id
          AND d.status='Verification failed'
      ) THEN RAISE EXCEPTION 'This verification failure is no longer open'; END IF;
    END IF;

    SELECT CASE v_document_type
      WHEN 'journal' THEN v_document_id
      WHEN 'receipt' THEN (SELECT journal_entry_id FROM public.receipt_vouchers WHERE id=v_document_id)
      WHEN 'payment' THEN (SELECT journal_entry_id FROM public.payment_vouchers WHERE id=v_document_id)
      WHEN 'fund_transfer' THEN (SELECT journal_entry_id FROM public.fund_transfers WHERE id=v_document_id)
      WHEN 'loan' THEN (SELECT journal_entry_id FROM public.loans WHERE id=v_document_id)
      WHEN 'loan_transaction' THEN (SELECT journal_entry_id FROM public.loan_transactions WHERE id=v_document_id)
      WHEN 'loan_repayment' THEN (SELECT journal_entry_id FROM public.loan_transactions WHERE id=v_document_id)
      WHEN 'capital_contribution' THEN (SELECT journal_entry_id FROM public.capital_contributions WHERE id=v_document_id)
      WHEN 'tax_payment' THEN (SELECT journal_entry_id FROM public.tax_payments WHERE id=v_document_id)
      WHEN 'sales_invoice' THEN (SELECT journal_entry_id FROM public.sales_invoices WHERE id=v_document_id)
      WHEN 'purchase_invoice' THEN (SELECT journal_entry_id FROM public.purchase_invoices WHERE id=v_document_id)
      WHEN 'bank_reconciliation' THEN (SELECT matched_entry_id FROM public.bank_statement_lines WHERE id=v_document_id)
      WHEN 'expense' THEN (SELECT id FROM public.journal_entries j WHERE j.source_module IN('expense','expenses')
        AND (j.reference_id=v_document_id OR j.reference_number='EXP-'||v_document_id::text)
        AND COALESCE(j.is_reversed,false)=false ORDER BY j.is_posted DESC,j.created_at DESC LIMIT 1)
      WHEN 'petty_cash' THEN (SELECT id FROM public.journal_entries j WHERE j.source_module='petty_cash'
        AND j.reference_id=v_document_id AND COALESCE(j.is_reversed,false)=false ORDER BY j.is_posted DESC,j.created_at DESC LIMIT 1)
    END INTO v_journal_id;

    IF v_journal_id IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id',id,'debit',debit,'credit',credit) ORDER BY id)
      INTO v_before_lines FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
    END IF;

    IF v_bank_id IS NOT NULL THEN
      SELECT ba.coa_id,upper(ba.currency) INTO v_bank_coa_id,v_bank_currency
      FROM public.bank_accounts ba JOIN public.chart_of_accounts coa ON coa.id=ba.coa_id
      WHERE ba.id=v_bank_id AND ba.is_active=true AND coa.is_active=true AND COALESCE(coa.is_header,false)=false;
      IF v_bank_coa_id IS NULL THEN RAISE EXCEPTION 'Selected bank has no active posting account'; END IF;
    END IF;

    v_account_id := COALESCE(NULLIF(c->>'account_id','')::uuid,
      NULLIF(c->>'loan_account_id','')::uuid,
      NULLIF(c->>'capital_account_id','')::uuid,
      CASE WHEN v_bank_id IS NOT NULL THEN v_bank_coa_id END);
    IF v_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts WHERE id=v_account_id AND is_active=true AND COALESCE(is_header,false)=false
    ) THEN RAISE EXCEPTION 'Selected account is not an active posting account'; END IF;

    IF v_tax_code_id IS NOT NULL THEN
      SELECT tax_type INTO v_tax_type FROM public.tax_codes WHERE id=v_tax_code_id AND is_active=true;
      IF v_tax_type IS NULL THEN RAISE EXCEPTION 'Selected tax category is not active'; END IF;
    END IF;

    -- Source metadata. Every assignment is to an existing row; no insert,
    -- delete, posting, numbering, date, narration, or amount field is allowed.
    IF v_document_type='expense' THEN
      UPDATE public.finance_expenses SET
        expense_category=COALESCE(NULLIF(c->>'expense_category',''),expense_category),
        payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),
        pph_code_id=COALESCE(v_tax_code_id,pph_code_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),
        currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),
        bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR')
      WHERE id=v_document_id;
    ELSIF v_document_type='receipt' THEN
      UPDATE public.receipt_vouchers SET payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='payment' THEN
      UPDATE public.payment_vouchers SET payment_method=COALESCE(NULLIF(c->>'payment_type',''),payment_method),
        bank_account_id=COALESCE(v_bank_id,bank_account_id),pph_code_id=COALESCE(v_tax_code_id,pph_code_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency_code=COALESCE(v_bank_currency,currency_code),
        payment_currency=COALESCE(v_bank_currency,payment_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='loan' THEN
      UPDATE public.loans SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        coa_id=COALESCE(NULLIF(c->>'loan_account_id','')::uuid,coa_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),currency=COALESCE(v_bank_currency,currency),
        bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),functional_currency=COALESCE(functional_currency,'IDR')
      WHERE id=v_document_id;
    ELSIF v_document_type IN ('loan_transaction','loan_repayment') THEN
      UPDATE public.loan_transactions SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='capital_contribution' THEN
      UPDATE public.capital_contributions SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        contribution_type=COALESCE(NULLIF(c->>'expense_category',''),contribution_type),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),bank_account_currency=COALESCE(v_bank_currency,bank_account_currency),
        functional_currency=COALESCE(functional_currency,'IDR') WHERE id=v_document_id;
    ELSIF v_document_type='petty_cash' THEN
      UPDATE public.petty_cash_transactions SET expense_category=COALESCE(NULLIF(c->>'expense_category',''),expense_category),
        bank_account_id=COALESCE(v_bank_id,bank_account_id) WHERE id=v_document_id;
    ELSIF v_document_type='tax_payment' THEN
      UPDATE public.tax_payments SET bank_account_id=COALESCE(v_bank_id,bank_account_id),
        tax_type=COALESCE(v_tax_type,tax_type) WHERE id=v_document_id;
    ELSIF v_document_type='sales_invoice' AND NULLIF(c->>'faktur_pajak_number','') IS NOT NULL THEN
      UPDATE public.sales_invoices SET faktur_pajak_number=c->>'faktur_pajak_number' WHERE id=v_document_id;
    ELSIF v_document_type='purchase_invoice' AND NULLIF(c->>'faktur_pajak_number','') IS NOT NULL THEN
      UPDATE public.purchase_invoices SET faktur_pajak_number=c->>'faktur_pajak_number' WHERE id=v_document_id;
    ELSIF v_document_type='bank_reconciliation' AND NULLIF(c->>'payment_type','') IS NOT NULL THEN
      UPDATE public.bank_statement_lines SET payment_kind=c->>'payment_type' WHERE id=v_document_id;
    END IF;

    IF v_journal_id IS NOT NULL THEN
      UPDATE public.journal_entries SET
        source_module=COALESCE(NULLIF(c->>'document_classification',''),source_module),
        transaction_currency=COALESCE(v_bank_currency,transaction_currency),
        functional_currency=COALESCE(functional_currency,'IDR'),
        exchange_rate=COALESCE(v_exchange_rate,CASE WHEN v_bank_currency='IDR' THEN 1 END,exchange_rate),
        amounts_are_functional=COALESCE(amounts_are_functional,true)
      WHERE id=v_journal_id;
    END IF;

    IF v_account_id IS NOT NULL THEN
      IF v_line_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines WHERE id=v_line_id AND journal_entry_id=v_journal_id
      ) THEN RAISE EXCEPTION 'The account line can no longer be identified safely'; END IF;
      UPDATE public.journal_entry_lines SET account_id=v_account_id WHERE id=v_line_id;
    END IF;

    IF v_journal_id IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id',id,'debit',debit,'credit',credit) ORDER BY id)
      INTO v_after_lines FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
      IF v_before_lines IS DISTINCT FROM v_after_lines THEN
        RAISE EXCEPTION 'Correction cancelled because a debit or credit value changed';
      END IF;
    END IF;

    -- Resolve only when the specific historical problem is now disproved.
    IF v_reason ILIKE '%missing Faktur Pajak%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.sales_invoices WHERE id=v_document_id AND NULLIF(btrim(faktur_pajak_number),'') IS NOT NULL)
        OR EXISTS(SELECT 1 FROM public.purchase_invoices WHERE id=v_document_id AND NULLIF(btrim(faktur_pajak_number),'') IS NOT NULL);
    ELSIF v_reason ILIKE '%no historical transaction-date rate%' OR v_reason ILIKE '%no authoritative historical rate%' THEN
      v_resolved := v_exchange_rate IS NOT NULL AND v_exchange_rate>0;
    ELSIF v_reason ILIKE '%does not use the Expense bank account%' OR v_reason ILIKE '%does not post to this bank account%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.journal_entry_lines jl JOIN public.bank_accounts ba ON ba.coa_id=jl.account_id
        WHERE jl.journal_entry_id=v_journal_id AND ba.id=COALESCE(v_bank_id,(SELECT bank_account_id FROM public.bank_statement_lines WHERE id=v_document_id)));
    ELSIF v_reason ILIKE 'No unique authoritative relationship%' THEN
      IF v_document_type='expense' THEN v_resolved := EXISTS(SELECT 1 FROM public.finance_expenses x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL));
      ELSIF v_document_type='receipt' THEN v_resolved := EXISTS(SELECT 1 FROM public.receipt_vouchers x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL));
      ELSIF v_document_type='payment' THEN v_resolved := EXISTS(SELECT 1 FROM public.payment_vouchers x WHERE x.id=v_document_id
        AND x.transaction_currency IS NOT NULL AND x.functional_currency IS NOT NULL AND x.currency_code IS NOT NULL
        AND x.exchange_rate IS NOT NULL AND x.payment_method IS NOT NULL AND (x.payment_method<>'bank_transfer' OR x.bank_account_id IS NOT NULL)); END IF;
    ELSIF v_reason ILIKE '%metadata conflicts%' THEN
      v_resolved := v_bank_id IS NOT NULL;
    ELSIF v_reason ILIKE '%Journal metadata cannot be derived%' THEN
      v_resolved := EXISTS(SELECT 1 FROM public.journal_entries WHERE id=v_journal_id AND source_module IS NOT NULL
        AND transaction_currency IS NOT NULL AND functional_currency IS NOT NULL
        AND (transaction_currency='IDR' OR exchange_rate IS NOT NULL));
    END IF;

    IF v_exception_id IS NOT NULL AND v_resolved THEN
      UPDATE public.finance_historical_repair_exceptions SET status='resolved' WHERE id=v_exception_id;
      v_resolved_count := v_resolved_count + 1;
    END IF;

    INSERT INTO public.audit_logs(table_name,action_type,record_id,old_values,new_values,changed_fields)
    VALUES('finance_exception_correction_dashboard','update',v_document_id,
      jsonb_build_object('exception_id',v_exception_id,'journal_lines',v_before_lines),
      jsonb_build_object('correction',c,'journal_lines',v_after_lines,'resolved',v_resolved),
      ARRAY['finance_metadata','account_classification','exception_status']);
    v_saved := v_saved + 1;
  END LOOP;

  RETURN jsonb_build_object('saved',v_saved,'resolved',v_resolved_count,'refresh_required',true);
END;
$$;

REVOKE ALL ON FUNCTION public.save_finance_exception_corrections(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_finance_exception_corrections(jsonb) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
