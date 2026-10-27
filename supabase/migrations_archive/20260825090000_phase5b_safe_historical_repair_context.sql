/*
  SAPJ Phase 5B: safe historical-repair context.

  This migration adds the guard and command only.  It does not inspect or
  modify any production document, bank line, allocation, or journal.
*/
BEGIN;

CREATE TABLE IF NOT EXISTS public.finance_historical_repair_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  document_type text NOT NULL CHECK (document_type IN
    ('expense','payment','receipt','tax_payment','fund_transfer','petty_cash')),
  document_id uuid NOT NULL,
  bank_statement_line_id uuid NOT NULL REFERENCES public.bank_statement_lines(id),
  payment_kind text NOT NULL DEFAULT 'supplier' CHECK (payment_kind IN ('supplier','pph23')),
  operation text NOT NULL DEFAULT 'allocate_existing_cash_event'
    CHECK (operation IN ('allocate_existing_cash_event','create_cash_correction')),
  requested_by uuid REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  created_allocation_id uuid REFERENCES public.bank_statement_allocations(id),
  status text NOT NULL DEFAULT 'committed' CHECK (status = 'committed')
);

ALTER TABLE public.finance_historical_repair_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_historical_repair_commands_read ON public.finance_historical_repair_commands;
CREATE POLICY finance_historical_repair_commands_read
  ON public.finance_historical_repair_commands FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up
                 WHERE up.id=auth.uid() AND up.is_active=true AND up.role IN ('admin','accounts','auditor_ca')));
REVOKE ALL ON public.finance_historical_repair_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.finance_historical_repair_commands TO authenticated;

/* A transaction-local marker is accepted by accounting triggers only while a
   command row is running and the caller is an authorised finance principal. */
CREATE OR REPLACE FUNCTION public.historical_repair_context_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(current_setting('app.finance_historical_repair','true'),'off')='on'
     AND EXISTS (
       SELECT 1 FROM public.finance_historical_repair_commands c
       WHERE c.id::text=current_setting('app.finance_historical_repair_command','true')
         AND ((auth.role()='service_role' AND c.requested_by IS NULL) OR c.requested_by=auth.uid())
     )
     AND (auth.role()='service_role' OR EXISTS (
       SELECT 1 FROM public.user_profiles up
       WHERE up.id=auth.uid() AND up.is_active=true AND up.role='admin'));
$$;
REVOKE ALL ON FUNCTION public.historical_repair_context_active() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.historical_repair_context_active() TO service_role;

/* Prevent payment-state recalculation from updating a historical source row
   while the repair command is linking the evidenced cash event. */
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_supplier_paid numeric:=0; v_pph_paid numeric:=0;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;
  SELECT COALESCE(sum(allocated_amount),0) INTO v_supplier_paid FROM public.voucher_allocations
   WHERE finance_expense_id=p_expense_id AND payment_kind='supplier';
  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier';
  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
      AND NOT EXISTS(SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);
  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid FROM public.voucher_allocations
   WHERE finance_expense_id=p_expense_id AND payment_kind='pph23';
  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';
  UPDATE public.finance_expenses SET paid_amount=v_supplier_paid,pph_paid_amount=v_pph_paid WHERE id=p_expense_id;
END $$;

/* Recreate the expense trigger guard with the privileged context predicate;
   normal INSERT/UPDATE behaviour is unchanged. */
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON public.finance_expenses;
CREATE TRIGGER trigger_auto_post_expense_accounting AFTER INSERT OR UPDATE ON public.finance_expenses
FOR EACH ROW WHEN (NEW.approval_status='approved' AND NOT public.historical_repair_context_active())
EXECUTE FUNCTION public.auto_post_expense_accounting();

CREATE OR REPLACE FUNCTION public.execute_historical_finance_repair(
  p_idempotency_key text,
  p_document_type text,
  p_document_id uuid,
  p_bank_statement_line_id uuid,
  p_allocation_amount numeric,
  p_expected jsonb,
  p_payment_kind text DEFAULT 'supplier',
  p_operation text DEFAULT 'allocate_existing_cash_event'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_existing public.finance_historical_repair_commands%rowtype;
  v_cmd uuid; v_je uuid; v_correction_je uuid; v_source_amount numeric; v_bank_amount numeric;
  v_bank_coa uuid; v_ap_coa uuid; v_ap_credit numeric; v_entry_number text;
  v_before jsonb; v_after jsonb; v_alloc public.bank_statement_allocations%rowtype;
  v_je_before jsonb; v_je_after jsonb;
BEGIN
  IF auth.role()<>'service_role' AND NOT EXISTS (SELECT 1 FROM public.user_profiles
      WHERE id=auth.uid() AND is_active=true AND role='admin') THEN
    RAISE EXCEPTION 'Historical repair requires service_role or admin';
  END IF;
  IF NULLIF(trim(p_idempotency_key),'') IS NULL OR p_allocation_amount<=0 THEN
    RAISE EXCEPTION 'Idempotency key and positive allocation amount are required';
  END IF;
  SELECT * INTO v_existing FROM public.finance_historical_repair_commands
   WHERE idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN RETURN jsonb_build_object('idempotent',true,'command_id',v_existing.id,
    'allocation_id',v_existing.created_allocation_id,'before',v_existing.before_state,'after',v_existing.after_state); END IF;
  IF p_document_type NOT IN ('expense','payment','receipt','tax_payment','fund_transfer','petty_cash')
     OR p_payment_kind NOT IN ('supplier','pph23')
     OR p_operation NOT IN ('allocate_existing_cash_event','create_cash_correction') THEN
    RAISE EXCEPTION 'Unsupported historical repair document or operation';
  END IF;
  IF p_operation='create_cash_correction' AND p_document_type<>'expense' THEN
    RAISE EXCEPTION 'Cash correction is currently supported only for expenses';
  END IF;

  INSERT INTO public.finance_historical_repair_commands(idempotency_key,document_type,document_id,
    bank_statement_line_id,payment_kind,operation,requested_by,before_state,after_state,status)
  VALUES(p_idempotency_key,p_document_type,p_document_id,p_bank_statement_line_id,p_payment_kind,p_operation,auth.uid(),'{}','{}','committed')
  RETURNING id INTO v_cmd;
  PERFORM set_config('app.finance_historical_repair_command',v_cmd::text,true);
  PERFORM set_config('app.finance_historical_repair','on',true);

  PERFORM 1 FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing cash evidence'; END IF;
  SELECT COALESCE(NULLIF(debit_amount,0),credit_amount,0) INTO v_bank_amount
    FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id;
  IF v_bank_amount IS NULL OR p_allocation_amount>v_bank_amount+0.01 THEN RAISE EXCEPTION 'Amount mismatch'; END IF;

  IF p_document_type='expense' THEN
    PERFORM 1 FROM public.finance_expenses WHERE id=p_document_id FOR UPDATE;
    SELECT je.id, fe.amount INTO v_je,v_source_amount FROM public.journal_entries je
      JOIN public.finance_expenses fe ON (je.reference_id=fe.id OR je.reference_number='EXP-'||fe.id::text)
      WHERE fe.id=p_document_id AND je.source_module IN ('expense','expenses') AND je.is_posted
        AND NOT COALESCE(je.is_reversed,false) ORDER BY je.created_at DESC LIMIT 1;
  ELSIF p_document_type='receipt' THEN
    SELECT journal_entry_id,amount INTO v_je,v_source_amount FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted FOR UPDATE;
  ELSIF p_document_type='payment' THEN
    SELECT journal_entry_id,amount INTO v_je,v_source_amount FROM public.payment_vouchers WHERE id=p_document_id AND is_posted FOR UPDATE;
  ELSIF p_document_type='tax_payment' THEN
    SELECT journal_entry_id,amount INTO v_je,v_source_amount FROM public.tax_payments WHERE id=p_document_id FOR UPDATE;
  ELSE
    SELECT a.journal_entry_id, a.allocation_amount INTO v_je,v_source_amount
      FROM public.bank_statement_allocations a WHERE a.document_type=p_document_type AND a.document_id=p_document_id LIMIT 1;
    PERFORM 1 FROM public.journal_entries WHERE id=v_je AND is_posted FOR UPDATE;
  END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Missing posted source journal/evidence'; END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=v_je AND is_posted AND NOT COALESCE(is_reversed,false) FOR UPDATE;
  PERFORM 1 FROM public.journal_entry_lines WHERE journal_entry_id=v_je FOR UPDATE;
  PERFORM 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_statement_line_id FOR UPDATE;
  IF p_operation='create_cash_correction' THEN
    SELECT coa_id INTO v_bank_coa FROM public.bank_accounts
      WHERE id=(SELECT bank_account_id FROM public.bank_statement_lines WHERE id=p_bank_statement_line_id);
    SELECT id INTO v_ap_coa FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
    IF v_bank_coa IS NULL OR v_ap_coa IS NULL THEN RAISE EXCEPTION 'Missing bank or AP ledger account'; END IF;
    SELECT COALESCE(sum(jel.credit),0) INTO v_ap_credit FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id=v_je AND jel.account_id=v_ap_coa;
    IF abs(v_ap_credit-p_allocation_amount)>0.01 THEN
      RAISE EXCEPTION 'Recognition journal AP balance does not match evidenced cash amount';
    END IF;
    IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a
      JOIN public.journal_entry_lines l ON l.journal_entry_id=a.journal_entry_id
      WHERE a.bank_statement_line_id=p_bank_statement_line_id AND l.account_id=v_bank_coa) THEN
      RAISE EXCEPTION 'A bank-side cash event already exists for this evidence';
    END IF;
  END IF;
  SELECT jsonb_build_object('journal_id',je.id,'total_debit',je.total_debit,'total_credit',je.total_credit,
    'line_count',(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id),
    'allocations',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.bank_statement_allocations a WHERE a.journal_entry_id=je.id))
    INTO v_before FROM public.journal_entries je WHERE je.id=v_je;
  v_je_before:=v_before;
  IF p_expected ? 'journal_id' AND p_expected->>'journal_id'<>v_je::text THEN RAISE EXCEPTION 'Unexpected journal'; END IF;
  IF p_expected ? 'bank_amount' AND abs((p_expected->>'bank_amount')::numeric-v_bank_amount)>0.01 THEN RAISE EXCEPTION 'Unexpected bank amount'; END IF;
  IF p_expected ? 'document_amount' AND v_source_amount IS NOT NULL
     AND abs((p_expected->>'document_amount')::numeric-v_source_amount)>0.01 THEN RAISE EXCEPTION 'Unexpected document amount'; END IF;
  IF EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_statement_line_id
      AND document_type=p_document_type AND document_id=p_document_id AND payment_kind=p_payment_kind) THEN
    RAISE EXCEPTION 'Duplicate cash event';
  END IF;
  IF p_operation='create_cash_correction' THEN
    v_entry_number:=public.generate_journal_entry_number();
    INSERT INTO public.journal_entries(entry_number,entry_date,source_module,reference_id,reference_number,
      description,total_debit,total_credit,is_posted,posted_at,posted_by,created_by)
    SELECT v_entry_number,bsl.transaction_date,'historical_repair',p_document_id,
      'HR-'||v_cmd::text,'Explicit historical cash correction for '||fe.voucher_number,
      round(p_allocation_amount,2),round(p_allocation_amount,2),true,now(),auth.uid(),auth.uid()
    FROM public.bank_statement_lines bsl CROSS JOIN public.finance_expenses fe
    WHERE bsl.id=p_bank_statement_line_id AND fe.id=p_document_id
    RETURNING id INTO v_correction_je;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_correction_je,1,v_ap_coa,round(p_allocation_amount,2),0,'Settlement of supplier payable',
      (SELECT supplier_id FROM public.finance_expenses WHERE id=p_document_id));
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id)
    VALUES(v_correction_je,2,v_bank_coa,0,round(p_allocation_amount,2),'Actual bank payment',
      (SELECT supplier_id FROM public.finance_expenses WHERE id=p_document_id));
    v_je:=v_correction_je;
  END IF;
  INSERT INTO public.bank_statement_allocations(bank_statement_line_id,document_type,document_id,journal_entry_id,
    allocation_amount,payment_kind,created_by) VALUES(p_bank_statement_line_id,p_document_type,p_document_id,v_je,
    round(p_allocation_amount,2),p_payment_kind,auth.uid()) RETURNING * INTO v_alloc;
  SELECT jsonb_build_object('journal_id',je.id,'total_debit',je.total_debit,'total_credit',je.total_credit,
    'line_count',(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=je.id),
    'allocation_id',v_alloc.id,'allocation_amount',v_alloc.allocation_amount) INTO v_after
    FROM public.journal_entries je WHERE je.id=v_je;
  IF v_after->>'journal_id'<>v_je_before->>'journal_id' OR v_after->>'total_debit'<>v_je_before->>'total_debit'
     OR v_after->>'total_credit'<>v_je_before->>'total_credit' THEN
    IF p_operation<>'create_cash_correction' THEN RAISE EXCEPTION 'Unexpected journal change'; END IF;
  END IF;
  IF p_operation='create_cash_correction' THEN
    UPDATE public.finance_expenses SET paid_amount=COALESCE(paid_amount,0)+round(p_allocation_amount,2)
      WHERE id=p_document_id;
  END IF;
  UPDATE public.finance_historical_repair_commands SET before_state=v_before,after_state=v_after,created_allocation_id=v_alloc.id
    WHERE id=v_cmd;
  RETURN jsonb_build_object('idempotent',false,'command_id',v_cmd,'allocation_id',v_alloc.id,'before',v_before,'after',v_after);
END $$;

REVOKE ALL ON FUNCTION public.execute_historical_finance_repair(text,text,uuid,uuid,numeric,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_historical_finance_repair(text,text,uuid,uuid,numeric,jsonb,text,text) TO authenticated,service_role;
COMMENT ON FUNCTION public.execute_historical_finance_repair IS
  'Privileged, transaction-scoped, idempotent historical allocation or explicit cash correction. Existing recognition journals are immutable; no ordinary document sync path is called.';

NOTIFY pgrst,'reload schema';
COMMIT;
