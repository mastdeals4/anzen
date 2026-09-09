-- Migration: 20260909153000_optimize_expense_bank_allocation_triggers.sql
-- Description: Optimize expense and bank allocation triggers to eliminate recursive ping-pong cascading
--              and redundant full-register tax recalculations that caused statement timeouts.

BEGIN;

-- 1. Guard recalculate_expense_payment_state: only write to finance_expenses when values actually change
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
  v_target_paid := LEAST(GREATEST(v_supplier_paid,0),GREATEST(v_payable,0));
  v_target_pph_paid := GREATEST(v_pph_paid,0);

  UPDATE public.finance_expenses
     SET paid_amount=v_target_paid,
         pph_paid_amount=v_target_pph_paid
   WHERE id=p_expense_id
     AND (paid_amount IS DISTINCT FROM v_target_paid OR pph_paid_amount IS DISTINCT FROM v_target_pph_paid);
END;
$function$;

-- 2. Guard trg_recompute_from_expense: only recompute tax periods when tax-relevant fields change
CREATE OR REPLACE FUNCTION public.trg_recompute_from_expense()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF COALESCE(OLD.pph_amount, 0) > 0
       OR COALESCE(OLD.pib_pph_amount, 0) > 0
       OR OLD.expense_category = 'pph_import' THEN
      PERFORM public.recompute_pph_periods_for_date(COALESCE(OLD.due_date, OLD.expense_date));
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.pph_amount, 0) > 0
       OR COALESCE(NEW.pib_pph_amount, 0) > 0
       OR NEW.expense_category = 'pph_import' THEN
      PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(NEW.id));
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (
      NEW.pph_amount IS DISTINCT FROM OLD.pph_amount OR
      NEW.pib_pph_amount IS DISTINCT FROM OLD.pib_pph_amount OR
      NEW.ppn_amount IS DISTINCT FROM OLD.ppn_amount OR
      NEW.pib_ppn_amount IS DISTINCT FROM OLD.pib_ppn_amount OR
      NEW.expense_date IS DISTINCT FROM OLD.expense_date OR
      NEW.due_date IS DISTINCT FROM OLD.due_date OR
      NEW.expense_category IS DISTINCT FROM OLD.expense_category OR
      NEW.approval_status IS DISTINCT FROM OLD.approval_status OR
      NEW.pph_code_id IS DISTINCT FROM OLD.pph_code_id
    ) THEN
      IF COALESCE(NEW.pph_amount, 0) > 0
         OR COALESCE(NEW.pib_pph_amount, 0) > 0
         OR NEW.expense_category = 'pph_import' THEN
        PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(NEW.id));
      END IF;
      IF COALESCE(OLD.pph_amount, 0) > 0
         OR COALESCE(OLD.pib_pph_amount, 0) > 0
         OR OLD.expense_category = 'pph_import' THEN
        PERFORM public.recompute_pph_periods_for_date(COALESCE(OLD.due_date, OLD.expense_date));
        IF OLD.expense_date IS DISTINCT FROM NEW.expense_date THEN
          PERFORM public.recompute_pph_periods_for_date(OLD.expense_date);
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- 3. Guard trg_recompute_pph_from_bank_line: avoid recomputing if line owner/date didn't change
CREATE OR REPLACE FUNCTION public.trg_recompute_pph_from_bank_line()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_expense_id uuid;
  v_date date;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.matched_expense_id IS NOT DISTINCT FROM NEW.matched_expense_id
       AND OLD.transaction_date IS NOT DISTINCT FROM NEW.transaction_date
       AND OLD.payment_kind IS NOT DISTINCT FROM NEW.payment_kind THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.matched_expense_id IS NOT NULL THEN
    v_expense_id := OLD.matched_expense_id;
    PERFORM 1 FROM public.finance_expenses fe
    WHERE fe.id = v_expense_id
      AND (COALESCE(fe.pph_amount, 0) > 0 OR COALESCE(fe.pib_pph_amount, 0) > 0 OR fe.expense_category = 'pph_import');
    IF NOT FOUND THEN
      v_expense_id := NULL;
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND v_expense_id IS NOT NULL THEN
    PERFORM public.recompute_pph_periods_for_date(OLD.transaction_date);
    PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_expense_id));
    SELECT COALESCE(due_date, expense_date) INTO v_date FROM public.finance_expenses WHERE id = v_expense_id;
    PERFORM public.recompute_pph_periods_for_date(v_date);
  END IF;

  v_expense_id := NULL;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.matched_expense_id IS NOT NULL THEN
    v_expense_id := NEW.matched_expense_id;
    PERFORM 1 FROM public.finance_expenses fe
    WHERE fe.id = v_expense_id
      AND (COALESCE(fe.pph_amount, 0) > 0 OR COALESCE(fe.pib_pph_amount, 0) > 0 OR fe.expense_category = 'pph_import');
    IF NOT FOUND THEN
      v_expense_id := NULL;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND v_expense_id IS NOT NULL THEN
    PERFORM public.recompute_pph_periods_for_date(NEW.transaction_date);
    PERFORM public.recompute_pph_periods_for_date(public.get_expense_pph_period_date(v_expense_id));
    SELECT COALESCE(due_date, expense_date) INTO v_date FROM public.finance_expenses WHERE id = v_expense_id;
    PERFORM public.recompute_pph_periods_for_date(v_date);
  END IF;
  RETURN NULL;
END;
$function$;

-- 4. Guard sync_bank_line_allocation_owner: avoid writing to bank_statement_lines when fields match
CREATE OR REPLACE FUNCTION public.sync_bank_line_allocation_owner(p_bank_line_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
  v_only public.bank_statement_allocations%ROWTYPE;
  v_target_expense_id uuid;
  v_target_receipt_id uuid;
  v_target_payment_id uuid;
  v_target_ft_id uuid;
  v_target_pc_id uuid;
  v_target_tax_id uuid;
  v_target_entry_id uuid;
  v_target_kind text;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_line_id;

  IF v_count = 1 THEN
    SELECT * INTO v_only
      FROM public.bank_statement_allocations
     WHERE bank_statement_line_id = p_bank_line_id;

    v_target_expense_id := CASE 
        WHEN v_only.document_type = 'expense' 
          AND NOT EXISTS (
            SELECT 1 FROM public.bank_statement_lines b 
            WHERE b.matched_expense_id = v_only.document_id 
              AND b.matching_status = 'confirmed' 
              AND b.id <> p_bank_line_id
          ) 
        THEN v_only.document_id 
      END;
    v_target_receipt_id := CASE WHEN v_only.document_type = 'receipt' THEN v_only.document_id END;
    v_target_payment_id := CASE WHEN v_only.document_type = 'payment' THEN v_only.document_id END;
    v_target_ft_id := CASE WHEN v_only.document_type = 'fund_transfer' THEN v_only.document_id END;
    v_target_pc_id := CASE WHEN v_only.document_type = 'petty_cash' THEN v_only.document_id END;
    v_target_tax_id := CASE WHEN v_only.document_type = 'tax_payment' THEN v_only.document_id END;
    v_target_entry_id := v_only.journal_entry_id;
    v_target_kind := COALESCE(v_only.payment_kind, 'supplier');

    UPDATE public.bank_statement_lines SET
      matched_expense_id = v_target_expense_id,
      matched_receipt_id = v_target_receipt_id,
      matched_payment_id = v_target_payment_id,
      matched_fund_transfer_id = v_target_ft_id,
      matched_petty_cash_id = v_target_pc_id,
      matched_tax_payment_id = v_target_tax_id,
      matched_entry_id = v_target_entry_id,
      payment_kind = v_target_kind
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS DISTINCT FROM v_target_expense_id OR
        matched_receipt_id IS DISTINCT FROM v_target_receipt_id OR
        matched_payment_id IS DISTINCT FROM v_target_payment_id OR
        matched_fund_transfer_id IS DISTINCT FROM v_target_ft_id OR
        matched_petty_cash_id IS DISTINCT FROM v_target_pc_id OR
        matched_tax_payment_id IS DISTINCT FROM v_target_tax_id OR
        matched_entry_id IS DISTINCT FROM v_target_entry_id OR
        payment_kind IS DISTINCT FROM v_target_kind
      );
  ELSE
    UPDATE public.bank_statement_lines SET
      matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL
    WHERE id = p_bank_line_id
      AND (
        matched_expense_id IS NOT NULL OR
        matched_receipt_id IS NOT NULL OR
        matched_payment_id IS NOT NULL OR
        matched_fund_transfer_id IS NOT NULL OR
        matched_petty_cash_id IS NOT NULL OR
        matched_tax_payment_id IS NOT NULL OR
        matched_entry_id IS NOT NULL
      );
  END IF;
END;
$function$;

-- 5. Optimize sync_bank_line_from_allocation: eliminate duplicate recalculate_expense_payment_state
CREATE OR REPLACE FUNCTION public.sync_bank_line_from_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_line uuid;
  v_new_line uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_line := OLD.bank_statement_line_id;
    PERFORM public.sync_bank_line_allocation_owner(v_old_line);
    PERFORM public.refresh_bank_statement_allocation_status(v_old_line);
    IF NOT public.historical_repair_context_active() THEN
      IF OLD.document_type = 'tax_payment' THEN
        UPDATE public.tax_payments SET status = 'posted' WHERE id = OLD.document_id
          AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations WHERE document_type = 'tax_payment' AND document_id = OLD.document_id);
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_line := NEW.bank_statement_line_id;
    IF v_new_line IS DISTINCT FROM v_old_line THEN
      PERFORM public.sync_bank_line_allocation_owner(v_new_line);
      PERFORM public.refresh_bank_statement_allocation_status(v_new_line);
    END IF;
    IF NOT public.historical_repair_context_active() THEN
      IF NEW.document_type = 'tax_payment' THEN
        UPDATE public.tax_payments SET status = 'reconciled' WHERE id = NEW.document_id;
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- 6. Optimize sync_expense_from_bank_allocation: avoid redundant recomputations of identical dates
CREATE OR REPLACE FUNCTION public.sync_expense_from_bank_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old_expense uuid;
  v_new_expense uuid;
  v_old_date date;
  v_new_date date;
  v_fallback date;
  v_exp_date date;
BEGIN
  IF public.historical_repair_context_active() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.document_type='expense' THEN
    v_old_expense:=OLD.document_id;
    SELECT transaction_date INTO v_old_date FROM public.bank_statement_lines WHERE id=OLD.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_old_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_old_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      IF v_old_date IS NOT NULL THEN
        PERFORM public.recompute_pph_periods_for_date(v_old_date);
      END IF;
      v_exp_date := public.get_expense_pph_period_date(v_old_expense);
      IF v_exp_date IS NOT NULL AND v_exp_date IS DISTINCT FROM v_old_date THEN
        PERFORM public.recompute_pph_periods_for_date(v_exp_date);
      END IF;
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_old_expense;
      IF v_fallback IS NOT NULL AND v_fallback IS DISTINCT FROM v_old_date AND v_fallback IS DISTINCT FROM v_exp_date THEN
        PERFORM public.recompute_pph_periods_for_date(v_fallback);
      END IF;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.document_type='expense' THEN
    v_new_expense:=NEW.document_id;
    SELECT transaction_date INTO v_new_date FROM public.bank_statement_lines WHERE id=NEW.bank_statement_line_id;
    PERFORM public.recalculate_expense_payment_state(v_new_expense);
    IF EXISTS(SELECT 1 FROM public.finance_expenses WHERE id=v_new_expense AND (COALESCE(pph_amount,0)>0 OR COALESCE(pib_pph_amount,0)>0 OR expense_category='pph_import')) THEN
      IF v_new_date IS NOT NULL THEN
        PERFORM public.recompute_pph_periods_for_date(v_new_date);
      END IF;
      v_exp_date := public.get_expense_pph_period_date(v_new_expense);
      IF v_exp_date IS NOT NULL AND v_exp_date IS DISTINCT FROM v_new_date THEN
        PERFORM public.recompute_pph_periods_for_date(v_exp_date);
      END IF;
      SELECT COALESCE(due_date,expense_date) INTO v_fallback FROM public.finance_expenses WHERE id=v_new_expense;
      IF v_fallback IS NOT NULL AND v_fallback IS DISTINCT FROM v_new_date AND v_fallback IS DISTINCT FROM v_exp_date THEN
        PERFORM public.recompute_pph_periods_for_date(v_fallback);
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$function$;

-- 7. Optimize edit_approved_finance_expense_atomic: remove no-op bank allocation touch
CREATE OR REPLACE FUNCTION public.edit_approved_finance_expense_atomic(
  p_expense_id uuid,
  p_payload jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL::uuid,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_exp public.finance_expenses%rowtype;
  v_journal_id uuid;
  v_journal_count integer;
  v_date date;
  v_bank_id uuid;
  v_bank_currency text;
  v_currency text;
  v_rate numeric;
  v_docs text[];
  v_same_selected_count integer;
  v_selected_amount numeric;
  v_period_status text;
BEGIN
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_exp FROM public.finance_expenses WHERE id=p_expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_exp.approval_status<>'approved' THEN RAISE EXCEPTION 'Approved expense edit requires an approved expense'; END IF;

  SELECT count(*),(array_agg(id ORDER BY created_at DESC,id DESC))[1]
    INTO v_journal_count,v_journal_id
    FROM public.journal_entries
   WHERE source_module IN('expense','expenses')
     AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
     AND is_posted=true AND NOT COALESCE(is_reversed,false);
  IF v_journal_count<>1 THEN RAISE EXCEPTION 'Approved expense must have exactly one active effective journal'; END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=v_journal_id FOR UPDATE;

  SELECT ap.status INTO v_period_status
    FROM public.journal_entries je
    LEFT JOIN public.accounting_periods ap
      ON ap.start_date<=je.entry_date AND ap.end_date>=je.entry_date
   WHERE je.id=v_journal_id
   ORDER BY ap.start_date DESC LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
    RAISE EXCEPTION 'Cannot edit approved expense in a closed accounting period';
  END IF;

  IF COALESCE((p_payload->>'amount')::numeric,0)<=0 THEN RAISE EXCEPTION 'Expense amount must be greater than zero'; END IF;
  IF NULLIF(p_payload->>'expense_category','') IS NULL THEN RAISE EXCEPTION 'Expense category is required'; END IF;
  v_date:=COALESCE((p_payload->>'expense_date')::date,current_date);
  v_bank_id:=NULLIF(p_payload->>'bank_account_id','')::uuid;
  SELECT upper(currency) INTO v_bank_currency FROM public.bank_accounts WHERE id=v_bank_id;
  v_currency:=upper(COALESCE(NULLIF(p_payload->>'transaction_currency',''),v_bank_currency,'IDR'));
  v_rate:=COALESCE(NULLIF((p_payload->>'exchange_rate')::numeric,0),CASE WHEN v_currency='IDR' THEN 1 END);
  IF v_currency NOT IN('IDR','USD') OR v_rate IS NULL OR v_rate<=0 THEN RAISE EXCEPTION 'Valid expense currency/rate is required'; END IF;
  IF v_bank_currency IS NOT NULL AND v_bank_currency<>v_currency THEN RAISE EXCEPTION 'Expense currency does not match selected bank currency'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IS NOT NULL
     AND NULLIF(p_payload->>'payment_method','') NOT IN('cash','petty_cash')
     AND v_bank_id IS NULL THEN RAISE EXCEPTION 'Bank-paid expense requires a bank account'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IN('cash','petty_cash')
     AND p_bank_statement_line_id IS NOT NULL THEN RAISE EXCEPTION 'Cash/petty-cash expense cannot create a bank allocation'; END IF;
  IF NULLIF(p_payload->>'payment_method','') IS NULL AND p_bank_statement_line_id IS NOT NULL THEN RAISE EXCEPTION 'Accrued expense cannot create a bank allocation'; END IF;
  SELECT ap.status INTO v_period_status
    FROM public.accounting_periods ap
   WHERE ap.start_date<=v_date AND ap.end_date>=v_date
   ORDER BY ap.start_date DESC LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status<>'open' THEN
    RAISE EXCEPTION 'Cannot move approved expense into a closed accounting period';
  END IF;
  SELECT COALESCE(array_agg(value),ARRAY[]::text[]) INTO v_docs
    FROM jsonb_array_elements_text(COALESCE(p_payload->'document_urls','[]'::jsonb));

  PERFORM set_config('app.expense_atomic_bank_link','on',true);

  UPDATE public.finance_expenses SET
    expense_category=p_payload->>'expense_category',expense_type=COALESCE(NULLIF(p_payload->>'expense_type',''),'admin'),
    amount=(p_payload->>'amount')::numeric,expense_date=v_date,description=NULLIF(p_payload->>'description',''),
    batch_id=NULLIF(p_payload->>'batch_id','')::uuid,import_container_id=NULLIF(p_payload->>'import_container_id','')::uuid,
    delivery_challan_id=NULLIF(p_payload->>'delivery_challan_id','')::uuid,
    payment_method=NULLIF(p_payload->>'payment_method',''),bank_account_id=v_bank_id,
    payment_reference=NULLIF(p_payload->>'payment_reference',''),paid_by=NULLIF(p_payload->>'paid_by',''),
    document_urls=NULLIF(v_docs,ARRAY[]::text[]),supplier_id=NULLIF(p_payload->>'supplier_id','')::uuid,
    staff_id=NULLIF(p_payload->>'staff_id','')::uuid,invoice_number=NULLIF(p_payload->>'invoice_number',''),
    due_date=NULLIF(p_payload->>'due_date','')::date,broker_items=NULLIF(p_payload->'broker_items','null'::jsonb),
    pib_bm_amount=NULLIF(p_payload->>'pib_bm_amount','')::numeric,pib_ppn_amount=NULLIF(p_payload->>'pib_ppn_amount','')::numeric,
    pib_pph_amount=NULLIF(p_payload->>'pib_pph_amount','')::numeric,ppn_amount=COALESCE(NULLIF(p_payload->>'ppn_amount','')::numeric,0),
    ppn_manual_override=COALESCE((p_payload->>'ppn_manual_override')::boolean,false),
    ppn_calc_mode=COALESCE(NULLIF(p_payload->>'ppn_calc_mode',''),'standard'),dpp_amount=NULLIF(p_payload->>'dpp_amount','')::numeric,
    ppn_rate=COALESCE(NULLIF(p_payload->>'ppn_rate','')::numeric,11),pph_amount=COALESCE(NULLIF(p_payload->>'pph_amount','')::numeric,0),
    pph_code_id=NULLIF(p_payload->>'pph_code_id','')::uuid,stamp_duty_amount=COALESCE(NULLIF(p_payload->>'stamp_duty_amount','')::numeric,0),
    fixed_asset_account_id=NULLIF(p_payload->>'fixed_asset_account_id','')::uuid,
    bank_charges_amount=COALESCE(NULLIF(p_payload->>'bank_charges_amount','')::numeric,0),
    currency_code=v_currency,transaction_currency=v_currency,functional_currency='IDR',exchange_rate=v_rate,
    bank_account_currency=COALESCE(v_bank_currency,v_currency),payment_currency=v_currency,
    payee_id=NULLIF(p_payload->>'payee_id','')::uuid,
    linked_sales_invoice_id=NULLIF(p_payload->>'linked_sales_invoice_id','')::uuid,
    pph_calculation_regime=NULLIF(p_payload->>'pph_calculation_regime',''),
    pph_dpp_ratio=NULLIF(p_payload->>'pph_dpp_ratio','')::numeric,
    pph_dpp_amount=NULLIF(p_payload->>'pph_dpp_amount','')::numeric,
    pph_rate=NULLIF(p_payload->>'pph_rate','')::numeric,
    is_tax_manual_override=COALESCE((p_payload->>'is_tax_manual_override')::boolean, false)
  WHERE id=p_expense_id;

  IF NOT EXISTS(
    SELECT 1 FROM public.journal_entries
     WHERE id=v_journal_id
       AND source_module IN('expense','expenses')
       AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
       AND is_posted AND NOT COALESCE(is_reversed,false)
  ) THEN RAISE EXCEPTION 'Expense journal identity changed during edit'; END IF;
  IF (SELECT count(*) FROM public.journal_entries
       WHERE source_module IN('expense','expenses')
         AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
         AND is_posted AND NOT COALESCE(is_reversed,false))<>1 THEN
    RAISE EXCEPTION 'Expense edit did not preserve exactly one active journal';
  END IF;

  SELECT count(*),max(allocation_amount)
    INTO v_same_selected_count,v_selected_amount
    FROM public.bank_statement_allocations
   WHERE document_type='expense' AND document_id=p_expense_id AND payment_kind='supplier'
     AND bank_statement_line_id=p_bank_statement_line_id;

  IF p_bank_statement_line_id IS NOT NULL
     AND v_same_selected_count=0 THEN
    PERFORM public.link_bank_statement_line(
      p_bank_statement_line_id,'expense',p_expense_id,'supplier',p_allocation_amount);
  ELSIF p_bank_statement_line_id IS NOT NULL
     AND p_allocation_amount IS NOT NULL
     AND abs(COALESCE(v_selected_amount,0)-p_allocation_amount)>0.01 THEN
    RAISE EXCEPTION 'Change an existing bank allocation through unlink/relink so other payments remain intact';
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  RETURN p_expense_id;
END;
$function$;

COMMIT;
