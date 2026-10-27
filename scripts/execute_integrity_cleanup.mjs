import { execFileSync } from 'node:child_process';

const runSql = (sql) => {
  const stdout = execFileSync('supabase', ['db', 'query', '--linked', '--output-format', 'json', sql], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  const res = JSON.parse(stdout);
  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  return res.rows || [];
};

async function execute() {
  console.log('Starting Secondary Financial & Inventory Integrity Cleanup...');

  const migrationSql = `
BEGIN;
SELECT set_config('app.canonical_stock_engine', 'on', true);

-- 1. SALARY SETTLEMENT ALLOCATION ORDER & EVENT FLOW
-- Update save_payment_voucher_with_allocations to accept and record p_payment_purpose directly upon INSERT
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_allocations(
  p_voucher_id uuid,
  p_voucher_number text,
  p_voucher_date date,
  p_supplier_id uuid,
  p_payment_method text,
  p_bank_account_id uuid,
  p_reference_number text,
  p_amount numeric,
  p_pph_amount numeric,
  p_pph_code_id uuid,
  p_description text,
  p_payment_currency text,
  p_exchange_rate numeric,
  p_bank_amount numeric,
  p_bank_charge numeric,
  p_created_by uuid,
  p_allocations jsonb,
  p_staff_id uuid DEFAULT NULL::uuid,
  p_payment_purpose text DEFAULT 'general'::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_voucher_id UUID;
  v_alloc JSONB;
  v_alloc_amount NUMERIC;
  v_invoice_id UUID;
  v_expense_id UUID;
  v_creator UUID;
  v_purpose TEXT := COALESCE(p_payment_purpose, 'general');
BEGIN
  PERFORM public._sec_check_finance_role();
  v_creator := auth.uid();

  IF p_supplier_id IS NULL AND p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Payment voucher needs a payee: supplier or staff';
  END IF;

  IF v_purpose NOT IN ('general', 'salary_advance', 'salary_advance_settlement') THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', v_purpose;
  END IF;

  IF p_voucher_id IS NULL THEN
    INSERT INTO payment_vouchers (
      voucher_number, voucher_date, supplier_id, staff_id, payment_method,
      bank_account_id, reference_number, amount, pph_amount, pph_code_id,
      description, payment_currency, exchange_rate,
      bank_amount, bank_charge, created_by,
      payment_purpose, salary_advance_status
    ) VALUES (
      p_voucher_number, p_voucher_date, p_supplier_id, p_staff_id, p_payment_method,
      p_bank_account_id, p_reference_number, p_amount, p_pph_amount, p_pph_code_id,
      p_description, p_payment_currency, p_exchange_rate,
      p_bank_amount, p_bank_charge, v_creator,
      v_purpose,
      CASE v_purpose WHEN 'salary_advance' THEN 'outstanding' ELSE 'not_applicable' END
    ) RETURNING id INTO v_voucher_id;
  ELSE
    v_voucher_id := p_voucher_id;

    IF EXISTS (SELECT 1 FROM payment_vouchers WHERE id = v_voucher_id AND is_posted = TRUE) THEN
      RAISE EXCEPTION 'Cannot edit: % is posted. Cancel Posting first to make changes.', p_voucher_number;
    END IF;

    UPDATE payment_vouchers SET
      voucher_date          = p_voucher_date,
      supplier_id           = p_supplier_id,
      staff_id              = p_staff_id,
      payment_method        = p_payment_method,
      bank_account_id       = p_bank_account_id,
      reference_number      = p_reference_number,
      amount                = p_amount,
      pph_amount            = p_pph_amount,
      pph_code_id           = p_pph_code_id,
      description           = p_description,
      payment_currency      = p_payment_currency,
      exchange_rate         = p_exchange_rate,
      bank_amount           = p_bank_amount,
      bank_charge           = p_bank_charge,
      payment_purpose       = v_purpose,
      salary_advance_status = CASE v_purpose WHEN 'salary_advance' THEN 'outstanding' ELSE 'not_applicable' END,
      updated_at            = NOW()
    WHERE id = v_voucher_id;
  END IF;

  DELETE FROM voucher_allocations WHERE payment_voucher_id = v_voucher_id;

  FOR v_alloc IN SELECT value FROM jsonb_array_elements(p_allocations) AS value
  LOOP
    v_alloc_amount := COALESCE((v_alloc->>'amount')::NUMERIC, 0);
    IF v_alloc_amount <= 0 THEN
      CONTINUE;
    END IF;

    v_invoice_id := NULLIF(v_alloc->>'invoice_id', '')::UUID;
    v_expense_id := NULLIF(v_alloc->>'finance_expense_id', '')::UUID;

    IF v_invoice_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, purchase_invoice_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_invoice_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    ELSIF v_expense_id IS NOT NULL THEN
      INSERT INTO voucher_allocations (
        payment_voucher_id, finance_expense_id,
        allocated_amount, allocated_currency, voucher_type
      ) VALUES (
        v_voucher_id, v_expense_id, v_alloc_amount,
        COALESCE(v_alloc->>'currency', 'IDR'), 'payment'
      );
    END IF;
  END LOOP;

  RETURN v_voucher_id;
END;
$function$;

-- Update save_payment_voucher_command to support p_payment_purpose
CREATE OR REPLACE FUNCTION public.save_payment_voucher_command(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_number text;
  v_id uuid;
  v_date date := (p_payload->>'voucher_date')::date;
  v_payment_currency text := upper(COALESCE(NULLIF(p_payload->>'payment_currency',''),'IDR'));
  v_invoice_currency text := upper(COALESCE(
    NULLIF(p_payload->>'invoice_currency',''),
    NULLIF((SELECT COALESCE(a->>'currency',a->>'allocated_currency')
            FROM jsonb_array_elements(COALESCE(p_allocations,'[]'::jsonb)) a
            WHERE COALESCE(a->>'currency',a->>'allocated_currency') IS NOT NULL LIMIT 1),''),
    v_payment_currency));
  v_bank_currency text;
  v_rate numeric := COALESCE(NULLIF(p_payload->>'exchange_rate','')::numeric,1);
  v_invoice_amount numeric := COALESCE(NULLIF(p_payload->>'invoice_amount','')::numeric,
    NULLIF(p_payload->>'amount','')::numeric,0);
  v_payment_amount numeric := COALESCE(NULLIF(p_payload->>'payment_amount','')::numeric,
    v_invoice_amount-COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0));
  v_converted numeric;
  v_actual numeric;
  v_bank_charge numeric := COALESCE(NULLIF(p_payload->>'bank_charge','')::numeric,0);
  v_docs text[];
  v_purpose text := COALESCE(p_payment_purpose, NULLIF(p_payload->>'payment_purpose',''), 'general');
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts
   WHERE id=NULLIF(p_payload->>'bank_account_id','')::uuid;
  v_bank_currency:=COALESCE(v_bank_currency,v_payment_currency);
  IF v_payment_currency NOT IN('IDR','USD') OR v_invoice_currency NOT IN('IDR','USD')
     OR v_bank_currency NOT IN('IDR','USD') OR v_rate<=0 THEN
    RAISE EXCEPTION 'Payment currencies or exchange rate are invalid';
  END IF;
  v_converted:=COALESCE(NULLIF(p_payload->>'converted_amount','')::numeric,
    v_payment_amount*CASE WHEN v_invoice_currency=v_bank_currency THEN 1 ELSE v_rate END);
  v_actual:=COALESCE(NULLIF(p_payload->>'actual_bank_debit','')::numeric,
    NULLIF(p_payload->>'bank_amount','')::numeric,v_converted+v_bank_charge);
  IF v_actual<=0 AND v_invoice_amount>0 THEN RAISE EXCEPTION 'Actual bank debit must be positive'; END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));

  SELECT voucher_number INTO v_number FROM public.payment_vouchers WHERE id=p_voucher_id;
  v_number:=COALESCE(v_number,public.next_payment_voucher_number(v_date));
  v_id:=public.save_payment_voucher_with_allocations(
    p_voucher_id=>p_voucher_id,p_voucher_number=>v_number,p_voucher_date=>v_date,
    p_supplier_id=>NULLIF(p_payload->>'supplier_id','')::uuid,
    p_payment_method=>p_payload->>'payment_method',
    p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),p_amount=>v_invoice_amount,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_payment_currency,p_exchange_rate=>v_rate,
    p_bank_amount=>v_actual,p_bank_charge=>v_bank_charge,
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),
    p_allocations=>p_allocations,p_staff_id=>NULLIF(p_payload->>'staff_id','')::uuid,
    p_payment_purpose=>v_purpose);
  UPDATE public.payment_vouchers SET
    invoice_currency=v_invoice_currency,invoice_amount=v_invoice_amount,
    payment_amount=v_payment_amount,payment_currency=v_payment_currency,
    transaction_currency=v_invoice_currency,functional_currency='IDR',
    exchange_rate=v_rate,bank_currency=v_bank_currency,
    bank_account_currency=v_bank_currency,converted_amount=v_converted,
    actual_bank_debit=v_actual,bank_amount=v_actual,
    document_urls=NULLIF(v_docs,ARRAY[]::text[])
  WHERE id=v_id;
  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$function$;

-- Update save_payment_voucher_with_purpose to pass purpose directly into save_payment_voucher_command
CREATE OR REPLACE FUNCTION public.save_payment_voucher_with_purpose(
  p_voucher_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_payment_purpose text DEFAULT 'general'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM public._sec_check_finance_role();

  IF p_payment_purpose NOT IN (
    'general',
    'salary_advance',
    'salary_advance_settlement'
  ) THEN
    RAISE EXCEPTION 'Unsupported payment purpose %', p_payment_purpose;
  END IF;

  v_result := public.save_payment_voucher_command(
    p_voucher_id,
    p_payload,
    p_allocations,
    p_payment_purpose
  );

  RETURN v_result;
END;
$function$;

-- Update apply_salary_advances_to_expense to pass payment_purpose directly
CREATE OR REPLACE FUNCTION public.apply_salary_advances_to_expense(
  p_salary_expense_id uuid,
  p_apply boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
      'finance_expense_id',v_salary.id,'amount',v_total,'currency',v_currency)),
    p_payment_purpose=>'salary_advance_settlement');
  v_settlement_id:=(v_settlement->>'id')::uuid;
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
$function$;

-- Update post_payment_voucher to correctly handle salary advance debit and credit accounts
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_rate numeric;
  v_gross numeric;
  v_payment numeric;
  v_converted numeric;
  v_pph_bank numeric;
  v_charge_amt numeric;
  v_actual numeric;
  v_expected numeric;
  v_bank_spread numeric;
  v_ap_debit numeric;
  v_total_debit numeric;
  v_total_credit numeric;
  v_entry text;
  v_je uuid;
  v_line integer := 1;
  v_ap uuid;
  v_bank uuid;
  v_charge uuid;
  v_pph uuid;
  v_fx_loss uuid;
  v_fx_gain uuid;
  v_invoice_currency text;
  v_bank_currency text;
  v_actual_poster uuid;
  v_alloc_usd numeric := 0;
  v_alloc_carrying_idr numeric := 0;
  v_alloc_settle_idr numeric := 0;
  v_realized_fx numeric := 0;
  v_total_fx_loss numeric := 0;
  v_total_fx_gain numeric := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  v_invoice_currency := upper(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, v_pv.payment_currency, 'IDR'));
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
  v_bank_currency := COALESCE(v_bank_currency, v_pv.bank_currency, v_pv.payment_currency, 'IDR');
  
  v_rate := CASE WHEN v_invoice_currency = v_bank_currency THEN 1 ELSE COALESCE(v_pv.exchange_rate, 0) END;
  IF v_rate <= 0 THEN RAISE EXCEPTION 'Missing exchange rate for %', v_pv.voucher_number; END IF;

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_payment := COALESCE(v_pv.payment_amount, v_gross - COALESCE(v_pv.pph_amount, 0));
  v_converted := COALESCE(v_pv.converted_amount, v_payment * v_rate);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_converted + v_charge_amt);
  v_expected := v_converted + v_charge_amt;
  v_bank_spread := v_actual - v_expected;

  -- Compute multi-allocation invoice carrying value vs settlement value
  IF v_invoice_currency <> v_bank_currency THEN
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(pi.exchange_rate, v_rate)), 0),
      COALESCE(SUM(va.allocated_amount * v_rate), 0)
    INTO v_alloc_usd, v_alloc_carrying_idr, v_alloc_settle_idr
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = p_pv_id;

    IF v_alloc_usd > 0 THEN
      v_ap_debit := v_alloc_carrying_idr + ((v_gross - v_alloc_usd) * v_rate);
      v_realized_fx := v_alloc_settle_idr - v_alloc_carrying_idr;
    ELSE
      v_ap_debit := v_gross * v_rate;
      v_realized_fx := 0;
    END IF;
  ELSE
    v_ap_debit := v_gross * v_rate;
    v_realized_fx := 0;
  END IF;

  IF v_realized_fx > 0 THEN
    v_total_fx_loss := v_realized_fx;
  ELSIF v_realized_fx < 0 THEN
    v_total_fx_gain := abs(v_realized_fx);
  END IF;

  -- Resolve GL Accounts according to canonical purpose:
  IF v_pv.payment_purpose = 'salary_advance' THEN
    -- Salary Advance Issuance: Debits 1160 Salary Advance Asset, Credits Bank / Cash
    SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
    SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
    IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1; END IF;
  ELSIF v_pv.payment_method = 'advance_adjustment' OR v_pv.payment_purpose = 'salary_advance_settlement' THEN
    -- Salary Advance Settlement: Debits 2110 (or expense coa), Credits 1160 Salary Advance Asset
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_ap := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code = '1160' LIMIT 1;
  ELSE
    -- General AP payment
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_ap := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_ap FROM public.chart_of_accounts WHERE code = '2110' LIMIT 1;
    END IF;
    SELECT coa_id INTO v_bank FROM public.bank_accounts WHERE id = v_pv.bank_account_id;
    IF v_bank IS NULL THEN SELECT id INTO v_bank FROM public.chart_of_accounts WHERE code = '1101' LIMIT 1; END IF;
  END IF;

  SELECT id INTO v_charge FROM public.chart_of_accounts WHERE code = '7100' LIMIT 1;
  SELECT id INTO v_pph FROM public.chart_of_accounts WHERE code = '2132' LIMIT 1;
  SELECT id INTO v_fx_loss FROM public.chart_of_accounts WHERE code = '7300' LIMIT 1;
  SELECT id INTO v_fx_gain FROM public.chart_of_accounts WHERE code = '4930' LIMIT 1;

  IF v_ap IS NULL OR v_bank IS NULL THEN RAISE EXCEPTION 'Required payment accounts are missing'; END IF;
  IF v_pph_bank > 0 AND v_pph IS NULL THEN RAISE EXCEPTION 'PPh payable account is missing'; END IF;

  v_total_debit := v_ap_debit + v_charge_amt + v_total_fx_loss + GREATEST(v_bank_spread, 0);
  v_total_credit := v_actual + v_pph_bank + v_total_fx_gain + GREATEST(-v_bank_spread, 0);

  v_entry := public.next_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number, description,
    total_debit, total_credit, is_posted, posted_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number, 'Payment Voucher: ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster, v_invoice_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line: AP / Advance Asset Debit
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
  ) VALUES (
    v_je, v_line, v_ap,
    CASE WHEN v_pv.payment_purpose = 'salary_advance' THEN 'Salary Advance - ' ELSE 'Payment - ' END || v_pv.voucher_number,
    v_ap_debit, 0,
    v_invoice_currency, v_gross, 0, v_rate, v_pv.supplier_id
  );
  v_line := v_line + 1;

  -- Line: Bank Charge
  IF v_charge_amt > 0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_charge, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0,
      v_bank_currency, v_charge_amt, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Realized FX Loss
  IF v_total_fx_loss > 0 AND v_fx_loss IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_loss, 'Realized FX loss - ' || v_pv.voucher_number, v_total_fx_loss, 0,
      'IDR', v_total_fx_loss, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank Spread
  IF v_bank_spread > 0 AND v_charge IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_charge, 'Bank conversion spread - ' || v_pv.voucher_number, v_bank_spread, 0,
      v_bank_currency, v_bank_spread, 0, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: PPh Withholding
  IF v_pph_bank > 0 AND v_pph IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_pph, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank,
      v_bank_currency, 0, v_pv.pph_amount, v_rate, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Realized FX Gain
  IF v_total_fx_gain > 0 AND v_fx_gain IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_gain, 'Realized FX gain - ' || v_pv.voucher_number, 0, v_total_fx_gain,
      'IDR', 0, v_total_fx_gain, 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank Spread Credit
  IF v_bank_spread < 0 AND v_fx_gain IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
    ) VALUES (
      v_je, v_line, v_fx_gain, 'Bank conversion spread - ' || v_pv.voucher_number, 0, abs(v_bank_spread),
      v_bank_currency, 0, abs(v_bank_spread), 1, v_pv.supplier_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line: Bank / Cash / Advance Asset Credit
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate, supplier_id
  ) VALUES (
    v_je, v_line, v_bank,
    CASE 
      WHEN v_pv.payment_purpose = 'salary_advance_settlement' OR v_pv.payment_method = 'advance_adjustment' THEN 'Advance Adjustment - '
      ELSE 'Bank Payment - '
    END || v_pv.voucher_number,
    0, v_actual, v_bank_currency, 0, v_actual, 1, v_pv.supplier_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;
  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

-- Update sync_pi_state_on_pv_posting_change to also recalculate finance expenses
CREATE OR REPLACE FUNCTION public.sync_pi_state_on_pv_posting_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invoice_id uuid;
  v_expense_id uuid;
BEGIN
  IF COALESCE(OLD.is_posted, FALSE) IS DISTINCT FROM COALESCE(NEW.is_posted, FALSE) THEN
    FOR v_invoice_id IN
      SELECT DISTINCT purchase_invoice_id
      FROM public.voucher_allocations
      WHERE payment_voucher_id = NEW.id
        AND voucher_type = 'payment'
        AND purchase_invoice_id IS NOT NULL
    LOOP
      PERFORM public.recalculate_purchase_invoice_payment_state(v_invoice_id);
    END LOOP;

    FOR v_expense_id IN
      SELECT DISTINCT finance_expense_id
      FROM public.voucher_allocations
      WHERE payment_voucher_id = NEW.id
        AND voucher_type = 'payment'
        AND finance_expense_id IS NOT NULL
    LOOP
      PERFORM public.recalculate_expense_payment_state(v_expense_id);
    END LOOP;
  END IF;

  RETURN NEW;
END;
$function$;

-- Update auto_post_expense_accounting to use 2110 for unpaid expenses including salary
CREATE OR REPLACE FUNCTION public.auto_post_expense_accounting()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expense_account_id uuid;
  v_payment_account_id uuid;
  v_journal_id uuid;
  v_active_count integer;
  v_description text;
  v_credit_desc text;
  v_category_label text;
  v_bm_account_id uuid;
  v_ppn_account_id uuid;
  v_pph_account_id uuid;
  v_stamp_duty_account_id uuid;
  v_bank_charge_acc_id uuid;
  v_line_num integer;
  v_net_payment numeric(18,2);
  v_total numeric(18,2);
  v_bank_charges numeric(18,2);
BEGIN
  IF current_setting('app.finance_metadata_repair', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.approval_status <> 'approved' THEN RETURN NEW; END IF;

  IF TG_OP='UPDATE' AND OLD.approval_status='approved' THEN
    IF ROW(
      OLD.amount,OLD.expense_category,OLD.expense_date,OLD.description,
      OLD.payment_method,OLD.bank_account_id,OLD.pib_bm_amount,OLD.pib_ppn_amount,
      OLD.pib_pph_amount,OLD.ppn_amount,OLD.pph_amount,OLD.pph_code_id,OLD.stamp_duty_amount,
      OLD.fixed_asset_account_id,COALESCE(OLD.bank_charges_amount,0),
      OLD.transaction_currency,OLD.exchange_rate,OLD.supplier_id,OLD.payee_id
    ) IS NOT DISTINCT FROM ROW(
      NEW.amount,NEW.expense_category,NEW.expense_date,NEW.description,
      NEW.payment_method,NEW.bank_account_id,NEW.pib_bm_amount,NEW.pib_ppn_amount,
      NEW.pib_pph_amount,NEW.ppn_amount,NEW.pph_amount,NEW.pph_code_id,NEW.stamp_duty_amount,
      NEW.fixed_asset_account_id,COALESCE(NEW.bank_charges_amount,0),
      NEW.transaction_currency,NEW.exchange_rate,NEW.supplier_id,NEW.payee_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT count(*), (array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_active_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=NEW.id OR reference_number='EXP-'||NEW.id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);

  IF v_active_count>1 THEN
    RAISE EXCEPTION 'Expense % has multiple active journals; edit is blocked',NEW.id;
  END IF;
  IF TG_OP='UPDATE' AND OLD.approval_status='approved' AND v_active_count<>1 THEN
    RAISE EXCEPTION 'Approved expense % must have exactly one active journal before edit',NEW.id;
  END IF;
  IF v_journal_id IS NOT NULL THEN
    PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;
    DELETE FROM public.journal_entry_lines WHERE journal_entry_id=v_journal_id;
  END IF;

  IF NEW.payment_method='cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1101' LIMIT 1;
  ELSIF NEW.payment_method='petty_cash' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='1102' LIMIT 1;
  ELSIF NEW.payment_method = 'bank_transfer' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  ELSIF NEW.payment_method IS NOT NULL AND NEW.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_payment_account_id FROM public.bank_accounts WHERE id=NEW.bank_account_id;
  ELSIF NEW.payment_method IS NULL OR NEW.payment_method = 'outstanding' THEN
    SELECT id INTO v_payment_account_id FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
  END IF;
  IF v_payment_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post expense %: the selected payment/AP account is not configured',NEW.id;
  END IF;

  IF NEW.expense_category='pib_import' THEN
    v_bm_account_id:=public.get_expense_account_id('duty_customs');
    v_ppn_account_id:=public.get_expense_account_id('ppn_import');
    v_pph_account_id:=public.get_expense_account_id('pph_import');
    IF COALESCE(NEW.pib_bm_amount,0)>0 AND v_bm_account_id IS NULL THEN RAISE EXCEPTION 'Import Duty account is missing'; END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Import account is missing'; END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 AND v_pph_account_id IS NULL THEN RAISE EXCEPTION 'PPh Import account is missing'; END IF;
    v_total:=NEW.amount;
    v_journal_id:=public.upsert_expense_journal_header_in_place(
      v_journal_id,NEW.id,NEW.expense_date,COALESCE(NEW.description,'PIB Import Payment'),
      'pib_import',v_total,NEW.created_by);
    v_line_num:=1;
    IF COALESCE(NEW.pib_bm_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_bm_account_id,NEW.pib_bm_amount,0,'PIB - Import Duty (BM) [landed cost]',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.pib_ppn_amount,0,'PIB - PPN Import (Input VAT)',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    IF COALESCE(NEW.pib_pph_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_pph_account_id,NEW.pib_pph_amount,0,'PIB - PPh 22 Dibayar Dimuka',NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,NEW.amount,'PIB - Payment ['||COALESCE(NEW.description,'')||']',NEW.supplier_id,NEW.payee_id);
    RETURN NEW;
  END IF;

  IF NEW.expense_category='fixed_asset' THEN
    v_expense_account_id:=NEW.fixed_asset_account_id;
    IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'A posting Fixed Asset account is required'; END IF;
    SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
    IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
    v_description:=COALESCE(NEW.description,'Fixed Asset Purchase');
    v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0);
    v_journal_id:=public.upsert_expense_journal_header_in_place(
      v_journal_id,NEW.id,NEW.expense_date,v_description,'fixed_asset',v_total,NEW.created_by);
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,1,v_expense_account_id,NEW.amount,0,v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=2;
    IF COALESCE(NEW.ppn_amount,0)>0 THEN
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
      VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
      v_line_num:=v_line_num+1;
    END IF;
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_total,v_description,NEW.supplier_id,NEW.payee_id);
    RETURN NEW;
  END IF;

  v_expense_account_id:=CASE WHEN public.is_capitalizable_landed_cost_category(NEW.expense_category) THEN (SELECT id FROM public.chart_of_accounts WHERE code='1130' LIMIT 1) ELSE public.get_expense_account_id(NEW.expense_category) END;
  IF v_expense_account_id IS NULL THEN RAISE EXCEPTION 'No expense account is mapped for %',NEW.expense_category; END IF;
  v_category_label:=initcap(replace(NEW.expense_category,'_',' '));
  v_description:=COALESCE(NEW.description,NEW.expense_category);
  v_credit_desc:=COALESCE(substring(NEW.description FROM '^[^\n]+'),NEW.expense_category)||' ['||v_category_label||']';
  
  SELECT id INTO v_ppn_account_id FROM public.chart_of_accounts WHERE code='1150' LIMIT 1;
  SELECT id INTO v_stamp_duty_account_id FROM public.chart_of_accounts WHERE code='6950' LIMIT 1;
  IF COALESCE(NEW.ppn_amount,0)>0 AND v_ppn_account_id IS NULL THEN RAISE EXCEPTION 'PPN Masukan account 1150 is missing'; END IF;
  IF COALESCE(NEW.stamp_duty_amount,0)>0 AND v_stamp_duty_account_id IS NULL THEN RAISE EXCEPTION 'Stamp Duty account 6950 is missing'; END IF;

  IF COALESCE(NEW.pph_amount, 0) > 0 THEN
    IF NEW.pph_code_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Withholding tax amount % exists but pph_code_id is NULL', 
        NEW.id, NEW.pph_amount;
    END IF;

    v_pph_account_id := public.fn_pph_payable_account_id(NEW.pph_code_id);

    IF v_pph_account_id IS NULL THEN
      RAISE EXCEPTION 'Cannot post expense %: Tax code % has no valid GL liability account configured', 
        NEW.id, NEW.pph_code_id;
    END IF;
  END IF;

  v_bank_charges:=CASE WHEN NEW.expense_category='utilities' THEN COALESCE(NEW.bank_charges_amount,0) ELSE 0 END;
  IF v_bank_charges>0 THEN
    v_bank_charge_acc_id:=public.get_expense_account_id('bank_charges');
    IF v_bank_charge_acc_id IS NULL THEN RAISE EXCEPTION 'Bank Charges account is missing'; END IF;
  END IF;

  v_net_payment:=NEW.amount+COALESCE(NEW.ppn_amount,0)-COALESCE(NEW.pph_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;
  v_total:=NEW.amount+COALESCE(NEW.ppn_amount,0)+COALESCE(NEW.stamp_duty_amount,0)+v_bank_charges;

  v_journal_id:=public.upsert_expense_journal_header_in_place(
    v_journal_id,NEW.id,NEW.expense_date,v_description,NEW.expense_category,v_total,NEW.created_by);
  v_line_num:=1;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_expense_account_id,NEW.amount,0,v_credit_desc,NEW.supplier_id,NEW.payee_id);
  v_line_num:=v_line_num+1;

  IF COALESCE(NEW.ppn_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_ppn_account_id,NEW.ppn_amount,0,'PPN Masukan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF COALESCE(NEW.stamp_duty_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_stamp_duty_account_id,NEW.stamp_duty_amount,0,'Bea Meterai - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF v_bank_charges>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_bank_charge_acc_id,v_bank_charges,0,'Bank charges ['||v_category_label||']',NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  IF COALESCE(NEW.pph_amount,0)>0 THEN
    INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
    VALUES(v_journal_id,v_line_num,v_pph_account_id,0,NEW.pph_amount,'PPh Ditahan - '||v_description,NEW.supplier_id,NEW.payee_id);
    v_line_num:=v_line_num+1;
  END IF;

  INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,debit,credit,description,supplier_id,payee_id)
  VALUES(v_journal_id,v_line_num,v_payment_account_id,0,v_net_payment,v_credit_desc,NEW.supplier_id,NEW.payee_id);

  RETURN NEW;
END;
$function$;

-- Update normalize_unlinked_expense_payment to preserve existing payment fields on updates
CREATE OR REPLACE FUNCTION public.normalize_unlinked_expense_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF COALESCE(current_setting('app.finance_historical_repair', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.payment_method, NEW.bank_account_id, NEW.paid_by) IS NOT DISTINCT FROM (OLD.payment_method, OLD.bank_account_id, OLD.paid_by) THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_method = 'bank_transfer'
     AND COALESCE(current_setting('app.expense_atomic_bank_link', true), 'off') <> 'on' THEN
    NEW.payment_method := NULL;
    NEW.bank_account_id := NULL;
    NEW.paid_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. EXP/26-26/124 & EXPENSE PAYMENT-STATE RECALCULATION
-- Synchronize recalculate_expense_payment_state to include posted salary advance applications
CREATE OR REPLACE FUNCTION public.recalculate_expense_payment_state(p_expense_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_supplier_paid numeric := 0;
  v_pph_paid numeric := 0;
  v_payable numeric := 0;
  v_target_paid numeric;
  v_target_pph_paid numeric;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN; END IF;

  SELECT COALESCE(sum(va.allocated_amount),0) INTO v_supplier_paid
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id
     AND COALESCE(va.payment_kind,'supplier')='supplier'
     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement')
     AND (va.payment_voucher_id IS NULL OR pv.is_posted = true);

  SELECT v_supplier_paid+COALESCE(sum(allocation_amount),0) INTO v_supplier_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id
     AND COALESCE(payment_kind,'supplier')='supplier';

  SELECT v_supplier_paid+COALESCE(sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0)),0) INTO v_supplier_paid
    FROM public.bank_statement_lines b
   WHERE b.matched_expense_id=p_expense_id AND b.payment_kind='supplier'
     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id);

  -- Include posted salary advance applications (advance recovery)
  SELECT v_supplier_paid+COALESCE(sum(sa.applied_amount),0) INTO v_supplier_paid
    FROM public.salary_advance_applications sa
    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
   WHERE sa.salary_expense_id = p_expense_id AND settlement.is_posted = true;

  SELECT COALESCE(sum(allocated_amount),0) INTO v_pph_paid
    FROM public.voucher_allocations va
    LEFT JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
   WHERE va.finance_expense_id=p_expense_id AND va.payment_kind='pph23'
     AND (va.payment_voucher_id IS NULL OR pv.is_posted = true);

  SELECT v_pph_paid+COALESCE(sum(allocation_amount),0) INTO v_pph_paid
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='pph23';

  v_payable := COALESCE(public.calculate_finance_expense_payable(p_expense_id),0);
  v_target_paid := LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0));
  v_target_pph_paid := GREATEST(v_pph_paid,0);

  UPDATE public.finance_expenses
     SET paid_amount=v_target_paid,
         pph_paid_amount=v_target_pph_paid
   WHERE id=p_expense_id
     AND (paid_amount IS DISTINCT FROM v_target_paid OR pph_paid_amount IS DISTINCT FROM v_target_pph_paid);
END;
$function$;

-- Add event-driven trigger on salary_advance_applications to keep payment state fresh
CREATE OR REPLACE FUNCTION public.trg_salary_advance_application_recalc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recalculate_expense_payment_state(OLD.salary_expense_id);
    RETURN OLD;
  ELSE
    PERFORM public.recalculate_expense_payment_state(NEW.salary_expense_id);
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_salary_advance_application_recalc ON public.salary_advance_applications;
CREATE TRIGGER trg_salary_advance_application_recalc
  AFTER INSERT OR UPDATE OR DELETE ON public.salary_advance_applications
  FOR EACH ROW EXECUTE FUNCTION public.trg_salary_advance_application_recalc();

-- Trigger canonical recalculation for EXP/26-26/124
SELECT public.recalculate_expense_payment_state('05fe1a3e-4cbd-49e0-aff5-b2a4dd14dd25');

-- 3. LEGACY INVENTORY DRIFT (Cetirizine Hydrochloride USP)
-- Fix update_product_current_stock trigger to update both OLD and NEW product_id on batch reassignment
CREATE OR REPLACE FUNCTION public.update_product_current_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE products
    SET current_stock = COALESCE((
      SELECT SUM(b.current_stock)
      FROM batches b
      WHERE b.product_id = OLD.product_id
      AND b.is_active = true
      AND b.current_stock > 0
    ), 0)
    WHERE id = OLD.product_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE products
    SET current_stock = COALESCE((
      SELECT SUM(b.current_stock)
      FROM batches b
      WHERE b.product_id = NEW.product_id
      AND b.is_active = true
      AND b.current_stock > 0
    ), 0)
    WHERE id = NEW.product_id;

    IF OLD.product_id IS DISTINCT FROM NEW.product_id THEN
      UPDATE products
      SET current_stock = COALESCE((
        SELECT SUM(b.current_stock)
        FROM batches b
        WHERE b.product_id = OLD.product_id
        AND b.is_active = true
        AND b.current_stock > 0
      ), 0)
      WHERE id = OLD.product_id;
    END IF;
    RETURN NEW;
  ELSE
    UPDATE products
    SET current_stock = COALESCE((
      SELECT SUM(b.current_stock)
      FROM batches b
      WHERE b.product_id = NEW.product_id
      AND b.is_active = true
      AND b.current_stock > 0
    ), 0)
    WHERE id = NEW.product_id;
    RETURN NEW;
  END IF;
END;
$function$;

-- Update Cetirizine Hydrochloride USP (PROD-0003) current_stock to actual batch sum (0.00)
UPDATE public.products
SET current_stock = COALESCE((
  SELECT SUM(b.current_stock)
  FROM batches b
  WHERE b.product_id = '29281a04-1970-4f07-ade6-777ad193d88d'
    AND b.is_active = true
    AND b.current_stock > 0
), 0)
WHERE id = '29281a04-1970-4f07-ade6-777ad193d88d';

-- Align historical import inventory_transaction for batch 25CTH027 to PROD-031
UPDATE public.inventory_transactions
SET product_id = 'acf72a5d-e437-42a0-a765-feaed293324f'
WHERE id = '1ede1ec6-ae50-487f-abc2-92bc081663e1';

-- 4. INVENTORY TRANSACTIONS WITHOUT operation_id
-- Mark legacy historical pre-v1 records with metadata flag
UPDATE public.inventory_transactions
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"legacy_pre_v1": true}'::jsonb
WHERE operation_id IS NULL;

COMMIT;
`;

  console.log('Applying database migration...');
  const result = runSql(migrationSql);
  console.log('Migration executed successfully:', result);
}

execute().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
