-- Tally-style partial bank reconciliation using the existing bank statement
-- and document/journal contract.  This is a linking layer only: it does not
-- create or alter source documents, payments, journals, or tax amounts.

BEGIN;

CREATE TABLE public.bank_statement_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_statement_line_id uuid NOT NULL REFERENCES public.bank_statement_lines(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('expense','receipt','payment','fund_transfer','petty_cash','tax_payment','journal')),
  document_id uuid NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  allocation_amount numeric(18,2) NOT NULL CHECK (allocation_amount > 0),
  payment_kind text NOT NULL DEFAULT 'supplier' CHECK (payment_kind IN ('supplier','pph23')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  UNIQUE (bank_statement_line_id, document_type, document_id, payment_kind)
);

CREATE INDEX idx_bank_statement_allocations_line
  ON public.bank_statement_allocations(bank_statement_line_id);
CREATE INDEX idx_bank_statement_allocations_document
  ON public.bank_statement_allocations(document_type, document_id);
CREATE INDEX idx_bank_statement_allocations_journal
  ON public.bank_statement_allocations(journal_entry_id);

ALTER TABLE public.bank_statement_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Finance users can read bank allocations"
  ON public.bank_statement_allocations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id=auth.uid() AND is_active=true
      AND role IN ('admin','accounts','auditor_ca')
  ));

-- Preserve every existing reconciliation as one allocation. Direct typed FKs
-- remain intact for compatibility with older reports and historical links.
INSERT INTO public.bank_statement_allocations(
  bank_statement_line_id,document_type,document_id,journal_entry_id,
  allocation_amount,payment_kind,created_at,created_by
)
SELECT b.id, x.document_type, x.document_id, b.matched_entry_id,
       COALESCE(NULLIF(b.debit_amount,0),b.credit_amount),
       COALESCE(b.payment_kind,'supplier'),COALESCE(b.matched_at,b.created_at),b.matched_by
FROM public.bank_statement_lines b
CROSS JOIN LATERAL (
  SELECT 'expense'::text,b.matched_expense_id WHERE b.matched_expense_id IS NOT NULL
  UNION ALL SELECT 'receipt',b.matched_receipt_id WHERE b.matched_receipt_id IS NOT NULL
  UNION ALL SELECT 'payment',b.matched_payment_id WHERE b.matched_payment_id IS NOT NULL
  UNION ALL SELECT 'fund_transfer',b.matched_fund_transfer_id WHERE b.matched_fund_transfer_id IS NOT NULL
  UNION ALL SELECT 'petty_cash',b.matched_petty_cash_id WHERE b.matched_petty_cash_id IS NOT NULL
  UNION ALL SELECT 'tax_payment',b.matched_tax_payment_id WHERE b.matched_tax_payment_id IS NOT NULL
  UNION ALL SELECT 'journal',b.matched_entry_id
    WHERE b.matched_entry_id IS NOT NULL
      AND b.matched_expense_id IS NULL AND b.matched_receipt_id IS NULL
      AND b.matched_payment_id IS NULL AND b.matched_fund_transfer_id IS NULL
      AND b.matched_petty_cash_id IS NULL AND b.matched_tax_payment_id IS NULL
) x(document_type,document_id)
WHERE b.matched_entry_id IS NOT NULL
  AND COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)>0
ON CONFLICT DO NOTHING;

ALTER TABLE public.bank_statement_lines
  DROP CONSTRAINT bank_statement_lines_reconciliation_status_check;
ALTER TABLE public.bank_statement_lines
  ADD CONSTRAINT bank_statement_lines_reconciliation_status_check
  CHECK (reconciliation_status IN ('unmatched','partially_reconciled','matched','needs_review','recorded'));

-- The existing status safety trigger treated a row without a single typed FK
-- as unmatched. Multiple allocations deliberately have no single owner, so
-- allocation existence is now part of the same status truth check.
CREATE OR REPLACE FUNCTION public.bsl_sync_reconciliation_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_has_allocation boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id=NEW.id)
    INTO v_has_allocation;
  IF NEW.matched_expense_id IS NOT NULL OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL OR NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL OR NEW.matched_entry_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL OR v_has_allocation THEN
    IF NEW.reconciliation_status IS NULL OR NEW.reconciliation_status='unmatched' THEN
      NEW.reconciliation_status:='matched';
    END IF;
  ELSE
    NEW.reconciliation_status:='unmatched'; NEW.matched_at:=NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_bank_line_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_total numeric; v_allocated numeric;
BEGIN
  SELECT COALESCE(NULLIF(debit_amount,0),credit_amount,0) INTO v_total
  FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  SELECT COALESCE(sum(allocation_amount),0) INTO v_allocated
  FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;
  UPDATE public.bank_statement_lines SET
    reconciliation_status=CASE WHEN v_allocated<=0.01 THEN 'unmatched'
      WHEN v_allocated<v_total-0.01 THEN 'partially_reconciled' ELSE 'matched' END,
    matching_status=CASE WHEN v_allocated<=0.01 THEN 'none' ELSE 'confirmed' END,
    matched_at=CASE WHEN v_allocated<=0.01 THEN NULL ELSE COALESCE(matched_at,now()) END,
    matched_by=CASE WHEN v_allocated<=0.01 THEN NULL ELSE COALESCE(matched_by,auth.uid()) END,
    -- Manual allocation lines must not be picked up again by the legacy
    -- exact auto-matcher while still partial or represented by multiple rows.
    manually_unlinked=true
  WHERE id=p_bank_line_id;
END $$;

-- Derived expense settlement remains sourced from voucher allocations plus
-- bank allocations. Legacy direct links are counted only when not backfilled.
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_supplier_paid numeric:=0; v_pph_paid numeric:=0;
BEGIN
  SELECT COALESCE(sum(allocated_amount),0) INTO v_supplier_paid FROM public.voucher_allocations
   WHERE finance_expense_id=p_expense_id AND payment_kind='supplier';
  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier';
  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
      AND NOT EXISTS(SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);

  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid FROM public.voucher_allocations
   WHERE finance_expense_id=p_expense_id AND payment_kind='pph23';
  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';
  SELECT v_pph_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_pph_paid
    FROM public.bank_statement_lines b WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='pph23'
      AND NOT EXISTS(SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);
  UPDATE public.finance_expenses SET paid_amount=v_supplier_paid,pph_paid_amount=v_pph_paid WHERE id=p_expense_id;
END $$;

CREATE OR REPLACE FUNCTION public.get_expense_pph_period_date(p_expense_id uuid)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE((SELECT max(payment_date) FROM (
    SELECT pv.voucher_date payment_date FROM public.voucher_allocations va
    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
    WHERE va.finance_expense_id=fe.id AND COALESCE(va.payment_kind,'supplier')='supplier' AND COALESCE(pv.is_posted,false)
    UNION ALL
    SELECT b.transaction_date FROM public.bank_statement_allocations a
    JOIN public.bank_statement_lines b ON b.id=a.bank_statement_line_id
    WHERE a.document_type='expense' AND a.document_id=fe.id AND a.payment_kind='supplier'
    UNION ALL
    SELECT b.transaction_date FROM public.bank_statement_lines b
    WHERE b.matched_expense_id=fe.id AND COALESCE(b.payment_kind,'supplier')='supplier'
      AND NOT EXISTS(SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id)
  ) payments),fe.due_date,fe.expense_date)
  FROM public.finance_expenses fe WHERE fe.id=p_expense_id;
$$;

DROP FUNCTION public.link_bank_statement_line(uuid,text,uuid,text);
CREATE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,
  p_payment_kind text,p_allocation_amount numeric
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype; v_je uuid; v_bank_coa uuid;
  v_bank_total numeric; v_bank_allocated numeric; v_bank_remaining numeric;
  v_doc_total numeric; v_doc_allocated numeric; v_doc_remaining numeric; v_allocate numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;

  IF p_document_type='expense' THEN
    SELECT je.id INTO v_je FROM public.finance_expenses fe JOIN public.journal_entries je
      ON je.source_module='expenses' AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
     AND je.is_posted AND NOT COALESCE(je.is_reversed,false)
     WHERE fe.id=p_document_id ORDER BY je.created_at DESC LIMIT 1;
  ELSIF p_document_type='receipt' THEN SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='payment' THEN SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id AND is_posted;
  ELSIF p_document_type='fund_transfer' THEN SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id AND status='posted';
  ELSIF p_document_type='petty_cash' THEN SELECT id INTO v_je FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false) ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='tax_payment' THEN SELECT journal_entry_id INTO v_je FROM public.tax_payments WHERE id=p_document_id;
  ELSIF p_document_type='journal' THEN SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false);
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type; END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Document must have an active posted journal before reconciliation'; END IF;

  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Selected bank account has no General Ledger account'; END IF;
  SELECT COALESCE(sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN COALESCE(jel.transaction_debit,jel.debit)
                          ELSE COALESCE(jel.transaction_credit,jel.credit) END),0)
    INTO v_doc_total FROM public.journal_entry_lines jel WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
  IF v_doc_total<=0.01 THEN RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side'; END IF;

  v_bank_total:=COALESCE(NULLIF(v_line.debit_amount,0),v_line.credit_amount,0);
  SELECT COALESCE(sum(allocation_amount),0) INTO v_bank_allocated FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;
  SELECT COALESCE(sum(allocation_amount),0) INTO v_doc_allocated FROM public.bank_statement_allocations
   WHERE document_type=p_document_type AND document_id=p_document_id AND payment_kind=COALESCE(p_payment_kind,'supplier');
  v_bank_remaining:=v_bank_total-v_bank_allocated; v_doc_remaining:=v_doc_total-v_doc_allocated;
  v_allocate:=COALESCE(p_allocation_amount,LEAST(v_bank_remaining,v_doc_remaining));
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  INSERT INTO public.bank_statement_allocations(bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  VALUES(p_bank_line_id,p_document_type,p_document_id,v_je,round(v_allocate,2),COALESCE(p_payment_kind,'supplier'),auth.uid());

  -- Retain the historical direct-FK projection only while there is one owner.
  IF (SELECT count(*) FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id)=1 THEN
    UPDATE public.bank_statement_lines SET
      matched_expense_id=CASE WHEN p_document_type='expense' THEN p_document_id END,
      matched_receipt_id=CASE WHEN p_document_type='receipt' THEN p_document_id END,
      matched_payment_id=CASE WHEN p_document_type='payment' THEN p_document_id END,
      matched_fund_transfer_id=CASE WHEN p_document_type='fund_transfer' THEN p_document_id END,
      matched_petty_cash_id=CASE WHEN p_document_type='petty_cash' THEN p_document_id END,
      matched_tax_payment_id=CASE WHEN p_document_type='tax_payment' THEN p_document_id END,
      matched_entry_id=v_je,payment_kind=COALESCE(p_payment_kind,'supplier'),matched_at=now(),matched_by=auth.uid(),manually_unlinked=true
    WHERE id=p_bank_line_id;
  ELSE
    UPDATE public.bank_statement_lines SET matched_expense_id=NULL,matched_receipt_id=NULL,matched_payment_id=NULL,
      matched_fund_transfer_id=NULL,matched_petty_cash_id=NULL,matched_tax_payment_id=NULL,matched_entry_id=NULL,manually_unlinked=true
    WHERE id=p_bank_line_id;
  END IF;
  PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('allocation_amount',round(v_allocate,2),'bank_total',v_bank_total,
    'bank_allocated',v_bank_allocated+v_allocate,'bank_remaining',v_bank_remaining-v_allocate,
    'document_total',v_doc_total,'document_allocated',v_doc_allocated+v_allocate,'document_remaining',v_doc_remaining-v_allocate);
END $$;

CREATE FUNCTION public.unmatch_bank_statement_allocation(p_allocation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_a public.bank_statement_allocations%rowtype; v_count int; v_only public.bank_statement_allocations%rowtype;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_a FROM public.bank_statement_allocations WHERE id=p_allocation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank allocation not found'; END IF;
  DELETE FROM public.bank_statement_allocations WHERE id=p_allocation_id;
  SELECT count(*) INTO v_count FROM public.bank_statement_allocations WHERE bank_statement_line_id=v_a.bank_statement_line_id;
  IF v_count=1 THEN
    SELECT * INTO v_only FROM public.bank_statement_allocations WHERE bank_statement_line_id=v_a.bank_statement_line_id;
    UPDATE public.bank_statement_lines SET
      matched_expense_id=CASE WHEN v_only.document_type='expense' THEN v_only.document_id END,
      matched_receipt_id=CASE WHEN v_only.document_type='receipt' THEN v_only.document_id END,
      matched_payment_id=CASE WHEN v_only.document_type='payment' THEN v_only.document_id END,
      matched_fund_transfer_id=CASE WHEN v_only.document_type='fund_transfer' THEN v_only.document_id END,
      matched_petty_cash_id=CASE WHEN v_only.document_type='petty_cash' THEN v_only.document_id END,
      matched_tax_payment_id=CASE WHEN v_only.document_type='tax_payment' THEN v_only.document_id END,
      matched_entry_id=v_only.journal_entry_id,payment_kind=v_only.payment_kind
    WHERE id=v_a.bank_statement_line_id;
  ELSIF v_count=0 THEN
    UPDATE public.bank_statement_lines SET matched_expense_id=NULL,matched_receipt_id=NULL,matched_payment_id=NULL,
      matched_fund_transfer_id=NULL,matched_petty_cash_id=NULL,matched_tax_payment_id=NULL,matched_entry_id=NULL
    WHERE id=v_a.bank_statement_line_id;
  END IF;
  PERFORM public.refresh_bank_statement_allocation_status(v_a.bank_statement_line_id);
  IF v_a.document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(v_a.document_id); END IF;
  RETURN jsonb_build_object('success',true,'bank_line_id',v_a.bank_statement_line_id,'allocation_id',p_allocation_id);
END $$;

CREATE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,p_document_type text,p_document_id uuid,p_payment_kind text DEFAULT 'supplier'
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT public.link_bank_statement_line(p_bank_line_id,p_document_type,p_document_id,p_payment_kind,NULL);
$$;

CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_expense uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  PERFORM 1 FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  FOR v_expense IN SELECT document_id FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id AND document_type='expense' LOOP
    DELETE FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id AND document_type='expense' AND document_id=v_expense;
    PERFORM public.recalculate_expense_payment_state(v_expense);
  END LOOP;
  DELETE FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;
  UPDATE public.bank_statement_lines SET matched_expense_id=NULL,matched_receipt_id=NULL,matched_payment_id=NULL,
    matched_fund_transfer_id=NULL,matched_petty_cash_id=NULL,matched_tax_payment_id=NULL,matched_entry_id=NULL,
    matching_status='none',reconciliation_status='unmatched',matched_at=NULL,matched_by=NULL,notes=NULL,
    manually_unlinked=true,payment_kind='supplier' WHERE id=p_bank_line_id;
  RETURN jsonb_build_object('success',true,'bank_line_id',p_bank_line_id);
END $$;

REVOKE ALL ON TABLE public.bank_statement_allocations FROM PUBLIC,anon;
GRANT SELECT ON TABLE public.bank_statement_allocations TO authenticated;
REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric),
  public.link_bank_statement_line(uuid,text,uuid,text),
  public.unmatch_bank_statement_allocation(uuid),public.refresh_bank_statement_allocation_status(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text,numeric),
  public.link_bank_statement_line(uuid,text,uuid,text),
  public.unmatch_bank_statement_allocation(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.refresh_bank_statement_allocation_status(uuid) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
