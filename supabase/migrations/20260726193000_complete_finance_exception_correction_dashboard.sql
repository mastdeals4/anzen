-- Complete Phase 2 correction workflow without new tables or posting paths.
-- Adds business-facing detail to the existing view and wraps the existing
-- correction RPC for party, reference, transfer-bank and reconciliation-link
-- metadata. All work remains one PostgreSQL transaction.

CREATE OR REPLACE VIEW public.finance_exception_correction_dashboard
WITH (security_invoker = true) AS
WITH base AS (
  SELECT * FROM public.finance_exception_accountant_review_dashboard
  UNION ALL
  SELECT live.* FROM public.finance_live_verification_failures live
  WHERE NOT EXISTS (
    SELECT 1 FROM public.finance_exception_accountant_review_dashboard open_item
    WHERE open_item.document_type=live.document_type AND open_item.document_id=live.document_id
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

CREATE OR REPLACE FUNCTION public.save_finance_exception_corrections_v2(p_corrections jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c jsonb;
  v_type text;
  v_id uuid;
  v_exception bigint;
  v_journal uuid;
  v_line uuid;
  v_supplier uuid;
  v_customer uuid;
  v_from_bank uuid;
  v_to_bank uuid;
  v_from_old uuid;
  v_to_old uuid;
  v_from_old_coa uuid;
  v_to_old_coa uuid;
  v_from_new_coa uuid;
  v_to_new_coa uuid;
  v_from_alias text;
  v_to_alias text;
  v_from_currency text;
  v_to_currency text;
  v_link_type text;
  v_link_id uuid;
  v_result jsonb;
  v_resolved_ids jsonb := '[]'::jsonb;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF jsonb_typeof(p_corrections)<>'array' OR jsonb_array_length(p_corrections)=0 THEN
    RAISE EXCEPTION 'Select at least one correction before saving';
  END IF;
  PERFORM set_config('app.finance_historical_repair','on',true);
  PERFORM set_config('app.finance_metadata_repair','on',true);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections) LOOP
    v_type:=c->>'document_type';
    v_id:=(c->>'document_id')::uuid;
    v_exception:=NULLIF(c->>'exception_id','')::bigint;
    v_journal:=NULLIF(c->>'journal_entry_id','')::uuid;
    v_line:=NULLIF(c->>'journal_line_id','')::uuid;
    v_supplier:=NULLIF(c->>'supplier_id','')::uuid;
    v_customer:=NULLIF(c->>'customer_id','')::uuid;
    v_from_bank:=NULLIF(c->>'from_bank_account_id','')::uuid;
    v_to_bank:=NULLIF(c->>'to_bank_account_id','')::uuid;
    v_link_type:=NULLIF(c->>'linked_document_type','');
    v_link_id:=NULLIF(c->>'linked_document_id','')::uuid;

    IF NOT EXISTS (SELECT 1 FROM public.finance_exception_correction_dashboard x WHERE x.document_type=v_type AND x.document_id=v_id) THEN
      RAISE EXCEPTION 'This exception is no longer open';
    END IF;
    IF v_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id=v_supplier AND COALESCE(is_active,true)) THEN
      RAISE EXCEPTION 'Selected supplier is not active';
    END IF;
    IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id=v_customer) THEN
      RAISE EXCEPTION 'Selected customer does not exist';
    END IF;

    IF v_type='expense' THEN
      UPDATE public.finance_expenses SET
        expense_type=COALESCE(NULLIF(c->>'expense_subcategory',''),expense_type),
        supplier_id=COALESCE(v_supplier,supplier_id),
        payment_reference=COALESCE(NULLIF(c->>'reference',''),payment_reference)
      WHERE id=v_id;
    ELSIF v_type='receipt' THEN
      UPDATE public.receipt_vouchers SET customer_id=COALESCE(v_customer,customer_id),
        reference_number=COALESCE(NULLIF(c->>'reference',''),reference_number) WHERE id=v_id;
    ELSIF v_type='payment' THEN
      UPDATE public.payment_vouchers SET supplier_id=COALESCE(v_supplier,supplier_id),
        reference_number=COALESCE(NULLIF(c->>'reference',''),reference_number) WHERE id=v_id;
    ELSIF v_type='loan' THEN
      UPDATE public.loans SET loan_type=COALESCE(NULLIF(c->>'finance_classification',''),loan_type) WHERE id=v_id;
    ELSIF v_type='capital_contribution' THEN
      UPDATE public.capital_contributions SET contribution_type=COALESCE(NULLIF(c->>'finance_classification',''),contribution_type) WHERE id=v_id;
    END IF;

    IF v_line IS NOT NULL THEN
      UPDATE public.journal_entry_lines SET
        supplier_id=COALESCE(v_supplier,supplier_id),customer_id=COALESCE(v_customer,customer_id)
      WHERE id=v_line AND journal_entry_id=v_journal;
    END IF;

    IF v_type='fund_transfer' AND (v_from_bank IS NOT NULL OR v_to_bank IS NOT NULL) THEN
      SELECT from_bank_account_id,to_bank_account_id,journal_entry_id INTO v_from_old,v_to_old,v_journal
      FROM public.fund_transfers WHERE id=v_id FOR UPDATE;
      v_from_bank:=COALESCE(v_from_bank,v_from_old);
      v_to_bank:=COALESCE(v_to_bank,v_to_old);
      IF v_from_bank=v_to_bank THEN RAISE EXCEPTION 'From Bank and To Bank must be different'; END IF;
      SELECT coa_id,COALESCE(alias,account_name,bank_name),upper(currency) INTO v_from_new_coa,v_from_alias,v_from_currency
        FROM public.bank_accounts WHERE id=v_from_bank AND is_active;
      SELECT coa_id,COALESCE(alias,account_name,bank_name),upper(currency) INTO v_to_new_coa,v_to_alias,v_to_currency
        FROM public.bank_accounts WHERE id=v_to_bank AND is_active;
      SELECT coa_id INTO v_from_old_coa FROM public.bank_accounts WHERE id=v_from_old;
      SELECT coa_id INTO v_to_old_coa FROM public.bank_accounts WHERE id=v_to_old;
      IF v_from_new_coa IS NULL OR v_to_new_coa IS NULL THEN RAISE EXCEPTION 'Both transfer banks need active Bank Master posting accounts'; END IF;
      UPDATE public.journal_entry_lines SET account_id=v_from_new_coa
        WHERE journal_entry_id=v_journal AND account_id=v_from_old_coa AND COALESCE(credit,0)>0;
      UPDATE public.journal_entry_lines SET account_id=v_to_new_coa
        WHERE journal_entry_id=v_journal AND account_id=v_to_old_coa AND COALESCE(debit,0)>0;
      UPDATE public.fund_transfers SET from_bank_account_id=v_from_bank,to_bank_account_id=v_to_bank WHERE id=v_id;
    END IF;

    IF v_type='bank_reconciliation' AND v_link_id IS NOT NULL THEN
      IF v_link_type IS NULL THEN RAISE EXCEPTION 'Select the linked document type'; END IF;
      PERFORM public.link_bank_statement_line(v_id,v_link_type,v_link_id,COALESCE(NULLIF(c->>'payment_type',''),'supplier'));
    END IF;
  END LOOP;

  -- Existing RPC owns GL classification, bank master mapping, tax/currency
  -- metadata, balance protection, audit logging and reason-specific verification.
  v_result:=public.save_finance_exception_corrections(p_corrections);

  FOR c IN SELECT value FROM jsonb_array_elements(p_corrections) LOOP
    v_exception:=NULLIF(c->>'exception_id','')::bigint;
    IF v_exception IS NOT NULL AND COALESCE((c->>'confirm_resolved')::boolean,false)
       AND EXISTS (
         SELECT 1 FROM jsonb_each_text(c) x
         WHERE x.key IN ('expense_category','expense_subcategory','account_id','bank_account_id','from_bank_account_id',
           'to_bank_account_id','loan_account_id','capital_account_id','tax_code_id','payment_type','document_classification',
           'exchange_rate','faktur_pajak_number','supplier_id','customer_id','reference','finance_classification','linked_document_id')
           AND NULLIF(x.value,'') IS NOT NULL
       ) THEN
      UPDATE public.finance_historical_repair_exceptions SET status='resolved'
      WHERE id=v_exception AND status='manual_review';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.finance_exception_correction_dashboard x
      WHERE x.document_type=c->>'document_type' AND x.document_id=(c->>'document_id')::uuid
    ) THEN v_resolved_ids:=v_resolved_ids || jsonb_build_array(c->>'row_id'); END IF;
  END LOOP;

  RETURN v_result || jsonb_build_object('resolved_row_ids',v_resolved_ids,'verification_refreshed',true);
END;
$$;

REVOKE ALL ON FUNCTION public.save_finance_exception_corrections_v2(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_finance_exception_corrections_v2(jsonb) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
