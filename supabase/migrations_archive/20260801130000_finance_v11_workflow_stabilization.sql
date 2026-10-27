-- Finance V1.1 workflow stabilization.
-- Extends the certified V1 commands without changing posting architecture.

BEGIN;

-- Staff salary configuration belongs to the existing Staff Master.  These
-- values are inputs to the existing Expense/Payment/Salary Advance engines;
-- they do not post accounting by themselves.
ALTER TABLE public.finance_staff_master
  ADD COLUMN IF NOT EXISTS monthly_salary numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salary_type text NOT NULL DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS pph21_applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pph21_method text NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS pph21_percentage numeric(8,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS default_payment_method text NOT NULL DEFAULT 'bank_transfer';

ALTER TABLE public.finance_staff_master
  DROP CONSTRAINT IF EXISTS finance_staff_master_monthly_salary_check,
  DROP CONSTRAINT IF EXISTS finance_staff_master_salary_type_check,
  DROP CONSTRAINT IF EXISTS finance_staff_master_pph21_method_check,
  DROP CONSTRAINT IF EXISTS finance_staff_master_pph21_percentage_check,
  DROP CONSTRAINT IF EXISTS finance_staff_master_default_payment_method_check;

ALTER TABLE public.finance_staff_master
  ADD CONSTRAINT finance_staff_master_monthly_salary_check CHECK (monthly_salary >= 0),
  ADD CONSTRAINT finance_staff_master_salary_type_check CHECK (salary_type IN ('monthly','daily','hourly')),
  ADD CONSTRAINT finance_staff_master_pph21_method_check CHECK (pph21_method IN ('percentage','manual')),
  ADD CONSTRAINT finance_staff_master_pph21_percentage_check CHECK (pph21_percentage BETWEEN 0 AND 100),
  ADD CONSTRAINT finance_staff_master_default_payment_method_check
    CHECK (default_payment_method IN ('cash','bank_transfer','check','giro','other'));

COMMENT ON COLUMN public.finance_staff_master.monthly_salary IS
  'Gross monthly salary loaded by the canonical salary calculator.';
COMMENT ON COLUMN public.finance_staff_master.pph21_percentage IS
  'Company-configured PPh21 withholding percentage. The existing Expense tax posting remains authoritative.';

-- One read model for Salary Create/Edit. BPJS remains zero until the existing
-- ERP gains a certified BPJS engine; this function does not invent one.
CREATE OR REPLACE FUNCTION public.calculate_staff_salary(
  p_staff_id uuid,
  p_salary_date date DEFAULT current_date,
  p_gross_override numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_staff public.finance_staff_master%rowtype;
  v_gross numeric;
  v_advance numeric;
  v_pph21 numeric;
  v_bpjs numeric := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_staff FROM public.finance_staff_master
   WHERE id=p_staff_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'Active staff member not found'; END IF;

  v_gross := COALESCE(p_gross_override, v_staff.monthly_salary, 0);
  IF v_gross < 0 THEN RAISE EXCEPTION 'Gross salary cannot be negative'; END IF;
  SELECT COALESCE(sum(available_amount),0) INTO v_advance
    FROM public.get_outstanding_salary_advances(p_staff_id,COALESCE(p_salary_date,current_date));
  v_pph21 := CASE
    WHEN v_staff.pph21_applicable AND v_staff.pph21_method='percentage'
      THEN round(v_gross*v_staff.pph21_percentage/100,2)
    ELSE 0 END;
  v_advance := least(v_advance,greatest(v_gross-v_pph21-v_bpjs,0));

  RETURN jsonb_build_object(
    'staff_id',v_staff.id,
    'monthly_salary',v_staff.monthly_salary,
    'salary_type',v_staff.salary_type,
    'gross_salary',v_gross,
    'outstanding_salary_advances',v_advance,
    'pph21_applicable',v_staff.pph21_applicable,
    'pph21_method',v_staff.pph21_method,
    'pph21_percentage',v_staff.pph21_percentage,
    'pph21_amount',v_pph21,
    'bpjs_amount',v_bpjs,
    'net_salary_payable',greatest(v_gross-v_advance-v_pph21-v_bpjs,0),
    'default_payment_method',v_staff.default_payment_method
  );
END;
$$;

-- Keep the existing certified FIFO settlement, but cap recovery at the actual
-- salary payable after existing statutory withholding. This is the same
-- payable already posted by auto_post_expense_accounting.
CREATE OR REPLACE FUNCTION public.apply_salary_advances_to_expense(
  p_salary_expense_id uuid,
  p_apply boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_salary public.finance_expenses%ROWTYPE;
  v_staff_name text;
  v_remaining numeric;
  v_total numeric := 0;
  v_settlement jsonb;
  v_settlement_id uuid;
  v_advance record;
  v_advance_applied numeric;
  v_available numeric;
  v_to_apply numeric;
  v_currency text;
  v_application_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_salary FROM public.finance_expenses WHERE id=p_salary_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Salary expense not found'; END IF;
  IF v_salary.expense_category<>'salary' OR v_salary.staff_id IS NULL THEN
    RAISE EXCEPTION 'Salary advances require a Salary expense with a selected staff member';
  END IF;
  SELECT full_name INTO v_staff_name FROM public.finance_staff_master WHERE id=v_salary.staff_id;
  SELECT upper(COALESCE(v_salary.transaction_currency,v_salary.currency_code,'IDR')) INTO v_currency;

  SELECT greatest(v_salary.amount-COALESCE(v_salary.pph_amount,0)-COALESCE(sum(applied_amount),0),0)
    INTO v_remaining FROM public.salary_advance_applications WHERE salary_expense_id=p_salary_expense_id;
  v_remaining:=COALESCE(v_remaining,greatest(v_salary.amount-COALESCE(v_salary.pph_amount,0),0));
  IF NOT p_apply OR v_remaining<=0 THEN
    RETURN jsonb_build_object('applied',false,'total_applied',0,'remaining_salary',v_remaining);
  END IF;

  FOR v_advance IN
    SELECT pv.id,pv.voucher_number,pv.voucher_date,pv.amount
      FROM public.payment_vouchers pv
     WHERE pv.payment_purpose='salary_advance' AND pv.is_posted=true AND pv.staff_id=v_salary.staff_id
       AND NOT EXISTS(SELECT 1 FROM public.salary_advance_applications existing
         WHERE existing.advance_payment_voucher_id=pv.id AND existing.salary_expense_id=p_salary_expense_id)
     ORDER BY pv.voucher_date,pv.created_at,pv.id FOR UPDATE OF pv
  LOOP
    SELECT COALESCE(sum(applied_amount),0) INTO v_advance_applied
      FROM public.salary_advance_applications WHERE advance_payment_voucher_id=v_advance.id;
    v_available:=greatest(v_advance.amount-v_advance_applied,0);
    v_to_apply:=least(v_available,v_remaining-v_total);
    IF v_to_apply>0 THEN
      v_total:=v_total+v_to_apply;
      v_application_ids:=array_append(v_application_ids,v_advance.id);
    END IF;
    EXIT WHEN v_total>=v_remaining;
  END LOOP;
  IF v_total<=0 THEN RETURN jsonb_build_object('applied',false,'total_applied',0,'remaining_salary',v_remaining); END IF;

  v_settlement:=public.save_payment_voucher_command(
    p_voucher_id=>NULL,
    p_payload=>jsonb_build_object(
      'voucher_date',v_salary.expense_date,'staff_id',v_salary.staff_id,
      'payment_method','advance_adjustment','amount',v_total,'payment_currency',v_currency,
      'exchange_rate',CASE WHEN v_currency='IDR' THEN 1 ELSE COALESCE(v_salary.exchange_rate,1) END,
      'description','Salary Advance Recovery - '||COALESCE(v_salary.voucher_number,v_salary.id::text),
      'created_by',auth.uid(),'document_urls','[]'::jsonb),
    p_allocations=>jsonb_build_array(jsonb_build_object(
      'finance_expense_id',v_salary.id,'amount',v_total,'currency',v_currency)));
  v_settlement_id:=(v_settlement->>'id')::uuid;
  UPDATE public.payment_vouchers SET payment_purpose='salary_advance_settlement' WHERE id=v_settlement_id;
  PERFORM public.post_payment_voucher(v_settlement_id,auth.uid());

  v_remaining:=v_total;
  FOR v_advance IN
    SELECT pv.id,pv.amount FROM public.payment_vouchers pv WHERE pv.id=ANY(v_application_ids)
     ORDER BY pv.voucher_date,pv.created_at,pv.id
  LOOP
    SELECT COALESCE(sum(applied_amount),0) INTO v_advance_applied
      FROM public.salary_advance_applications WHERE advance_payment_voucher_id=v_advance.id;
    v_available:=greatest(v_advance.amount-v_advance_applied,0);
    v_to_apply:=least(v_available,v_remaining);
    IF v_to_apply>0 THEN
      INSERT INTO public.salary_advance_applications(
        advance_payment_voucher_id,salary_expense_id,settlement_payment_voucher_id,applied_amount)
      VALUES(v_advance.id,v_salary.id,v_settlement_id,v_to_apply);
      PERFORM public.refresh_salary_advance_status(v_advance.id);
      v_remaining:=v_remaining-v_to_apply;
    END IF;
    EXIT WHEN v_remaining<=0;
  END LOOP;
  RETURN jsonb_build_object(
    'applied',true,'total_applied',v_total,
    'remaining_salary',greatest(v_salary.amount-COALESCE(v_salary.pph_amount,0)-v_total,0),
    'settlement_payment_voucher_id',v_settlement_id,
    'settlement_payment_voucher_number',v_settlement->>'voucher_number');
END;
$$;

-- Payment documents already exist on payment_vouchers. Persist them through
-- the same canonical command used by Create and Edit.
CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
  p_voucher_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_number text;
  v_id uuid;
  v_date date := (p_payload->>'voucher_date')::date;
  v_currency text:=upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_bank_currency text;
  v_rate numeric:=COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
  v_docs text[];
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  IF v_currency NOT IN('IDR','USD') OR v_rate<=0 OR (v_currency='USD' AND v_rate<=1) THEN
    RAISE EXCEPTION 'Payment currency or exchange rate is invalid';
  END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency<>v_currency THEN
    RAISE EXCEPTION 'Payment currency % does not match selected bank currency %',v_currency,v_bank_currency;
  END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));
  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
  v_number := COALESCE(v_number,public.next_payment_voucher_number(v_date));
  v_id := public.save_payment_voucher_with_allocations(
    p_voucher_id=>p_voucher_id,p_voucher_number=>v_number,p_voucher_date=>v_date,
    p_supplier_id=>NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method=>p_payload->>'payment_method',p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),p_amount=>(p_payload->>'amount')::numeric,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_currency,p_exchange_rate=>v_rate,
    p_bank_amount=>NULLIF(p_payload->>'bank_amount','')::numeric,
    p_bank_charge=>COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0),
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),p_allocations=>p_allocations,
    p_staff_id=>NULLIF(p_payload->>'staff_id','')::uuid
  );
  UPDATE public.payment_vouchers pv SET
    document_urls=NULLIF(v_docs,ARRAY[]::text[]),
    currency_code=upper(COALESCE(pv.payment_currency,'IDR')),
    transaction_currency=upper(COALESCE(pv.payment_currency,'IDR')),
    functional_currency='IDR',
    bank_account_currency=upper(COALESCE(
      (SELECT ba.currency FROM public.bank_accounts ba WHERE ba.id=pv.bank_account_id),
      pv.payment_currency,'IDR'))
  WHERE pv.id=v_id;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$$;

-- Split supplier postings may contain several lines to one bank GL. Validate
-- the matching-side total, not the largest individual supplier line.
CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT 'supplier'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_je uuid;
  v_bank_coa uuid;
  v_expected numeric;
  v_bank_side numeric;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  IF p_document_type='expense' THEN
    IF NOT EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=p_document_id) THEN RAISE EXCEPTION 'Expense not found'; END IF;
    SELECT id INTO v_je FROM public.journal_entries WHERE source_module='expenses'
      AND (reference_id=p_document_id OR reference_number='EXP-'||p_document_id::text)
      AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='receipt' THEN
    SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id AND is_posted=true;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Receipt must be posted before reconciliation'; END IF;
  ELSIF p_document_type='payment' THEN
    SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id AND is_posted=true;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Payment must be posted before reconciliation'; END IF;
  ELSIF p_document_type='fund_transfer' THEN
    SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id AND status='posted';
    IF v_je IS NULL THEN RAISE EXCEPTION 'Contra must be posted before reconciliation'; END IF;
  ELSIF p_document_type='petty_cash' THEN
    SELECT id INTO v_je FROM public.journal_entries WHERE source_module='petty_cash' AND reference_id=p_document_id
      AND is_posted=true AND COALESCE(is_reversed,false)=false ORDER BY created_at DESC LIMIT 1;
  ELSIF p_document_type='tax_payment' THEN
    SELECT tp.journal_entry_id INTO v_je FROM public.tax_payments tp
    JOIN public.journal_entries je ON je.id=tp.journal_entry_id
    WHERE tp.id=p_document_id AND je.is_posted=true AND COALESCE(je.is_reversed,false)=false;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Tax Payment must have an active posted journal before reconciliation'; END IF;
  ELSIF p_document_type='journal' THEN
    SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted=true AND COALESCE(is_reversed,false)=false;
    IF v_je IS NULL THEN RAISE EXCEPTION 'Journal must be active and posted'; END IF;
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type;
  END IF;

  IF v_je IS NULL THEN RAISE EXCEPTION 'Document must have an active posted journal before reconciliation'; END IF;
  SELECT coa_id INTO v_bank_coa FROM public.bank_accounts WHERE id=v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Selected bank account has no General Ledger account'; END IF;
  v_expected:=CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN v_line.credit_amount ELSE v_line.debit_amount END;
  SELECT COALESCE(
      sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.transaction_debit ELSE jel.transaction_credit END)
        FILTER (WHERE CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.transaction_debit ELSE jel.transaction_credit END IS NOT NULL),
      sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN jel.debit ELSE jel.credit END)
    ) INTO v_bank_side
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
  IF v_bank_side IS NULL OR abs(v_bank_side-v_expected)>0.01 THEN
    RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side and transaction amount';
  END IF;

  UPDATE public.bank_statement_lines SET
    matched_expense_id=CASE WHEN p_document_type='expense' THEN p_document_id ELSE NULL END,
    matched_receipt_id=CASE WHEN p_document_type='receipt' THEN p_document_id ELSE NULL END,
    matched_payment_id=CASE WHEN p_document_type='payment' THEN p_document_id ELSE NULL END,
    matched_fund_transfer_id=CASE WHEN p_document_type='fund_transfer' THEN p_document_id ELSE NULL END,
    matched_petty_cash_id=CASE WHEN p_document_type='petty_cash' THEN p_document_id ELSE NULL END,
    matched_tax_payment_id=CASE WHEN p_document_type='tax_payment' THEN p_document_id ELSE NULL END,
    matched_entry_id=v_je,reconciliation_status='matched',matching_status='confirmed',
    matched_at=now(),matched_by=auth.uid(),manually_unlinked=false,payment_kind=COALESCE(p_payment_kind,'supplier')
  WHERE id=p_bank_line_id;
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('bank_line_id',p_bank_line_id,'document_type',p_document_type,'document_id',p_document_id,'journal_entry_id',v_je);
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_staff_salary(uuid,date,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.save_payment_voucher_command(uuid,jsonb,jsonb) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.link_bank_statement_line(uuid,text,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.calculate_staff_salary(uuid,date,numeric),
  public.save_payment_voucher_command(uuid,jsonb,jsonb),
  public.link_bank_statement_line(uuid,text,uuid,text) TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
