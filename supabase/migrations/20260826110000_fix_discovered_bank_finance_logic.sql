-- Targeted fixes for the finance defects found during the Jan-Jul forensic
-- cleanup.  No historical rows are rewritten by this migration.
BEGIN;

-- Resolve the document represented by a posted journal.  The journal is the
-- accounting owner; bank_statement_allocations keeps the document identity in
-- sync with it for compatibility/reporting consumers.
CREATE OR REPLACE FUNCTION public.resolve_bank_allocation_document(p_journal_entry_id uuid)
RETURNS TABLE(document_type text, document_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_module text;
  v_reference uuid;
BEGIN
  SELECT lower(COALESCE(source_module,'')), reference_id
    INTO v_module, v_reference
    FROM public.journal_entries
   WHERE id = p_journal_entry_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_module IN ('payment','payments','payment_voucher')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.payment_vouchers WHERE id=v_reference) THEN
    document_type := 'payment'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('receipt','receipts','receipt_voucher')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id=v_reference) THEN
    document_type := 'receipt'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('expense','expenses')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=v_reference) THEN
    document_type := 'expense'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('fund_transfer','fund_transfers')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.fund_transfers WHERE id=v_reference) THEN
    document_type := 'fund_transfer'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('tax_payment','tax_payments')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tax_payments WHERE id=v_reference) THEN
    document_type := 'tax_payment'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module IN ('petty_cash','petty_cash_transaction')
     AND v_reference IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.petty_cash_transactions WHERE id=v_reference) THEN
    document_type := 'petty_cash'; document_id := v_reference; RETURN NEXT; RETURN;
  ELSIF v_module = 'historical_repair' AND v_reference IS NOT NULL THEN
    -- Historical correction journals intentionally retain the original source
    -- document in reference_id (HR-REV/HR-CASH/HR-AP/HR-FX chains).
    IF EXISTS (SELECT 1 FROM public.finance_expenses WHERE id=v_reference) THEN
      document_type := 'expense'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.payment_vouchers WHERE id=v_reference) THEN
      document_type := 'payment'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.receipt_vouchers WHERE id=v_reference) THEN
      document_type := 'receipt'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.fund_transfers WHERE id=v_reference) THEN
      document_type := 'fund_transfer'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.tax_payments WHERE id=v_reference) THEN
      document_type := 'tax_payment'; document_id := v_reference; RETURN NEXT; RETURN;
    ELSIF EXISTS (SELECT 1 FROM public.petty_cash_transactions WHERE id=v_reference) THEN
      document_type := 'petty_cash'; document_id := v_reference; RETURN NEXT; RETURN;
    END IF;
  END IF;

  -- A manual journal has no source-module document.  Keeping an explicit
  -- journal allocation is safer than inventing a typed document identity.
  document_type := 'journal';
  document_id := p_journal_entry_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_bank_allocation_document_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_type text;
  v_document uuid;
BEGIN
  IF NEW.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Bank allocation requires a journal target';
  END IF;

  SELECT r.document_type, r.document_id
    INTO v_type, v_document
    FROM public.resolve_bank_allocation_document(NEW.journal_entry_id) r
   LIMIT 1;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'Journal target % does not exist', NEW.journal_entry_id;
  END IF;

  -- This runs for inserts and for any metadata/journal-target update.  It
  -- makes a journal relink atomic with the document identity change, so a bank
  -- line can never point at a payment journal while retaining an expense id.
  NEW.document_type := v_type;
  NEW.document_id := v_document;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_bank_allocation_document_identity
  ON public.bank_statement_allocations;
CREATE TRIGGER trg_sync_bank_allocation_document_identity
BEFORE INSERT OR UPDATE OF journal_entry_id, document_type, document_id
ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.sync_bank_allocation_document_identity();

REVOKE ALL ON FUNCTION public.resolve_bank_allocation_document(uuid),
  public.sync_bank_allocation_document_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_bank_allocation_document(uuid),
  public.sync_bank_allocation_document_identity() TO service_role;

-- Supplier payable is the gross expense plus recoverable/input taxes and stamp
-- duty, less withholding.  Bank charges belong to account 7100 and must not
-- inflate supplier AP.
CREATE OR REPLACE FUNCTION public.calculate_finance_expense_payable(p_expense_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN fe.expense_category = 'import_broker'
      THEN COALESCE((SELECT c.final_cash_payable
                     FROM public.vw_customs_broker_accounting c
                    WHERE c.expense_id=fe.id),0)
    ELSE COALESCE(fe.amount,0)
       + COALESCE(fe.ppn_amount,0)
       - COALESCE(fe.pph_amount,0)
       + COALESCE(fe.stamp_duty_amount,0)
  END
  FROM public.finance_expenses fe
 WHERE fe.id=p_expense_id;
$$;

CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date date DEFAULT current_date
)
RETURNS TABLE(
  id uuid, supplier_id uuid, supplier_name text, staff_id uuid, staff_name text,
  invoice_number text, invoice_date date, due_date date, expense_category text,
  description text, amount numeric, paid_amount numeric, balance_amount numeric,
  days_overdue integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT fe.id, fe.supplier_id, s.company_name::text, fe.staff_id,
    sm.full_name::text, fe.invoice_number::text, fe.expense_date, fe.due_date,
    fe.expense_category::text, fe.description::text,
    public.calculate_finance_expense_payable(fe.id), COALESCE(fe.paid_amount,0),
    public.calculate_finance_expense_payable(fe.id)-COALESCE(fe.paid_amount,0),
    CASE WHEN fe.due_date IS NOT NULL AND fe.due_date < p_as_of_date
      THEN (p_as_of_date-fe.due_date)::integer ELSE 0 END
  FROM public.finance_expenses fe
  LEFT JOIN public.suppliers s ON s.id=fe.supplier_id
  LEFT JOIN public.finance_staff_master sm ON sm.id=fe.staff_id
  WHERE fe.expense_date <= p_as_of_date
    AND public.calculate_finance_expense_payable(fe.id)>COALESCE(fe.paid_amount,0)
  ORDER BY COALESCE(fe.due_date,fe.expense_date);
END;
$$;

-- Paid state is a supplier/AP state, not a raw bank-debit sum.  Cap the
-- supplier-side contribution at the canonical payable so a bank charge (or a
-- duplicate legacy debit) cannot make AP negative.  PPh remains tracked in its
-- separate paid_amount column.
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid numeric := 0;
  v_payable numeric := 0;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;

  SELECT COALESCE(sum(va.allocated_amount),0) INTO v_supplier_paid
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id
     AND COALESCE(va.payment_kind,'supplier')='supplier'
     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement');
  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id
     AND COALESCE(payment_kind,'supplier')='supplier';
  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b
   WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);
  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid
    FROM public.voucher_allocations
   WHERE finance_expense_id=p_expense_id AND payment_kind='pph23';
  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';

  v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id),0);
  UPDATE public.finance_expenses
     SET paid_amount=LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0)),
         pph_paid_amount=GREATEST(v_pph_paid,0)
   WHERE id=p_expense_id;
END;
$$;

-- Keep the salary-advance and ordinary payment paths intact while making
-- expense-bill partial payments debit only the supplier amount actually
-- allocated.  Existing expense recognition already credits PPh payable;
-- this payment event must not credit PPh a second time or manufacture FX gain
-- for an unpaid AP remainder.
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$
DECLARE
  v_pv record; v_je uuid; v_debit_account uuid; v_credit_account uuid;
  v_bank uuid; v_charge uuid; v_pph uuid; v_fx uuid; v_advance uuid;
  v_invoice_currency text; v_bank_currency text; v_rate numeric; v_gross numeric;
  v_payment numeric; v_converted numeric; v_pph_bank numeric; v_actual numeric;
  v_charge_amt numeric; v_expected numeric; v_fx_delta numeric; v_total numeric;
  v_expense_allocated_invoice numeric := 0; v_expense_allocated_bank numeric := 0;
  v_expense_alloc_count integer := 0; v_expense_mode boolean := false;
  v_line int:=1; v_entry text; v_is_advance boolean; v_is_settlement boolean;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id=p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found',p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted',v_pv.voucher_number; END IF;

  v_is_advance:=v_pv.payment_purpose='salary_advance';
  v_is_settlement:=v_pv.payment_purpose='salary_advance_settlement'
    OR v_pv.payment_method='advance_adjustment';
  IF v_is_advance AND v_is_settlement THEN
    RAISE EXCEPTION 'Salary Advance issuance cannot use advance_adjustment';
  END IF;

  v_invoice_currency:=upper(COALESCE(v_pv.invoice_currency,v_pv.transaction_currency,v_pv.payment_currency,'IDR'));
  SELECT upper(currency),coa_id INTO v_bank_currency,v_bank
    FROM public.bank_accounts WHERE id=v_pv.bank_account_id;
  v_bank_currency:=COALESCE(v_bank_currency,v_pv.bank_currency,v_pv.payment_currency,'IDR');
  v_rate:=CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate,0) END;
  IF v_rate<=0 THEN RAISE EXCEPTION 'Missing exchange rate for %',v_pv.voucher_number; END IF;
  v_gross:=COALESCE(v_pv.invoice_amount,v_pv.amount,0);
  v_payment:=COALESCE(v_pv.payment_amount,v_gross-COALESCE(v_pv.pph_amount,0));
  v_converted:=COALESCE(v_pv.converted_amount,v_payment*v_rate);
  v_pph_bank:=COALESCE(v_pv.pph_amount,0)*v_rate;
  v_charge_amt:=COALESCE(v_pv.bank_charge,0);

  SELECT COALESCE(sum(va.allocated_amount),0),
         COALESCE(sum(va.allocated_amount * CASE
           WHEN upper(COALESCE(va.allocated_currency,v_invoice_currency))=v_bank_currency THEN 1
           ELSE v_rate END),0), count(*)
    INTO v_expense_allocated_invoice,v_expense_allocated_bank,v_expense_alloc_count
    FROM public.voucher_allocations va
   WHERE va.payment_voucher_id=p_pv_id
     AND va.finance_expense_id IS NOT NULL
     AND COALESCE(va.payment_kind,'supplier')='supplier';
  v_expense_mode := v_expense_alloc_count > 0 AND NOT v_is_advance AND NOT v_is_settlement;

  IF v_expense_mode THEN
    v_converted:=v_expense_allocated_bank;
    v_pph_bank:=0; -- PPh was recognized on the expense and remains payable.
    v_expected:=v_converted+v_charge_amt;
    v_actual:=COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_expected);
    IF abs(v_actual-v_expected)>0.01 THEN
      RAISE EXCEPTION 'Expense payment cash (%) must equal allocated supplier amount plus bank charge (%)', v_actual, v_expected;
    END IF;
    v_fx_delta:=0;
  ELSE
    v_actual:=COALESCE(v_pv.actual_bank_debit,v_pv.bank_amount,v_converted-v_pph_bank+v_charge_amt);
    v_expected:=v_converted-v_pph_bank+v_charge_amt;
    v_fx_delta:=v_actual-v_expected;
  END IF;

  SELECT id INTO v_advance FROM public.chart_of_accounts WHERE code='1160' LIMIT 1;
  IF v_advance IS NULL AND (v_is_advance OR v_is_settlement) THEN
    RAISE EXCEPTION 'Staff Advances account (1160) is missing';
  END IF;
  IF v_is_advance THEN
    v_debit_account:=v_advance;
  ELSE
    SELECT id INTO v_debit_account FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_is_settlement THEN
    v_credit_account:=v_advance; v_actual:=v_converted; v_charge_amt:=0; v_fx_delta:=0;
  ELSE
    v_credit_account:=v_bank;
    IF v_credit_account IS NULL THEN
      SELECT id INTO v_credit_account FROM public.chart_of_accounts
       WHERE code=CASE WHEN v_pv.payment_method='cash' THEN '1101' ELSE '1111' END LIMIT 1;
    END IF;
  END IF;
  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code='7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
  SELECT id INTO v_fx FROM public.chart_of_accounts WHERE code='7300' LIMIT 1;
  IF v_debit_account IS NULL OR v_credit_account IS NULL THEN
    RAISE EXCEPTION 'Required payment accounts are missing';
  END IF;

  v_total:=v_converted+v_charge_amt+greatest(v_fx_delta,0);
  IF v_fx_delta<0 THEN v_total:=v_converted+v_charge_amt; END IF;
  v_entry:=public.next_journal_entry_number();
  INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,
    reference_number,description,total_debit,total_credit,is_posted,posted_by)
  VALUES(v_entry,v_pv.voucher_date,'payment',v_pv.id,v_pv.voucher_number,
    'Payment Voucher: '||v_pv.voucher_number,v_total,v_total,true,p_posted_by)
  RETURNING id INTO v_je;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
    description,debit,credit,transaction_currency,transaction_debit,
    transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_debit_account,
    CASE WHEN v_is_advance THEN 'Salary Advance Issued - '||v_pv.voucher_number
         WHEN v_is_settlement THEN 'Salary Payable Settled by Advance - '||v_pv.voucher_number
         ELSE 'Payment - '||v_pv.voucher_number END,
    v_converted,0,v_invoice_currency,
    CASE WHEN v_expense_mode THEN v_expense_allocated_invoice ELSE v_gross END,
    0,v_rate,v_pv.supplier_id);
  v_line:=v_line+1;
  IF v_charge_amt>0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,transaction_currency,transaction_debit,
      transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_charge,'Bank Charge - '||v_pv.voucher_number,
      v_charge_amt,0,v_bank_currency,v_charge_amt,0,1,v_pv.supplier_id);
    v_line:=v_line+1;
  END IF;
  IF v_pph_bank>0 AND v_pph IS NOT NULL AND NOT v_expense_mode THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,transaction_currency,transaction_debit,
      transaction_credit,exchange_rate,supplier_id)
    VALUES(v_je,v_line,v_pph,'PPh Withholding - '||v_pv.voucher_number,
      0,v_pph_bank,v_bank_currency,0,v_pv.pph_amount,v_rate,v_pv.supplier_id);
    v_line:=v_line+1;
  END IF;
  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
    description,debit,credit,transaction_currency,transaction_debit,
    transaction_credit,exchange_rate,supplier_id)
  VALUES(v_je,v_line,v_credit_account,
    CASE WHEN v_is_settlement THEN 'Salary Advance Cleared - '||v_pv.voucher_number
         WHEN v_is_advance THEN 'Salary Advance Bank Payment - '||v_pv.voucher_number
         ELSE 'Bank Payment - '||v_pv.voucher_number END,
    0,v_actual,v_bank_currency,0,v_actual,1,v_pv.supplier_id);
  v_line:=v_line+1;
  IF v_fx_delta>0 AND v_fx IS NOT NULL AND NOT v_expense_mode THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX loss - '||v_pv.voucher_number,v_fx_delta,0,v_pv.supplier_id);
  ELSIF v_fx_delta<0 AND v_fx IS NOT NULL AND NOT v_expense_mode THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,
      description,debit,credit,supplier_id)
    VALUES(v_je,v_line,v_fx,'FX gain - '||v_pv.voucher_number,0,abs(v_fx_delta),v_pv.supplier_id);
  END IF;
  UPDATE public.payment_vouchers SET is_posted=true,journal_entry_id=v_je WHERE id=p_pv_id;
  INSERT INTO public.audit_logs(table_name,record_id,action_type,old_values,new_values,user_id)
  VALUES('payment_vouchers',p_pv_id,'update',jsonb_build_object('is_posted',false),
    jsonb_build_object('is_posted',true,'journal_entry_id',v_je),p_posted_by);
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid,uuid) TO authenticated,service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
