-- Migration: 20261108150000_fix_payment_voucher_advance_adjustment_and_secure_crm_rpcs.sql
-- Description: 
--   1. Support payment_method = 'advance_adjustment' (credit COA 1160 Staff Advances) in post_payment_voucher.
--   2. Correct party_type and debit account resolution for salary advance and salary recovery vouchers.
--   3. Synchronize expense payment state upon posting voucher allocations.
--   4. Revoke execute on get_crm_document_bank_stats and get_crm_unlinked_storage_objects from anon/PUBLIC.

-- 1. Revoke anon/PUBLIC execute permissions on CRM storage RPCs
REVOKE EXECUTE ON FUNCTION public.get_crm_document_bank_stats() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_crm_unlinked_storage_objects() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_document_bank_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_unlinked_storage_objects() TO authenticated;

-- 2. Update save_payment_voucher_command party_type derivation
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
  v_staff_id uuid := NULLIF(p_payload->>'staff_id','')::uuid;
  v_customer_id uuid := NULLIF(p_payload->>'customer_id','')::uuid;
  v_supplier_id uuid := NULLIF(p_payload->>'supplier_id','')::uuid;
  v_party_type text := lower(COALESCE(
    NULLIF(p_payload->>'party_type',''),
    CASE 
      WHEN v_staff_id IS NOT NULL OR v_purpose LIKE 'salary_%' OR v_purpose LIKE '%employee%' THEN 'employee'
      WHEN v_customer_id IS NOT NULL OR v_purpose LIKE 'customer_%' THEN 'customer'
      ELSE 'supplier'
    END
  ));
  v_settle_against text := COALESCE(NULLIF(p_payload->>'settlement_against',''), 'outstanding_balance');
  v_settle_disc numeric := COALESCE(NULLIF(p_payload->>'settlement_discount','')::numeric, 0);
  v_adj_reason text := NULLIF(p_payload->>'adjustment_reason','');
  v_adj_account_id uuid := NULLIF(p_payload->>'adjustment_account_id','')::uuid;
  v_adj_notes text := NULLIF(p_payload->>'adjustment_notes','');
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
    p_voucher_id=>p_voucher_id,
    p_voucher_number=>v_number,
    p_voucher_date=>v_date,
    p_supplier_id=>v_supplier_id,
    p_payment_method=>p_payload->>'payment_method',
    p_bank_account_id=>NULLIF(p_payload->>'bank_account_id','')::uuid,
    p_reference_number=>NULLIF(p_payload->>'reference_number',''),
    p_amount=>v_invoice_amount,
    p_pph_amount=>COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    p_pph_code_id=>NULLIF(p_payload->>'pph_code_id','')::uuid,
    p_description=>NULLIF(p_payload->>'description',''),
    p_payment_currency=>v_payment_currency,
    p_exchange_rate=>v_rate,
    p_bank_amount=>v_actual,
    p_bank_charge=>v_bank_charge,
    p_created_by=>COALESCE(NULLIF(p_payload->>'created_by','')::uuid,auth.uid()),
    p_allocations=>p_allocations,
    p_staff_id=>v_staff_id,
    p_payment_purpose=>v_purpose,
    p_party_type=>v_party_type,
    p_customer_id=>v_customer_id,
    p_settlement_against=>v_settle_against,
    p_settlement_discount=>v_settle_disc,
    p_adjustment_reason=>v_adj_reason,
    p_adjustment_account_id=>v_adj_account_id,
    p_adjustment_notes=>v_adj_notes
  );

  UPDATE public.payment_vouchers SET
    invoice_currency=v_invoice_currency,
    invoice_amount=v_invoice_amount,
    payment_amount=v_payment_amount,
    payment_currency=v_payment_currency,
    transaction_currency=v_invoice_currency,
    functional_currency='IDR',
    exchange_rate=v_rate,
    bank_currency=v_bank_currency,
    bank_account_currency=v_bank_currency,
    converted_amount=v_converted,
    actual_bank_debit=v_actual,
    bank_amount=v_actual,
    document_urls=NULLIF(v_docs,ARRAY[]::text[])
  WHERE id=v_id;

  RETURN jsonb_build_object('id',v_id,'voucher_number',v_number);
END;
$function$;

-- 3. Comprehensive post_payment_voucher upgrade
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv                      RECORD;
  v_je                      UUID;
  v_entry                   TEXT;
  v_actual_poster           UUID;
  v_bank_coa                UUID;
  v_bank_active             BOOLEAN;
  v_bank_is_header          BOOLEAN;
  v_debit_coa               UUID;
  v_charge_coa              UUID;
  v_diff_coa                UUID;
  v_fx_loss_coa             UUID;
  v_fx_gain_coa             UUID;
  v_rate                    NUMERIC := 1;
  v_actual                  NUMERIC;
  v_gross                   NUMERIC;
  v_charge_amt              NUMERIC := 0;
  v_settle_diff             NUMERIC := 0;
  v_bank_currency           TEXT := 'IDR';
  v_invoice_currency        TEXT := 'IDR';
  v_party_type              TEXT;
  v_ap_relief_idr           NUMERIC := 0;
  v_bank_credit_idr         NUMERIC := 0;
  v_alloc_usd               NUMERIC := 0;
  v_alloc_carrying_idr      NUMERIC := 0;
  v_alloc_settle_idr        NUMERIC := 0;
  v_realized_fx             NUMERIC := 0;
  v_fx_loss_amt             NUMERIC := 0;
  v_fx_gain_amt             NUMERIC := 0;
  v_total_debit             NUMERIC;
  v_total_credit            NUMERIC;
  v_line                    INTEGER := 1;
  v_usd_bank_carrying_rate  NUMERIC := 1;
BEGIN
  IF auth.role() = 'authenticated' AND auth.uid() IS NOT NULL THEN
    PERFORM public._sec_check_finance_role();
  ELSIF auth.role() = 'anon' THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment voucher % not found', p_pv_id;
  END IF;

  IF v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(
    v_pv.party_type,
    CASE 
      WHEN v_pv.staff_id IS NOT NULL OR v_pv.payment_purpose LIKE 'salary_%' OR v_pv.payment_purpose LIKE '%employee%' THEN 'employee'
      WHEN v_pv.customer_id IS NOT NULL OR v_pv.payment_purpose LIKE 'customer_%' THEN 'customer'
      ELSE 'supplier'
    END
  ));
  IF v_pv.payment_purpose = 'salary_advance' THEN
    v_party_type := 'employee';
  END IF;

  v_gross := COALESCE(v_pv.amount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_actual := COALESCE(v_pv.actual_bank_debit, v_pv.bank_amount, v_gross + v_charge_amt);
  v_rate := COALESCE(NULLIF(v_pv.exchange_rate, 0), 1);
  v_bank_currency := COALESCE(v_pv.currency_code, v_pv.transaction_currency, 'IDR');

  -- Resolve Bank / Credit Account
  IF v_pv.payment_method IN ('bank_transfer', 'check', 'giro') THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'Bank account selection is mandatory for % payments (voucher %)', v_pv.payment_method, v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, ba.is_active, coa.is_header, upper(ba.currency)
    INTO v_bank_coa, v_bank_active, v_bank_is_header, v_bank_currency
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Bank account % has no linked Chart of Accounts', v_pv.bank_account_id;
    END IF;
    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is inactive', v_bank_coa;
    END IF;
    IF COALESCE(v_bank_is_header, false) THEN
      RAISE EXCEPTION 'Linked bank GL account % is a header account — leaf required', v_bank_coa;
    END IF;

    -- Dynamic derivation of USD bank carrying rate (as of voucher date)
    IF v_bank_currency = 'USD' THEN
      SELECT 
        CASE 
          WHEN NULLIF(SUM(jel.transaction_debit - jel.transaction_credit), 0) IS NOT NULL AND SUM(jel.transaction_debit - jel.transaction_credit) > 0 THEN 
            round(SUM(jel.debit - jel.credit) / SUM(jel.transaction_debit - jel.transaction_credit), 4)
          ELSE 
            COALESCE(
              (SELECT frl.revalued_rate
               FROM public.fx_revaluation_lines frl
               JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
               WHERE frl.bank_account_id = v_pv.bank_account_id
                 AND fr.status = 'posted'
                 AND fr.revaluation_date <= v_pv.voucher_date
               ORDER BY fr.revaluation_date DESC, fr.created_at DESC
               LIMIT 1),
              v_rate
            )
        END
      INTO v_usd_bank_carrying_rate
      FROM public.journal_entry_lines jel
      JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = v_bank_coa 
        AND je.is_posted = true 
        AND NOT COALESCE(je.is_reversed, false)
        AND je.entry_date <= v_pv.voucher_date;

      v_usd_bank_carrying_rate := COALESCE(v_usd_bank_carrying_rate, v_rate);
    END IF;

  ELSIF v_pv.payment_method = 'advance_adjustment' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Staff Advances account (1160) missing or inactive';
    END IF;

  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
    FROM public.chart_of_accounts
    WHERE code = '1101' AND is_active = true AND is_header = false LIMIT 1;

    IF v_bank_coa IS NULL THEN
      SELECT id, is_active, is_header INTO v_bank_coa, v_bank_active, v_bank_is_header
      FROM public.chart_of_accounts
      WHERE code = '1102' AND is_active = true AND is_header = false LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1101/1102)';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Standard Chart of Accounts
  SELECT id INTO v_fx_loss_coa FROM public.chart_of_accounts WHERE code = '7300' AND is_active = true LIMIT 1;
  SELECT id INTO v_fx_gain_coa FROM public.chart_of_accounts WHERE code = '4930' AND is_active = true LIMIT 1;

  -- Resolve Debit Control Account
  IF v_party_type = 'supplier' THEN
    IF v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance' THEN
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1170' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL THEN
        v_debit_coa := v_pv.coa_account_id;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    -- Compute Multi-Document Carrying Value vs Settlement Value with Carry-Forward Rate
    SELECT 
      COALESCE(SUM(va.allocated_amount), 0),
      COALESCE(SUM(va.allocated_amount * COALESCE(
        (SELECT frl.revalued_rate
         FROM public.fx_revaluation_lines frl
         JOIN public.fx_revaluations fr ON fr.id = frl.revaluation_id
         WHERE frl.purchase_invoice_id = va.purchase_invoice_id
           AND fr.status = 'posted'
           AND fr.revaluation_date <= v_pv.voucher_date
         ORDER BY fr.revaluation_date DESC, fr.created_at DESC
         LIMIT 1),
        pi.exchange_rate,
        v_rate
      )), 0)
    INTO v_alloc_usd, v_alloc_carrying_idr
    FROM public.voucher_allocations va
    JOIN public.purchase_invoices pi ON pi.id = va.purchase_invoice_id
    WHERE va.payment_voucher_id = p_pv_id;

    IF v_alloc_usd > 0 THEN
      v_ap_relief_idr := v_alloc_carrying_idr + ((v_gross - v_alloc_usd) * v_rate);
      
      IF v_bank_currency = 'USD' THEN
        v_alloc_settle_idr := (v_gross * v_usd_bank_carrying_rate);
        v_bank_credit_idr := (v_actual * v_usd_bank_carrying_rate);
      ELSE
        v_alloc_settle_idr := (v_gross * v_rate);
        v_bank_credit_idr := v_actual;
      END IF;

      v_realized_fx := v_alloc_settle_idr - v_ap_relief_idr;

      IF v_realized_fx > 0 THEN
        v_fx_loss_amt := v_realized_fx;
      ELSIF v_realized_fx < 0 THEN
        v_fx_gain_amt := abs(v_realized_fx);
      END IF;
    ELSE
      v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
      v_bank_credit_idr := v_actual * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END);
      v_fx_loss_amt := 0;
      v_fx_gain_amt := 0;
    END IF;

  ELSIF v_party_type = 'customer' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2111' AND is_active = true AND is_header = false LIMIT 1;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSIF v_pv.payment_purpose = 'salary_advance_settlement' 
       OR v_pv.payment_method = 'advance_adjustment'
       OR EXISTS (SELECT 1 FROM public.voucher_allocations va WHERE va.payment_voucher_id = p_pv_id AND va.finance_expense_id IS NOT NULL) THEN
      IF v_pv.coa_account_id IS NOT NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND is_active = true AND is_header = false;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2120' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    ELSE
      IF v_pv.coa_account_id IS NOT NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE id = v_pv.coa_account_id AND is_active = true AND is_header = false;
      END IF;
      IF v_debit_coa IS NULL AND v_pv.staff_id IS NOT NULL THEN
        SELECT default_gl_account_id INTO v_debit_coa FROM public.finance_staff_master WHERE id = v_pv.staff_id;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '5101' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_ap_relief_idr := (v_gross + v_settle_diff) * v_rate;
    v_bank_credit_idr := (v_actual + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'director' THEN
    DECLARE
      v_dir_loan_acc uuid;
    BEGIN
      SELECT loan_account_id INTO v_dir_loan_acc FROM public.directors WHERE id = v_pv.staff_id;
      IF v_dir_loan_acc IS NOT NULL THEN
        v_debit_coa := v_dir_loan_acc;
      ELSE
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END;
    v_ap_relief_idr := v_gross * v_rate;
    v_bank_credit_idr := v_actual * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_ap_relief_idr := v_gross * v_rate;
    v_bank_credit_idr := v_actual * v_rate;
  END IF;

  IF v_debit_coa IS NULL THEN
    RAISE EXCEPTION 'Could not resolve debit Chart of Accounts for % (voucher %)', v_party_type, v_pv.voucher_number;
  END IF;

  -- Resolve Bank Charge & Settlement Difference Accounts
  IF v_charge_amt > 0 THEN
    SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '7100' AND is_active = true LIMIT 1;
    IF v_charge_coa IS NULL THEN
      SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '8101' AND is_active = true LIMIT 1;
    END IF;
  END IF;

  IF v_settle_diff > 0 THEN
    SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '4940' AND is_active = true LIMIT 1;
    IF v_diff_coa IS NULL THEN
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '7200' AND is_active = true LIMIT 1;
    END IF;
  END IF;

  -- Calculate Total Debit and Credit
  v_total_debit := round(v_ap_relief_idr + v_fx_loss_amt + (v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END)), 2);
  v_total_credit := round(v_bank_credit_idr + v_fx_gain_amt + (v_settle_diff * v_rate), 2);

  -- Balance Tolerance Guard
  IF abs(v_total_debit - v_total_credit) > 0.05 THEN
    RAISE EXCEPTION 'Payment voucher journal does not balance: Debit %, Credit %', v_total_debit, v_total_credit;
  END IF;

  v_entry := public.next_journal_entry_number();

  -- Create Journal Entry Header
  INSERT INTO public.journal_entries(
    entry_number, entry_date, description, reference_number, reference_id,
    source_module, total_debit, total_credit, is_posted, posted_by,
    created_by, is_reversed
  ) VALUES (
    v_entry, v_pv.voucher_date,
    CASE 
      WHEN v_party_type = 'supplier' AND (v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance') THEN 'Supplier Advance - '
      WHEN v_party_type = 'supplier' THEN 'Supplier Payment - '
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' AND v_pv.payment_purpose = 'salary_advance' THEN 'Staff Salary Advance - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Payment - '
    END || v_pv.voucher_number || COALESCE(' - ' || v_pv.description, ''),
    v_pv.voucher_number, p_pv_id, 'payment',
    v_total_debit, v_total_credit, true, v_actual_poster,
    v_actual_poster, false
  ) RETURNING id INTO v_je;

  -- Line 1: Debit Accounts Payable / Control Account
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, staff_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'supplier' AND (v_pv.payment_purpose = 'supplier_advance' OR v_pv.settlement_against = 'advance') THEN 'Supplier Advance - '
      WHEN v_party_type = 'supplier' THEN 'Supplier Payment - '
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' AND v_pv.payment_purpose = 'salary_advance' THEN 'Staff Salary Advance - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Payment - '
    END || v_pv.voucher_number,
    v_ap_relief_idr, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    CASE WHEN v_party_type = 'supplier' THEN v_pv.supplier_id ELSE NULL END,
    CASE WHEN v_party_type = 'customer' THEN v_pv.customer_id ELSE NULL END,
    CASE WHEN v_party_type = 'employee' THEN v_pv.staff_id ELSE NULL END,
    NULL
  );
  v_line := v_line + 1;

  -- Line 2: Realized FX Loss (GL 7300) if any
  IF v_fx_loss_amt > 0 AND v_fx_loss_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_loss_coa, 'Realized Foreign Exchange Loss - ' || v_pv.voucher_number,
      v_fx_loss_amt, 0, 'IDR', v_fx_loss_amt, 0, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Bank Charge (GL 7100 / 8101)
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number,
      v_charge_amt * (CASE WHEN v_bank_currency = 'USD' THEN v_usd_bank_carrying_rate ELSE 1 END), 0,
      v_bank_currency, v_charge_amt, 0, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Credit Realized FX Gain (GL 4930) if any
  IF v_fx_gain_amt > 0 AND v_fx_gain_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_fx_gain_coa, 'Realized Foreign Exchange Gain - ' || v_pv.voucher_number,
      0, v_fx_gain_amt, 'IDR', 0, v_fx_gain_amt, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Settlement Discount / Difference if any
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, staff_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa, 'Settlement Discount / Difference - ' || v_pv.voucher_number,
      0, v_settle_diff * v_rate, v_bank_currency, 0, v_settle_diff, 1,
      NULL, NULL, NULL, NULL
    );
    v_line := v_line + 1;
  END IF;

  -- Line 6: Credit Bank / Cash / Staff Advances
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, staff_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 
    CASE 
      WHEN v_pv.payment_method = 'advance_adjustment' THEN 'Advance Adjustment - '
      WHEN v_pv.payment_method = 'cash' THEN 'Cash Payment - '
      ELSE 'Bank Payment - '
    END || v_pv.voucher_number,
    0, v_bank_credit_idr,
    v_bank_currency, 0, v_actual, 1,
    NULL, NULL, NULL, NULL
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  -- Recalculate Purchase Invoice balances and states
  IF v_party_type = 'supplier' THEN
    PERFORM public.recalculate_purchase_invoice_payment_state(va.purchase_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.payment_voucher_id = p_pv_id AND va.purchase_invoice_id IS NOT NULL;
  END IF;

  -- Recalculate Expense balances and states if allocated
  PERFORM public.recalculate_expense_payment_state(va.finance_expense_id)
  FROM public.voucher_allocations va
  WHERE va.payment_voucher_id = p_pv_id AND va.finance_expense_id IS NOT NULL;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.post_payment_voucher(uuid, uuid) TO authenticated;
