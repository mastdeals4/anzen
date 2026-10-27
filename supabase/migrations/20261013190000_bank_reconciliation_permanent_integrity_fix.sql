-- Migration: 20261013190000_bank_reconciliation_permanent_integrity_fix.sql
-- Description: Permanent Bank Reconciliation Integrity Fix
--              1. refresh_bank_statement_allocation_status verifies that allocations
--                 link to active, posted, non-reversed journals affecting the bank COA
--                 on the correct debit/credit side.
--              2. bsl_sync_reconciliation_status verifies valid allocations.
--              3. link_bank_statement_line checks for existing valid bank payment journals
--                 to prevent duplicate expense_payment journals.

BEGIN;

-- ============================================================================
-- 1. HARDEN REFRESH_BANK_STATEMENT_ALLOCATION_STATUS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_bank_statement_allocation_status(p_bank_line_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_line RECORD;
  v_total numeric;
  v_allocated_valid numeric := 0;
  v_new_recon_status text;
  v_new_matching_status text;
BEGIN
  SELECT bsl.*, ba.coa_id AS bank_coa_id
    INTO v_line
    FROM public.bank_statement_lines bsl
    JOIN public.bank_accounts ba ON ba.id = bsl.bank_account_id
   WHERE bsl.id = p_bank_line_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_total := COALESCE(NULLIF(v_line.debit_amount, 0), v_line.credit_amount, 0);

  -- Sum ONLY allocations backed by active, posted journals affecting the bank COA on the correct side
  SELECT COALESCE(SUM(bsa.allocation_amount), 0)
    INTO v_allocated_valid
    FROM public.bank_statement_allocations bsa
    JOIN public.journal_entries je ON je.id = bsa.journal_entry_id
   WHERE bsa.bank_statement_line_id = p_bank_line_id
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
     AND EXISTS (
       SELECT 1 FROM public.journal_entry_lines jel
        WHERE jel.journal_entry_id = je.id
          AND jel.account_id = v_line.bank_coa_id
          AND (
            (COALESCE(v_line.debit_amount, 0) > 0 AND COALESCE(jel.credit, 0) > 0)
            OR
            (COALESCE(v_line.credit_amount, 0) > 0 AND COALESCE(jel.debit, 0) > 0)
          )
     );

  -- Also check direct matched_entry_id if no allocations exist
  IF v_allocated_valid <= 0.01 AND v_line.matched_entry_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.id = v_line.matched_entry_id
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND jel.account_id = v_line.bank_coa_id
        AND (
          (COALESCE(v_line.debit_amount, 0) > 0 AND COALESCE(jel.credit, 0) > 0)
          OR
          (COALESCE(v_line.credit_amount, 0) > 0 AND COALESCE(jel.debit, 0) > 0)
        )
    ) THEN
      v_allocated_valid := v_total;
    END IF;
  END IF;

  IF v_allocated_valid <= 0.01 THEN
    v_new_recon_status := 'unmatched';
    v_new_matching_status := 'none';
  ELSIF v_allocated_valid < v_total - 0.01 THEN
    v_new_recon_status := 'partially_reconciled';
    v_new_matching_status := CASE WHEN v_line.matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  ELSE
    v_new_recon_status := 'matched';
    v_new_matching_status := CASE WHEN v_line.matching_status = 'confirmed' THEN 'confirmed' ELSE 'suggested' END;
  END IF;

  UPDATE public.bank_statement_lines
     SET reconciliation_status = v_new_recon_status,
         matching_status = v_new_matching_status,
         matched_at = CASE WHEN v_allocated_valid <= 0.01 THEN NULL ELSE COALESCE(matched_at, now()) END,
         matched_by = CASE WHEN v_allocated_valid <= 0.01 THEN NULL ELSE COALESCE(matched_by, auth.uid()) END
   WHERE id = p_bank_line_id;
END;
$$;

-- ============================================================================
-- 2. HARDEN BSL_SYNC_RECONCILIATION_STATUS TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bsl_sync_reconciliation_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_bank_coa_id uuid;
  v_total numeric := 0;
  v_allocated_valid numeric := 0;
  v_alloc_count integer := 0;
BEGIN
  SELECT coa_id INTO v_bank_coa_id
    FROM public.bank_accounts
   WHERE id = NEW.bank_account_id;

  v_total := COALESCE(NULLIF(NEW.debit_amount, 0), NEW.credit_amount, 0);

  SELECT count(*),
         COALESCE(SUM(
           CASE
             WHEN je.id IS NOT NULL
              AND je.is_posted = true
              AND NOT COALESCE(je.is_reversed, false)
              AND EXISTS (
                SELECT 1 FROM public.journal_entry_lines jel
                 WHERE jel.journal_entry_id = je.id
                   AND jel.account_id = v_bank_coa_id
                   AND (
                     (COALESCE(NEW.debit_amount, 0) > 0 AND COALESCE(jel.credit, 0) > 0)
                     OR
                     (COALESCE(NEW.credit_amount, 0) > 0 AND COALESCE(jel.debit, 0) > 0)
                   )
              )
             THEN bsa.allocation_amount
             ELSE 0
           END
         ), 0)
    INTO v_alloc_count, v_allocated_valid
    FROM public.bank_statement_allocations bsa
    LEFT JOIN public.journal_entries je ON je.id = bsa.journal_entry_id
   WHERE bsa.bank_statement_line_id = NEW.id;

  -- 1. If line has no allocations and no valid matched journal entry:
  IF v_alloc_count = 0 AND NEW.matched_entry_id IS NULL THEN
    IF NEW.matching_status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.matching_status IS DISTINCT FROM 'confirmed') THEN
      RAISE EXCEPTION 'Bank statement line % cannot be marked confirmed without an allocation or posted journal', NEW.id;
    END IF;
    NEW.reconciliation_status := 'unmatched';
    NEW.matching_status := 'none';
    NEW.matched_at := NULL;
    NEW.matched_by := NULL;

  -- 2. Line has allocations: derive status from verified valid allocation amounts
  ELSIF v_alloc_count > 0 THEN
    IF v_allocated_valid <= 0.01 THEN
      NEW.reconciliation_status := 'unmatched';
      IF NEW.matching_status = 'confirmed' THEN
        NEW.matching_status := 'none';
      END IF;
    ELSIF v_allocated_valid < v_total - 0.01 THEN
      NEW.reconciliation_status := 'partially_reconciled';
    ELSE
      NEW.reconciliation_status := 'matched';
    END IF;

  -- 3. Line has direct matched_entry_id without allocations
  ELSIF NEW.matched_entry_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.id = NEW.matched_entry_id
        AND je.is_posted = true
        AND NOT COALESCE(je.is_reversed, false)
        AND jel.account_id = v_bank_coa_id
        AND (
          (COALESCE(NEW.debit_amount, 0) > 0 AND COALESCE(jel.credit, 0) > 0)
          OR
          (COALESCE(NEW.credit_amount, 0) > 0 AND COALESCE(jel.debit, 0) > 0)
        )
    ) THEN
      NEW.reconciliation_status := 'matched';
    ELSE
      NEW.reconciliation_status := 'unmatched';
      NEW.matching_status := 'none';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 3. PREVENT DUPLICATE PAYMENT JOURNALS IN LINK_BANK_STATEMENT_LINE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.link_bank_statement_line(
  p_bank_line_id uuid,
  p_document_type text,
  p_document_id uuid,
  p_payment_kind text DEFAULT 'supplier'::text,
  p_allocation_amount numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line public.bank_statement_lines%rowtype;
  v_expense public.finance_expenses%rowtype;
  v_je uuid;
  v_bank_coa uuid;
  v_bank_currency text;
  v_expense_currency text;
  v_bank_total numeric;
  v_bank_allocated numeric;
  v_bank_remaining numeric;
  v_doc_total numeric;
  v_doc_allocated numeric;
  v_doc_remaining numeric;
  v_allocate numeric;
  v_allocation_id uuid:=gen_random_uuid();
  v_settlement_coa uuid;
  v_rate numeric;
  v_functional_amount numeric;
  v_entry text;
  v_period_id uuid;
  v_existing_payment_je uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  PERFORM public._sec_check_finance_role();
  SELECT * INTO v_line FROM public.bank_statement_lines WHERE id=p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;
  IF p_document_type='expense' THEN
    SELECT * INTO v_expense FROM public.finance_expenses WHERE id=p_document_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    SELECT (array_agg(id ORDER BY created_at DESC,id DESC))[1] INTO v_je
      FROM public.journal_entries
     WHERE source_module IN('expense','expenses')
       AND (reference_id=p_document_id OR reference_number='EXP-'||p_document_id::text)
       AND is_posted=true AND NOT COALESCE(is_reversed,false);
  ELSIF p_document_type='receipt' THEN SELECT journal_entry_id INTO v_je FROM public.receipt_vouchers WHERE id=p_document_id;
  ELSIF p_document_type='payment' THEN SELECT journal_entry_id INTO v_je FROM public.payment_vouchers WHERE id=p_document_id;
  ELSIF p_document_type='fund_transfer' THEN SELECT journal_entry_id INTO v_je FROM public.fund_transfers WHERE id=p_document_id;
  ELSIF p_document_type='petty_cash' THEN SELECT journal_entry_id INTO v_je FROM public.petty_cash_transactions WHERE id=p_document_id;
  ELSIF p_document_type='tax_payment' THEN SELECT journal_entry_id INTO v_je FROM public.tax_payments WHERE id=p_document_id;
  ELSIF p_document_type='journal' THEN SELECT id INTO v_je FROM public.journal_entries WHERE id=p_document_id AND is_posted AND NOT COALESCE(is_reversed,false);
  ELSE RAISE EXCEPTION 'Unsupported reconciliation document type %',p_document_type; END IF;
  IF v_je IS NULL THEN RAISE EXCEPTION 'Document must have an active posted journal before reconciliation'; END IF;

  SELECT coa_id,upper(currency) INTO v_bank_coa,v_bank_currency
    FROM public.bank_accounts WHERE id=v_line.bank_account_id;
  IF v_bank_coa IS NULL THEN RAISE EXCEPTION 'Selected bank account has no General Ledger account'; END IF;

  IF p_document_type <> 'expense' THEN
    SELECT COALESCE(sum(CASE WHEN COALESCE(v_line.credit_amount,0)>0 THEN COALESCE(jel.transaction_debit,jel.debit)
                            ELSE COALESCE(jel.transaction_credit,jel.credit) END),0)
      INTO v_doc_total FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id=v_je AND jel.account_id=v_bank_coa;
    IF v_doc_total<=0.01 THEN RAISE EXCEPTION 'Document journal does not contain the selected bank account on the matching side'; END IF;
  END IF;

  v_bank_total:=COALESCE(NULLIF(v_line.debit_amount,0),v_line.credit_amount,0);
  SELECT COALESCE(sum(allocation_amount),0) INTO v_bank_allocated
    FROM public.bank_statement_allocations WHERE bank_statement_line_id=p_bank_line_id;

  IF p_document_type='expense' THEN
    IF COALESCE(v_line.debit_amount,0)<=0 THEN
      RAISE EXCEPTION 'Expense payment requires an outgoing bank transaction';
    END IF;
    v_expense_currency:=upper(COALESCE(v_expense.transaction_currency,v_expense.currency_code,'IDR'));
    IF COALESCE(v_bank_currency,'IDR')<>v_expense_currency THEN
      RAISE EXCEPTION 'Direct expense allocation requires matching expense and bank currencies; use Payment Voucher for cross-currency payment';
    END IF;
    IF COALESCE(p_payment_kind,'supplier')='supplier' THEN
      v_doc_total:=COALESCE(public.calculate_finance_expense_payable(p_document_id),0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code='2110' LIMIT 1;
    ELSIF p_payment_kind='pph23' THEN
      v_doc_total:=COALESCE(v_expense.pph_amount,0);
      SELECT id INTO v_settlement_coa FROM public.chart_of_accounts WHERE code='2132' LIMIT 1;
    ELSE
      RAISE EXCEPTION 'Unsupported expense payment kind %',p_payment_kind;
    END IF;
    IF v_settlement_coa IS NULL THEN RAISE EXCEPTION 'Expense settlement account is not configured'; END IF;
    SELECT
      COALESCE((SELECT sum(a.allocation_amount) FROM public.bank_statement_allocations a
                 WHERE a.document_type='expense' AND a.document_id=p_document_id
                   AND a.payment_kind=COALESCE(p_payment_kind,'supplier')),0)
      + COALESCE((SELECT sum(COALESCE(NULLIF(b.debit_amount,0),b.credit_amount,0))
                    FROM public.bank_statement_lines b
                   WHERE b.matched_expense_id=p_document_id AND b.matching_status='confirmed'
                     AND b.payment_kind=COALESCE(p_payment_kind,'supplier')
                     AND b.id <> p_bank_line_id
                     AND NOT EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=b.id)),0)
      + COALESCE((SELECT sum(va.allocated_amount) FROM public.voucher_allocations va
                    JOIN public.payment_vouchers pv ON pv.id=va.payment_voucher_id
                   WHERE va.finance_expense_id=p_document_id
                     AND COALESCE(va.payment_kind,'supplier')=COALESCE(p_payment_kind,'supplier')
                     AND pv.is_posted=true
                     AND COALESCE(pv.payment_purpose,'general') NOT IN ('salary_advance','salary_advance_settlement')),0)
      + COALESCE((SELECT sum(sa.applied_amount)
                    FROM public.salary_advance_applications sa
                    JOIN public.payment_vouchers settlement ON settlement.id = sa.settlement_payment_voucher_id
                   WHERE sa.salary_expense_id=p_document_id
                     AND COALESCE(p_payment_kind,'supplier')='supplier'
                     AND settlement.is_posted=true),0)
      INTO v_doc_allocated;
  ELSE
    SELECT COALESCE(sum(allocation_amount),0) INTO v_doc_allocated
      FROM public.bank_statement_allocations
     WHERE document_type=p_document_type AND document_id=p_document_id
       AND payment_kind=COALESCE(p_payment_kind,'supplier');
  END IF;

  v_bank_remaining:=v_bank_total-v_bank_allocated;
  v_doc_remaining:=v_doc_total-v_doc_allocated;
  v_allocate:=round(COALESCE(NULLIF(p_allocation_amount,0),LEAST(v_bank_remaining,v_doc_remaining)),2);
  IF v_allocate<=0.01 THEN RAISE EXCEPTION 'No remaining amount is available to allocate'; END IF;
  IF v_allocate>v_bank_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds remaining bank amount'; END IF;
  IF v_allocate>v_doc_remaining+0.01 THEN RAISE EXCEPTION 'Allocation exceeds document outstanding amount'; END IF;

  IF p_document_type='expense' THEN
    IF EXISTS (SELECT 1 FROM public.bank_statement_allocations a WHERE a.bank_statement_line_id=p_bank_line_id AND a.document_type='expense' AND a.document_id=p_document_id AND a.payment_kind=COALESCE(p_payment_kind,'supplier')) THEN
      RAISE EXCEPTION 'This expense allocation already exists';
    END IF;

    -- Look for an existing valid payment journal that already credited the bank account for this expense
    SELECT je.id INTO v_existing_payment_je
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
     WHERE (je.reference_id = p_document_id OR je.reference_number IN ('EXP-' || p_document_id::text, 'EXP-PAY-' || p_document_id::text, v_expense.voucher_number))
       AND je.is_posted = true
       AND NOT COALESCE(je.is_reversed, false)
       AND jel.account_id = v_bank_coa
       AND jel.credit >= v_allocate - 0.01
       AND NOT EXISTS (
         SELECT 1 FROM public.bank_statement_allocations other_a
          WHERE other_a.journal_entry_id = je.id
            AND other_a.bank_statement_line_id <> p_bank_line_id
       )
     ORDER BY je.created_at DESC
     LIMIT 1;

    IF v_existing_payment_je IS NOT NULL THEN
      v_je := v_existing_payment_je;
    ELSE
      v_rate:=CASE WHEN v_expense_currency='IDR' THEN 1 ELSE COALESCE(v_expense.exchange_rate,0) END;
      IF v_rate<=0 THEN RAISE EXCEPTION 'Expense exchange rate is required'; END IF;
      v_functional_amount:=round(v_allocate*v_rate,2);
      v_entry:=public.next_journal_entry_number();
      SELECT id INTO v_period_id FROM public.accounting_periods
       WHERE start_date<=v_line.transaction_date AND end_date>=v_line.transaction_date
       ORDER BY start_date DESC LIMIT 1;
      IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE id=v_period_id AND status<>'open') THEN
        RAISE EXCEPTION 'Cannot post expense payment in a closed accounting period';
      END IF;
      INSERT INTO public.journal_entries(entry_number,entry_date,period_id,source_module,reference_id,
        reference_number,description,total_debit,total_credit,is_posted,posted_by,posted_at,created_by,
        transaction_currency,functional_currency,exchange_rate,amounts_are_functional)
      VALUES(v_entry,v_line.transaction_date,v_period_id,'expense_payment',p_document_id,
        'EXP-PAY-'||v_allocation_id::text,'Expense bank payment: '||COALESCE(v_expense.voucher_number,p_document_id::text),
        v_functional_amount,v_functional_amount,true,auth.uid(),now(),auth.uid(),
        v_expense_currency,'IDR',v_rate,true)
      RETURNING id INTO v_je;
      INSERT INTO public.journal_entry_lines(journal_entry_id,line_number,account_id,description,debit,credit,
        transaction_currency,transaction_debit,transaction_credit,functional_currency,exchange_rate,supplier_id)
      VALUES
        (v_je,1,v_settlement_coa,'Expense settlement - '||COALESCE(v_expense.voucher_number,''),v_functional_amount,0,
         v_expense_currency,v_allocate,0,'IDR',v_rate,v_expense.supplier_id),
        (v_je,2,v_bank_coa,'Bank payment - '||COALESCE(v_expense.voucher_number,''),0,v_functional_amount,
         v_bank_currency,0,v_allocate,'IDR',v_rate,v_expense.supplier_id);
    END IF;
  END IF;

  INSERT INTO public.bank_statement_allocations(id,bank_statement_line_id,document_type,document_id,journal_entry_id,allocation_amount,payment_kind,created_by)
  VALUES(v_allocation_id,p_bank_line_id,p_document_type,p_document_id,v_je,v_allocate,COALESCE(p_payment_kind,'supplier'),auth.uid());

  PERFORM public.sync_bank_line_allocation_owner(p_bank_line_id);
  UPDATE public.bank_statement_lines SET matched_at=now(),matched_by=auth.uid(),manually_unlinked=true
   WHERE id=p_bank_line_id;
  PERFORM public.refresh_bank_statement_allocation_status(p_bank_line_id);
  IF p_document_type='expense' THEN PERFORM public.recalculate_expense_payment_state(p_document_id); END IF;
  RETURN jsonb_build_object('allocation_amount',v_allocate,'bank_total',v_bank_total,
    'bank_allocated',v_bank_allocated+v_allocate,'bank_remaining',v_bank_remaining-v_allocate,
    'document_total',v_doc_total,'document_allocated',v_doc_allocated+v_allocate,
    'document_remaining',v_doc_remaining-v_allocate,'journal_entry_id',v_je);
END;
$function$;

COMMIT;
