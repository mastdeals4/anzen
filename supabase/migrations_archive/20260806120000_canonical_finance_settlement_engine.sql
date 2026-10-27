-- Canonical Finance settlement engine.
--
-- A settlement is the amount on the active posted journal leg for the selected
-- bank account.  It is deliberately derived from the bank leg, not from a
-- document's gross/header amount.  This gives every Finance document the same
-- contract and automatically includes withholding, bank charges, FX and other
-- adjustments posted by the owning module.

BEGIN;

CREATE OR REPLACE VIEW public.vw_finance_document_settlements
WITH (security_invoker = true)
AS
WITH document_journals AS (
  SELECT 'expense'::text document_type, fe.id document_id,
         COALESCE(fe.voucher_number,fe.invoice_number,fe.id::text) document_number,
         fe.expense_date settlement_date, je.id journal_entry_id
    FROM public.finance_expenses fe
    JOIN public.journal_entries je ON je.source_module IN ('expense','expenses')
     AND (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
  UNION ALL
  SELECT 'payment',pv.id,pv.voucher_number,pv.voucher_date,pv.journal_entry_id
    FROM public.payment_vouchers pv WHERE pv.journal_entry_id IS NOT NULL
      AND COALESCE(pv.payment_method,'')<>'advance_adjustment'
  UNION ALL
  SELECT 'receipt',rv.id,rv.voucher_number,rv.voucher_date,rv.journal_entry_id
    FROM public.receipt_vouchers rv WHERE rv.journal_entry_id IS NOT NULL
  UNION ALL
  SELECT 'fund_transfer',ft.id,ft.transfer_number,ft.transfer_date,ft.journal_entry_id
    FROM public.fund_transfers ft WHERE ft.journal_entry_id IS NOT NULL
  UNION ALL
  SELECT 'petty_cash',pc.id,pc.transaction_number,pc.transaction_date,je.id
    FROM public.petty_cash_transactions pc
    JOIN public.journal_entries je ON je.source_module='petty_cash' AND je.reference_id=pc.id
    WHERE pc.fund_transfer_id IS NULL
  UNION ALL
  SELECT 'tax_payment',tp.id,
         COALESCE(tp.ntpn,tp.billing_code,tp.id::text),tp.payment_date,tp.journal_entry_id
    FROM public.tax_payments tp WHERE tp.journal_entry_id IS NOT NULL
), mapped AS (
  SELECT DISTINCT ON (document_type,document_id,journal_entry_id)
         document_type,document_id,document_number,settlement_date,journal_entry_id
    FROM document_journals
   WHERE journal_entry_id IS NOT NULL
   ORDER BY document_type,document_id,journal_entry_id
), bank_legs AS (
  SELECT m.document_type,m.document_id,m.document_number,m.settlement_date,
         m.journal_entry_id,ba.id bank_account_id,upper(COALESCE(ba.currency,'IDR')) currency,
         CASE WHEN sum(COALESCE(jel.transaction_debit,jel.debit))>0
              THEN 'credit' ELSE 'debit' END direction,
         CASE WHEN sum(COALESCE(jel.transaction_debit,jel.debit))>0
              THEN sum(COALESCE(jel.transaction_debit,jel.debit))
              ELSE sum(COALESCE(jel.transaction_credit,jel.credit)) END settlement_amount
    FROM mapped m
    JOIN public.journal_entries je ON je.id=m.journal_entry_id
      AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false
    JOIN public.journal_entry_lines jel ON jel.journal_entry_id=je.id
    JOIN public.bank_accounts ba ON ba.coa_id=jel.account_id
   GROUP BY m.document_type,m.document_id,m.document_number,m.settlement_date,
            m.journal_entry_id,ba.id,upper(COALESCE(ba.currency,'IDR'))
)
SELECT document_type,document_id,document_number,settlement_date,journal_entry_id,
       bank_account_id,currency,direction,settlement_amount
  FROM bank_legs WHERE settlement_amount>0;

COMMENT ON VIEW public.vw_finance_document_settlements IS
  'One canonical actual-bank-movement row per Finance document, posted journal and bank account. Bank Reconciliation must consume settlement_amount only.';

GRANT SELECT ON public.vw_finance_document_settlements TO authenticated,service_role;

-- Expose the canonical field directly on bank-moving document tables. These
-- values are generated from source facts, so edits cannot leave stale caches.
CREATE OR REPLACE FUNCTION public.calculate_expense_settlement_amount(
  p_category text,p_amount numeric,p_ppn numeric,p_pph numeric,p_stamp numeric,
  p_bank_charges numeric,p_broker_items jsonb
)
RETURNS numeric LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_category='pib_import' THEN COALESCE(p_amount,0)
    WHEN p_category='import_broker' THEN COALESCE(p_amount,0)
      +COALESCE((SELECT sum(CASE
        WHEN item->>'amount' IS NOT NULL AND NULLIF(item->>'amount','')::numeric<>0
          THEN NULLIF(item->>'amount','')::numeric
        ELSE COALESCE(NULLIF(item->>'dpp_amount','')::numeric,0)
             +COALESCE(NULLIF(item->>'ppn_amount','')::numeric,0) END)
        FROM jsonb_array_elements(COALESCE(p_broker_items,'[]'::jsonb)) item),0)
      +COALESCE(p_stamp,0)-COALESCE(p_pph,0)
    ELSE COALESCE(p_amount,0)+COALESCE(p_ppn,0)-COALESCE(p_pph,0)+COALESCE(p_stamp,0)
      +CASE WHEN p_category='utilities' THEN COALESCE(p_bank_charges,0) ELSE 0 END
  END;
$$;
ALTER TABLE public.finance_expenses
  ADD COLUMN IF NOT EXISTS settlement_amount numeric
  GENERATED ALWAYS AS (public.calculate_expense_settlement_amount(
    expense_category,amount,ppn_amount,pph_amount,stamp_duty_amount,bank_charges_amount,broker_items
  )) STORED;
ALTER TABLE public.payment_vouchers
  ADD COLUMN IF NOT EXISTS settlement_amount numeric
  GENERATED ALWAYS AS (COALESCE(actual_bank_debit,bank_amount,amount-COALESCE(pph_amount,0)+COALESCE(bank_charge,0))) STORED;
ALTER TABLE public.receipt_vouchers
  ADD COLUMN IF NOT EXISTS settlement_amount numeric GENERATED ALWAYS AS (amount) STORED;
ALTER TABLE public.petty_cash_transactions
  ADD COLUMN IF NOT EXISTS settlement_amount numeric GENERATED ALWAYS AS (amount) STORED;
ALTER TABLE public.tax_payments
  ADD COLUMN IF NOT EXISTS settlement_amount numeric GENERATED ALWAYS AS (amount) STORED;

COMMENT ON COLUMN public.finance_expenses.settlement_amount IS 'Actual bank movement for non-broker expenses; posted broker settlement is exposed by vw_finance_document_settlements.';
COMMENT ON COLUMN public.payment_vouchers.settlement_amount IS 'Canonical actual bank debit after withholding/conversion and including bank charges.';
COMMENT ON COLUMN public.receipt_vouchers.settlement_amount IS 'Canonical actual bank credit.';
COMMENT ON COLUMN public.petty_cash_transactions.settlement_amount IS 'Canonical cash/bank movement for this petty-cash document.';
COMMENT ON COLUMN public.tax_payments.settlement_amount IS 'Canonical actual bank debit for the tax remittance.';

-- Explicit API for detail pages and integrations that need one document's
-- canonical bank movements (fund transfers can correctly expose two legs).
CREATE OR REPLACE FUNCTION public.get_finance_document_settlements(
  p_document_type text,
  p_document_id uuid
)
RETURNS SETOF public.vw_finance_document_settlements
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT * FROM public.vw_finance_document_settlements
   WHERE document_type=p_document_type AND document_id=p_document_id
   ORDER BY bank_account_id,direction;
$$;

-- One module-neutral matcher.  Candidate amounts always come from the shared
-- settlement view; no branch is permitted to compare a gross document amount.
CREATE OR REPLACE FUNCTION public.auto_match_smart()
RETURNS TABLE(matched_count integer,suggested_count integer,skipped_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_candidate record;
  v_amount numeric;
  v_direction text;
  v_score integer;
  v_matched integer:=0;
  v_suggested integer:=0;
  v_skipped integer:=0;
BEGIN
  PERFORM public._sec_check_finance_role();

  FOR v_line IN
    SELECT * FROM public.bank_statement_lines b
     WHERE b.reconciliation_status='unmatched'
       AND b.matched_expense_id IS NULL AND b.matched_receipt_id IS NULL
       AND b.matched_payment_id IS NULL AND b.matched_petty_cash_id IS NULL
       AND b.matched_fund_transfer_id IS NULL AND b.matched_tax_payment_id IS NULL
       AND b.matched_entry_id IS NULL
     ORDER BY b.transaction_date,b.id
  LOOP
    v_amount:=CASE WHEN COALESCE(v_line.credit_amount,0)>0
                   THEN v_line.credit_amount ELSE v_line.debit_amount END;
    v_direction:=CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN 'credit' ELSE 'debit' END;

    SELECT s.*,
           abs(s.settlement_amount-v_amount) amount_diff,
           abs(v_line.transaction_date::date-s.settlement_date) date_diff
      INTO v_candidate
      FROM public.vw_finance_document_settlements s
     WHERE s.bank_account_id=v_line.bank_account_id
       AND s.direction=v_direction
       AND abs(v_line.transaction_date::date-s.settlement_date)<=7
       AND abs(s.settlement_amount-v_amount)<=greatest(1,v_amount*0.05)
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_lines used
          WHERE used.id<>v_line.id AND used.matched_entry_id=s.journal_entry_id
            AND used.bank_account_id=s.bank_account_id
            AND (CASE WHEN COALESCE(used.credit_amount,0)>0 THEN 'credit' ELSE 'debit' END)=s.direction
       )
     ORDER BY abs(s.settlement_amount-v_amount),
              abs(v_line.transaction_date::date-s.settlement_date),s.document_type,s.document_id
     LIMIT 1;

    IF NOT FOUND THEN CONTINUE; END IF;
    v_score:=CASE
      WHEN v_candidate.amount_diff<0.01 THEN 70
      WHEN v_candidate.amount_diff<=100 THEN 55
      WHEN v_candidate.amount_diff<=1000 THEN 40
      ELSE 25 END
      + CASE WHEN v_candidate.date_diff=0 THEN 20
             WHEN v_candidate.date_diff<=1 THEN 15
             WHEN v_candidate.date_diff<=3 THEN 10 ELSE 5 END
      + 10; -- exact bank account and direction are mandatory above

    IF v_score<70 THEN CONTINUE; END IF;
    UPDATE public.bank_statement_lines SET
      matched_expense_id=CASE WHEN v_candidate.document_type='expense' THEN v_candidate.document_id ELSE NULL END,
      matched_receipt_id=CASE WHEN v_candidate.document_type='receipt' THEN v_candidate.document_id ELSE NULL END,
      matched_payment_id=CASE WHEN v_candidate.document_type='payment' THEN v_candidate.document_id ELSE NULL END,
      matched_fund_transfer_id=CASE WHEN v_candidate.document_type='fund_transfer' THEN v_candidate.document_id ELSE NULL END,
      matched_petty_cash_id=CASE WHEN v_candidate.document_type='petty_cash' THEN v_candidate.document_id ELSE NULL END,
      matched_tax_payment_id=CASE WHEN v_candidate.document_type='tax_payment' THEN v_candidate.document_id ELSE NULL END,
      matched_entry_id=v_candidate.journal_entry_id,
      reconciliation_status=CASE WHEN v_score>=85 THEN 'matched' ELSE 'needs_review' END,
      matching_status=CASE WHEN v_score>=85 THEN 'confirmed' ELSE 'suggested' END,
      matched_at=now(),matched_by=auth.uid(),manually_unlinked=false,
      notes='Canonical settlement auto-match (confidence: '||v_score||'%)'
    WHERE id=v_line.id;

    IF v_candidate.document_type='expense' THEN
      PERFORM public.recalculate_expense_payment_state(v_candidate.document_id);
    END IF;
    IF v_score>=85 THEN v_matched:=v_matched+1; ELSE v_suggested:=v_suggested+1; END IF;
  END LOOP;
  RETURN QUERY SELECT v_matched,v_suggested,v_skipped;
END;
$$;

REVOKE ALL ON FUNCTION public.get_finance_document_settlements(text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.auto_match_smart() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_finance_document_settlements(text,uuid),
  public.auto_match_smart() TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
