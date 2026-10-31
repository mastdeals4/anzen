-- ==============================================================================
-- Migration: 20261031140000_fix_receipt_voucher_posting_and_bank_account_gl_validation.sql
-- Description: Fix Receipt & Payment Voucher posting GL integration:
--   1. Authoritative bank account & COA validation (remove unsafe fallback to header GL 1110).
--   2. Validate mapped GL is active and leaf (is_header = false).
--   3. Validate bank account currency matches voucher currency.
--   4. For cash transactions, resolve active postable Petty Cash (GL 1102).
--   5. Validate settlement adjustment GL (6910 / 6900) is active leaf.
--   6. Create sync_bank_account_balance() to keep bank_accounts.current_balance
--      100% consistent with General Ledger without double-counting.
--   7. Update post/cancel receipt & payment voucher RPCs to maintain bank balance.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 0. Ensure Chart of Accounts column, header trigger, and rounding FK exist
-- ------------------------------------------------------------------------------
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS is_header BOOLEAN DEFAULT false;
ALTER TABLE public.chart_of_accounts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE public.invoice_rounding_adjustments ADD COLUMN IF NOT EXISTS receipt_voucher_id uuid;
ALTER TABLE public.invoice_rounding_adjustments ADD COLUMN IF NOT EXISTS payment_voucher_id uuid;
ALTER TABLE public.bank_statement_lines ADD COLUMN IF NOT EXISTS matched_entry_id uuid;
ALTER TABLE public.bank_statement_lines ADD COLUMN IF NOT EXISTS matched_receipt_id uuid;

CREATE OR REPLACE FUNCTION public.prevent_header_account_posting() RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_code TEXT;
  v_is_header BOOLEAN;
BEGIN
  SELECT code, is_header
    INTO v_code, v_is_header
    FROM public.chart_of_accounts
   WHERE id = NEW.account_id;

  IF COALESCE(v_is_header, false) THEN
    RAISE EXCEPTION 'Journal lines cannot be posted to header account % — use a leaf account instead', v_code USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_header_account_posting ON public.journal_entry_lines;
CREATE TRIGGER trg_prevent_header_account_posting
BEFORE INSERT OR UPDATE OF account_id ON public.journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.prevent_header_account_posting();

-- ------------------------------------------------------------------------------
-- 1. Create sync_bank_account_balance()
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_bank_account_balance(p_bank_account_id uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  UPDATE public.bank_accounts ba
  SET current_balance = COALESCE(ba.opening_balance, 0) + COALESCE((
    SELECT SUM(
      CASE 
        WHEN upper(ba.currency) = 'USD' THEN COALESCE(jel.transaction_debit, jel.debit) - COALESCE(jel.transaction_credit, jel.credit)
        ELSE jel.debit - jel.credit
      END
    )
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE jel.account_id = ba.coa_id
      AND je.is_posted = true
      AND NOT COALESCE(je.is_reversed, false)
  ), 0)
  WHERE (p_bank_account_id IS NULL OR ba.id = p_bank_account_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_bank_account_balance(uuid) TO authenticated, service_role;

-- ------------------------------------------------------------------------------
-- 2. Update post_receipt_voucher() with strict bank & GL leaf validation
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_bank_account_id    UUID;
  v_credit_account_id  UUID;
  v_diff_account_id    UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_settle_diff        NUMERIC := 0;
  v_carrying_amount    NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
  v_currency           TEXT;
  v_party_type         TEXT;
  v_avail_advances     NUMERIC := 0;
  v_bank_curr          TEXT;
  v_bank_active        BOOLEAN;
  v_bank_coa_id        UUID;
  v_coa_code           TEXT;
  v_coa_name           TEXT;
  v_coa_is_header      BOOLEAN;
  v_coa_is_active      BOOLEAN;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  -- Ensure no active journal entry already exists for this voucher
  IF v_rv.journal_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries 
    WHERE id = v_rv.journal_entry_id AND is_posted = true AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Receipt voucher % already has an active posted journal entry', v_rv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_rv.party_type, 'customer'));
  v_currency := UPPER(COALESCE(v_rv.transaction_currency, v_rv.payment_currency, 'IDR'));
  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_settle_diff := COALESCE(v_rv.settlement_discount, 0);

  -- Validate settlement adjustment
  IF v_settle_diff < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;
  IF v_settle_diff > 0 AND (v_rv.adjustment_reason IS NULL OR trim(v_rv.adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;

  -- ==============================================================================
  -- STRICT BANK ACCOUNT & CASH GL RESOLUTION (NO UNSAFE FALLBACK TO HEADER 1110)
  -- ==============================================================================
  IF v_rv.payment_method = 'bank_transfer' OR v_rv.payment_method IS NULL THEN
    IF v_rv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'A bank account must be selected for bank transfer voucher %', v_rv.voucher_number;
    END IF;

    SELECT ba.coa_id, upper(ba.currency), ba.is_active,
           coa.code, coa.name, coa.is_header, coa.is_active
    INTO v_bank_coa_id, v_bank_curr, v_bank_active,
         v_coa_code, v_coa_name, v_coa_is_header, v_coa_is_active
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_rv.bank_account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected bank account (%) does not exist', v_rv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Selected bank account (%) is inactive', v_rv.bank_account_id;
    END IF;

    IF v_bank_coa_id IS NULL THEN
      RAISE EXCEPTION 'Selected bank account (%) has no mapped Chart of Accounts (COA) ledger account', v_rv.bank_account_id;
    END IF;

    IF v_coa_code IS NULL THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account mapped to bank account (%) does not exist', v_rv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_coa_is_active, false) THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account (%) mapped to bank account is inactive', v_coa_code;
    END IF;

    IF COALESCE(v_coa_is_header, false) THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account (%) mapped to bank account is a header account and cannot receive journal lines', v_coa_code;
    END IF;

    IF v_bank_curr IS NOT NULL AND v_currency IS NOT NULL AND v_bank_curr <> v_currency THEN
      RAISE EXCEPTION 'Voucher currency (%) does not match bank account currency (%)', v_currency, v_bank_curr;
    END IF;

    v_bank_account_id := v_bank_coa_id;

  ELSIF v_rv.payment_method = 'cash' THEN
    -- Resolve active leaf Petty Cash / Cash on Hand account (GL 1102 preferred, 1101 fallback)
    SELECT id, code, is_header, is_active
    INTO v_bank_account_id, v_coa_code, v_coa_is_header, v_coa_is_active
    FROM public.chart_of_accounts
    WHERE code = '1102' AND is_active = true AND is_header = false
    LIMIT 1;

    IF v_bank_account_id IS NULL THEN
      SELECT id, code, is_header, is_active
      INTO v_bank_account_id, v_coa_code, v_coa_is_header, v_coa_is_active
      FROM public.chart_of_accounts
      WHERE code = '1101' AND is_active = true AND is_header = false
      LIMIT 1;
    END IF;

    IF v_bank_account_id IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1102)';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for receipt voucher %', v_rv.payment_method, v_rv.voucher_number;
  END IF;

  -- ==============================================================================
  -- AUTHORITATIVE CONCURRENCY & BALANCE VALIDATION FOR SUPPLIER REFUND
  -- ==============================================================================
  IF v_party_type = 'supplier' AND v_rv.supplier_id IS NOT NULL THEN
    -- Lock the supplier row FOR UPDATE to strictly serialize concurrent refund postings
    PERFORM id FROM public.suppliers WHERE id = v_rv.supplier_id FOR UPDATE;

    -- 1. Calculate available unallocated supplier advances from payment vouchers
    SELECT COALESCE(SUM((pv.amount * COALESCE(pv.exchange_rate, 1)) - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_advances
    FROM public.payment_vouchers pv
    LEFT JOIN (
      SELECT payment_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY payment_voucher_id
    ) va ON va.payment_voucher_id = pv.id
    WHERE pv.supplier_id = v_rv.supplier_id
      AND pv.is_posted = true;

    -- 2. Include unallocated outgoing bank statement lines for this supplier
    v_avail_advances := v_avail_advances + COALESCE((
      SELECT SUM(bsl.debit_amount - COALESCE(bsa.allocated, 0))
      FROM public.bank_statement_lines bsl
      JOIN public.suppliers s ON s.id = v_rv.supplier_id
      LEFT JOIN (
        SELECT bank_statement_line_id, SUM(allocation_amount) as allocated
        FROM public.bank_statement_allocations
        GROUP BY bank_statement_line_id
      ) bsa ON bsa.bank_statement_line_id = bsl.id
      WHERE bsl.debit_amount > 0
        AND (bsl.debit_amount - COALESCE(bsa.allocated, 0)) > 0.01
        AND (
          bsl.description ILIKE ('%' || s.company_name || '%')
          OR bsl.description ILIKE ('%' || trim(regexp_replace(s.company_name, '^(PT[.]?|CV[.]?)[[:space:]]*|[[:space:]]*(PT[.]?|CV[.]?)$', '', 'gi')) || '%')
        )
    ), 0);

    -- 3. Subtract previously posted supplier refund receipt vouchers
    v_avail_advances := v_avail_advances - COALESCE((
      SELECT SUM(
        (rv.amount * COALESCE(rv.exchange_rate, 1)) + COALESCE(rv.settlement_discount, 0)
      )
      FROM public.receipt_vouchers rv
      WHERE rv.supplier_id = v_rv.supplier_id
        AND rv.party_type = 'supplier'
        AND rv.is_posted = true
        AND rv.id <> p_rv_id
    ), 0);

    IF (v_actual_received + v_settle_diff) > (v_avail_advances + 0.01) THEN
      RAISE EXCEPTION 'Supplier refund total settlement (%) exceeds available refundable advance balance (%)',
        (v_actual_received + v_settle_diff), v_avail_advances;
    END IF;
  END IF;

  -- ==============================================================================
  -- RESOLVE CREDIT CONTROL ACCOUNT BASED ON PARTY TYPE AND PURPOSE
  -- ==============================================================================
  IF v_party_type = 'customer' THEN
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      IF v_rv.payment_purpose = 'customer_deposit' OR v_rv.settlement_against = 'unallocated_deposit' THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2101' AND is_active = true AND is_header = false LIMIT 1;
        IF v_credit_account_id IS NULL THEN
          SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
        END IF;
      ELSE
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
        IF v_credit_account_id IS NULL THEN
          SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1100' AND is_active = true AND is_header = false LIMIT 1;
        END IF;
      END IF;
    END IF;

    IF v_settle_diff > 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true AND is_header = false;
        IF v_diff_account_id IS NULL THEN
          RAISE EXCEPTION 'Adjustment account % does not exist, is inactive, or is a header account', v_rv.adjustment_account_id;
        END IF;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'supplier' THEN
    -- Supplier Refund:
    -- Line 1 (Dr): Bank account with actual refund received
    -- Line 2 (Dr, if any): Settlement discount / Rounding adjustment
    -- Line 3 (Cr): Supplier AP (clearing supplier advance/deposit)
    IF v_rv.coa_account_id IS NOT NULL THEN
      v_credit_account_id := v_rv.coa_account_id;
    ELSE
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      IF v_credit_account_id IS NULL THEN
        SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;

    IF v_settle_diff > 0 THEN
      IF v_rv.adjustment_account_id IS NOT NULL THEN
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE id = v_rv.adjustment_account_id AND is_active = true AND is_header = false;
        IF v_diff_account_id IS NULL THEN
          RAISE EXCEPTION 'Adjustment account % does not exist, is inactive, or is a header account', v_rv.adjustment_account_id;
        END IF;
      ELSE
        SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
        IF v_diff_account_id IS NULL THEN
          SELECT id INTO v_diff_account_id FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
        END IF;
      END IF;
    END IF;

    v_carrying_amount := v_actual_received + v_settle_diff;

  ELSIF v_party_type = 'employee' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSIF v_party_type = 'director' THEN
    SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2105' AND is_active = true AND is_header = false LIMIT 1;
    IF v_credit_account_id IS NULL THEN
      SELECT id INTO v_credit_account_id FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_carrying_amount := v_actual_received;

  ELSE
    RAISE EXCEPTION 'Unsupported party type: %', v_party_type;
  END IF;

  -- Verify credit account is valid leaf and active
  IF v_credit_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_credit_account_id AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Credit control account could not be resolved or is inactive/header for voucher %', v_rv.voucher_number;
  END IF;

  -- Verify adjustment account if non-zero
  IF v_settle_diff > 0 AND (v_diff_account_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_diff_account_id AND is_active = true AND is_header = false
  )) THEN
    RAISE EXCEPTION 'Settlement adjustment account could not be resolved or is inactive/header for voucher %', v_rv.voucher_number;
  END IF;

  v_total_debit := v_actual_received + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;
  v_total_credit := v_carrying_amount;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry debit total (%) does not balance with credit total (%)', v_total_debit, v_total_credit;
  END IF;

  v_je_number := public.next_journal_entry_number();

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    source_module,
    reference_id,
    reference_number,
    description,
    total_debit,
    total_credit,
    is_posted,
    posted_by,
    created_by,
    transaction_currency,
    functional_currency,
    exchange_rate
  ) VALUES (
    v_je_number,
    v_rv.voucher_date,
    'receipt',
    v_rv.id,
    v_rv.voucher_number,
    'Receipt Voucher (' || v_party_type || '): ' || v_rv.voucher_number,
    v_total_debit,
    v_total_credit,
    TRUE,
    v_actual_poster,
    v_actual_poster,
    v_currency,
    'IDR',
    v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank / Cash with actual cash received
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    payee_id,
    transaction_currency,
    transaction_debit,
    transaction_credit,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_bank_account_id,
    CASE WHEN v_rv.payment_method = 'cash' THEN 'Cash Receipt - ' ELSE 'Bank Receipt - ' END || v_rv.voucher_number,
    v_actual_received,
    0,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_rv.staff_id,
    v_currency,
    round(v_actual_received / v_rate, 2),
    0,
    v_rate
  );
  v_line := v_line + 1;

  -- Line 2: Debit Settlement Difference / Adjustment (if any)
  IF v_settle_diff > 0 AND v_diff_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      line_number,
      account_id,
      description,
      debit,
      credit,
      customer_id,
      supplier_id,
      payee_id,
      transaction_currency,
      transaction_debit,
      transaction_credit,
      exchange_rate
    ) VALUES (
      v_je_id,
      v_line,
      v_diff_account_id,
      COALESCE(v_rv.adjustment_reason, 'Settlement adjustment') || ' - ' || v_rv.voucher_number,
      v_settle_diff,
      0,
      v_rv.customer_id,
      v_rv.supplier_id,
      v_rv.staff_id,
      v_currency,
      round(v_settle_diff / v_rate, 2),
      0,
      v_rate
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit Party Control Account (clearing AR / AP / Staff Advance / Customer Deposit)
  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit,
    customer_id,
    supplier_id,
    payee_id,
    transaction_currency,
    transaction_debit,
    transaction_credit,
    exchange_rate
  ) VALUES (
    v_je_id,
    v_line,
    v_credit_account_id,
    CASE 
      WHEN v_party_type = 'supplier' THEN 'Supplier Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Advance Recovery - '
      WHEN v_party_type = 'director' THEN 'Director Funding - '
      ELSE 'Customer Receipt - '
    END || v_rv.voucher_number,
    0,
    v_carrying_amount,
    v_rv.customer_id,
    v_rv.supplier_id,
    v_rv.staff_id,
    v_currency,
    0,
    round(v_carrying_amount / v_rate, 2),
    v_rate
  );
  v_line := v_line + 1;

  -- Recalculate Sales Invoice states if allocations were linked
  IF v_party_type = 'customer' THEN
    PERFORM public.recalculate_sales_invoice_payment_state(va.sales_invoice_id)
    FROM public.voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id AND va.sales_invoice_id IS NOT NULL;
  END IF;

  UPDATE public.receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_rv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_rv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers',
    p_rv_id,
    'update',
    jsonb_build_object('is_posted', false),
    jsonb_build_object('is_posted', true, 'journal_entry_id', v_je_id),
    v_actual_poster
  );
END;
$function$;

-- ------------------------------------------------------------------------------
-- 3. Update cancel_receipt_voucher_posting() to sync bank balance
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(p_rv_id uuid, p_cancelled_by uuid DEFAULT NULL::uuid, p_reason text DEFAULT 'Posting cancelled by administrator'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rv RECORD;
  v_je RECORD;
  v_actor uuid;
  v_alloc RECORD;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_line_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actor := COALESCE(auth.uid(), p_cancelled_by);

  SELECT * INTO v_rv FROM public.receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id;
  END IF;

  IF NOT v_rv.is_posted THEN
    RAISE EXCEPTION 'Receipt voucher % is not posted', COALESCE(v_rv.voucher_number, p_rv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = v_rv.journal_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for receipt voucher %', v_rv.voucher_number;
  END IF;

  -- Clean up any associated rounding adjustments
  DELETE FROM public.invoice_rounding_adjustments WHERE receipt_voucher_id = p_rv_id;

  -- Step 1: Identify all bank allocations associated with this receipt voucher or its journal entry
  FOR v_alloc IN
    SELECT bsa.id, bsa.bank_statement_line_id
    FROM public.bank_statement_allocations bsa
    WHERE (bsa.document_type = 'receipt' AND bsa.document_id = p_rv_id)
       OR (v_rv.journal_entry_id IS NOT NULL AND bsa.journal_entry_id = v_rv.journal_entry_id)
    FOR UPDATE
  LOOP
    IF NOT (v_alloc.bank_statement_line_id = ANY(v_line_ids)) THEN
      v_line_ids := array_append(v_line_ids, v_alloc.bank_statement_line_id);
    END IF;

    IF to_regclass('public.finance_historical_repair_commands') IS NOT NULL THEN
      EXECUTE 'UPDATE public.finance_historical_repair_commands SET created_allocation_id = NULL WHERE created_allocation_id = $1' USING v_alloc.id;
    END IF;

    PERFORM public.unmatch_bank_statement_allocation(v_alloc.id);
  END LOOP;

  -- Step 2: Identify any bank lines directly referencing this receipt or journal entry
  FOR v_line_id IN
    SELECT id FROM public.bank_statement_lines
    WHERE matched_receipt_id = p_rv_id
       OR (v_rv.journal_entry_id IS NOT NULL AND matched_entry_id = v_rv.journal_entry_id)
  LOOP
    IF NOT (v_line_id = ANY(v_line_ids)) THEN
      v_line_ids := array_append(v_line_ids, v_line_id);
    END IF;
  END LOOP;

  -- Step 3: Clear direct bank line references and refresh ownership and reconciliation status
  IF array_length(v_line_ids, 1) > 0 THEN
    UPDATE public.bank_statement_lines
    SET matched_receipt_id = NULL
    WHERE matched_receipt_id = p_rv_id;

    IF v_rv.journal_entry_id IS NOT NULL THEN
      UPDATE public.bank_statement_lines
      SET matched_entry_id = NULL
      WHERE matched_entry_id = v_rv.journal_entry_id;
    END IF;

    FOREACH v_line_id IN ARRAY v_line_ids LOOP
      PERFORM public.sync_bank_line_allocation_owner(v_line_id);
      PERFORM public.refresh_bank_statement_allocation_status(v_line_id);
    END LOOP;
  END IF;

  -- Step 4: Clear the FK reference FIRST so cancel_gl_posting can delete the JE row.
  UPDATE public.receipt_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_rv_id;

  -- Step 5: Delete original receipt journal entry and record audit log via cancel_gl_posting
  PERFORM public.cancel_gl_posting(
    v_je.id,
    p_rv_id,
    'receipt_vouchers',
    v_actor,
    p_reason,
    jsonb_build_object(
      'voucher_number', v_rv.voucher_number,
      'amount',         v_rv.amount,
      'is_posted',      TRUE
    )
  );

  -- Step 6: Synchronize bank account current_balance with authoritative GL
  IF v_rv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_rv.bank_account_id);
  END IF;
END;
$function$;

-- ------------------------------------------------------------------------------
-- 4. Update post_payment_voucher() with strict bank & GL leaf validation
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_payment_voucher(p_pv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_entry text;
  v_je uuid;
  v_bank_coa uuid;
  v_debit_coa uuid;
  v_charge_coa uuid;
  v_diff_coa uuid;
  v_pph_coa uuid;
  v_total_debit numeric;
  v_total_credit numeric;
  v_line int := 1;
  v_actual_poster uuid;
  v_party_type text;
  v_gross numeric;
  v_actual numeric;
  v_settle_diff numeric;
  v_debit_amount numeric;
  v_rate numeric := 1;
  v_charge_amt numeric := 0;
  v_pph_bank numeric := 0;
  v_bank_currency text;
  v_invoice_currency text;
  v_avail_deposits numeric;
  v_bank_active boolean;
  v_coa_code text;
  v_coa_name text;
  v_coa_is_header boolean;
  v_coa_is_active boolean;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := auth.uid();
  IF v_actual_poster IS NULL THEN
    v_actual_poster := COALESCE(p_posted_by, 'a0000000-0000-0000-0000-000000000001'::uuid);
  END IF;

  SELECT * INTO v_pv FROM public.payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF v_pv.is_posted THEN RAISE EXCEPTION 'Payment voucher % is already posted', v_pv.voucher_number; END IF;

  -- Ensure no active journal entry already exists for this voucher
  IF v_pv.journal_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries 
    WHERE id = v_pv.journal_entry_id AND is_posted = true AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Payment voucher % already has an active posted journal entry', v_pv.voucher_number;
  END IF;

  v_party_type := lower(COALESCE(v_pv.party_type, 'supplier'));
  v_rate := COALESCE(v_pv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  v_bank_currency := UPPER(COALESCE(v_pv.bank_currency, v_pv.payment_currency, 'IDR'));
  v_invoice_currency := UPPER(COALESCE(v_pv.invoice_currency, v_pv.transaction_currency, 'IDR'));

  v_gross := COALESCE(v_pv.invoice_amount, v_pv.amount, 0);
  v_settle_diff := COALESCE(v_pv.settlement_discount, 0);
  v_charge_amt := COALESCE(v_pv.bank_charge, 0);
  v_pph_bank := COALESCE(v_pv.pph_amount, 0) * v_rate;
  v_actual := COALESCE(v_pv.bank_amount, v_pv.actual_bank_debit, v_gross * v_rate);

  -- Validate settlement adjustment
  IF v_settle_diff < 0 THEN
    RAISE EXCEPTION 'Settlement discount cannot be negative';
  END IF;
  IF v_settle_diff > 0 AND (v_pv.adjustment_reason IS NULL OR trim(v_pv.adjustment_reason) = '') THEN
    RAISE EXCEPTION 'Adjustment reason is mandatory when settlement discount/difference is non-zero';
  END IF;
  IF v_pv.adjustment_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_pv.adjustment_account_id AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Adjustment account % does not exist, is inactive, or is a header account', v_pv.adjustment_account_id;
  END IF;

  -- Concurrency & Balance Validation for Customer Refund
  IF v_party_type = 'customer' AND v_pv.customer_id IS NOT NULL THEN
    PERFORM id FROM public.customers WHERE id = v_pv.customer_id FOR UPDATE;

    SELECT COALESCE(SUM(rv.amount - COALESCE(va.allocated, 0)), 0)
    INTO v_avail_deposits
    FROM public.receipt_vouchers rv
    LEFT JOIN (
      SELECT receipt_voucher_id, SUM(allocated_amount) as allocated
      FROM public.voucher_allocations
      GROUP BY receipt_voucher_id
    ) va ON va.receipt_voucher_id = rv.id
    WHERE rv.customer_id = v_pv.customer_id
      AND rv.is_posted = true;

    v_avail_deposits := v_avail_deposits - COALESCE((
      SELECT SUM((pv2.amount * COALESCE(pv2.exchange_rate, 1)) + COALESCE(pv2.settlement_discount, 0))
      FROM public.payment_vouchers pv2
      WHERE pv2.customer_id = v_pv.customer_id
        AND pv2.party_type = 'customer'
        AND pv2.is_posted = true
        AND pv2.id <> v_pv.id
    ), 0);

    IF (v_gross + v_settle_diff) > (v_avail_deposits + 0.01) AND v_avail_deposits >= 0 THEN
      RAISE EXCEPTION 'Customer refund amount (%) exceeds available customer deposit/credit balance (%)',
        (v_gross + v_settle_diff), v_avail_deposits;
    END IF;
  END IF;

  -- ==============================================================================
  -- STRICT BANK ACCOUNT & CASH GL RESOLUTION (NO UNSAFE FALLBACK TO HEADER 1110)
  -- ==============================================================================
  IF v_pv.payment_method = 'bank_transfer' OR v_pv.payment_method IS NULL THEN
    IF v_pv.bank_account_id IS NULL THEN
      RAISE EXCEPTION 'A bank account must be selected for bank transfer voucher %', v_pv.voucher_number;
    END IF;

    SELECT ba.coa_id, upper(ba.currency), ba.is_active,
           coa.code, coa.name, coa.is_header, coa.is_active
    INTO v_bank_coa, v_bank_currency, v_bank_active,
         v_coa_code, v_coa_name, v_coa_is_header, v_coa_is_active
    FROM public.bank_accounts ba
    LEFT JOIN public.chart_of_accounts coa ON coa.id = ba.coa_id
    WHERE ba.id = v_pv.bank_account_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Selected bank account (%) does not exist', v_pv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_bank_active, false) THEN
      RAISE EXCEPTION 'Selected bank account (%) is inactive', v_pv.bank_account_id;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'Selected bank account (%) has no mapped Chart of Accounts (COA) ledger account', v_pv.bank_account_id;
    END IF;

    IF v_coa_code IS NULL THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account mapped to bank account (%) does not exist', v_pv.bank_account_id;
    END IF;

    IF NOT COALESCE(v_coa_is_active, false) THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account (%) mapped to bank account is inactive', v_coa_code;
    END IF;

    IF COALESCE(v_coa_is_header, false) THEN
      RAISE EXCEPTION 'The Chart of Accounts ledger account (%) mapped to bank account is a header account and cannot receive journal lines', v_coa_code;
    END IF;

  ELSIF v_pv.payment_method = 'cash' THEN
    SELECT id, code, is_header, is_active
    INTO v_bank_coa, v_coa_code, v_coa_is_header, v_coa_is_active
    FROM public.chart_of_accounts
    WHERE code = '1102' AND is_active = true AND is_header = false
    LIMIT 1;

    IF v_bank_coa IS NULL THEN
      SELECT id, code, is_header, is_active
      INTO v_bank_coa, v_coa_code, v_coa_is_header, v_coa_is_active
      FROM public.chart_of_accounts
      WHERE code = '1101' AND is_active = true AND is_header = false
      LIMIT 1;
    END IF;

    IF v_bank_coa IS NULL THEN
      RAISE EXCEPTION 'No active postable Cash/Petty Cash GL account found (GL 1102)';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported payment method: % for payment voucher %', v_pv.payment_method, v_pv.voucher_number;
  END IF;

  -- Resolve Debit Control Account
  IF v_party_type = 'supplier' THEN
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2110' AND is_active = true AND is_header = false LIMIT 1;
      IF v_debit_coa IS NULL THEN
        SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'customer' THEN
    SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2101' AND is_active = true AND is_header = false LIMIT 1;
    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '2100' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    IF v_debit_coa IS NULL THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1120' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

  ELSIF v_party_type = 'employee' THEN
    IF v_pv.payment_purpose = 'salary_advance' THEN
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '1160' AND is_active = true AND is_header = false LIMIT 1;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '5101' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := (v_gross + v_settle_diff) * v_rate;

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
    v_debit_amount := v_gross * v_rate;

  ELSE
    IF v_pv.coa_account_id IS NOT NULL THEN
      v_debit_coa := v_pv.coa_account_id;
    ELSE
      SELECT id INTO v_debit_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
    END IF;
    v_debit_amount := v_gross * v_rate;
  END IF;

  IF v_debit_coa IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts WHERE id = v_debit_coa AND is_active = true AND is_header = false
  ) THEN
    RAISE EXCEPTION 'Debit control account could not be resolved or is inactive/header for payment voucher %', v_pv.voucher_number;
  END IF;

  SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6901' AND is_active = true AND is_header = false LIMIT 1;
  IF v_charge_coa IS NULL THEN 
    SELECT id INTO v_charge_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1; 
  END IF;

  SELECT id INTO v_pph_coa FROM public.chart_of_accounts WHERE code = '2132' AND is_active = true AND is_header = false LIMIT 1;

  IF v_settle_diff > 0 THEN
    IF v_pv.adjustment_account_id IS NOT NULL THEN
      v_diff_coa := v_pv.adjustment_account_id;
    ELSE
      SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6910' AND is_active = true AND is_header = false LIMIT 1;
      IF v_diff_coa IS NULL THEN
        SELECT id INTO v_diff_coa FROM public.chart_of_accounts WHERE code = '6900' AND is_active = true AND is_header = false LIMIT 1;
      END IF;
    END IF;
  END IF;

  v_total_debit := v_debit_amount + v_charge_amt;
  v_total_credit := v_actual + v_pph_bank + CASE WHEN v_settle_diff > 0 THEN v_settle_diff ELSE 0 END;

  IF abs(v_total_debit - v_total_credit) > 0.01 THEN
    RAISE EXCEPTION 'Journal entry debit total (%) does not balance with credit total (%)', v_total_debit, v_total_credit;
  END IF;

  v_entry := public.next_journal_entry_number();

  INSERT INTO public.journal_entries(
    entry_number, entry_date, source_module, reference_id, reference_number, description,
    total_debit, total_credit, is_posted, posted_by, transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_entry, v_pv.voucher_date, 'payment', v_pv.id, v_pv.voucher_number,
    'Payment Voucher (' || v_party_type || '): ' || v_pv.voucher_number,
    v_total_debit, v_total_credit, true, v_actual_poster, v_invoice_currency, 'IDR', v_rate
  ) RETURNING id INTO v_je;

  -- Line 1: Debit Party Control Account (clearing AP / Customer Deposit / Staff Advance)
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_debit_coa,
    CASE 
      WHEN v_party_type = 'customer' THEN 'Customer Refund - '
      WHEN v_party_type = 'employee' THEN 'Staff Payment - '
      WHEN v_party_type = 'director' THEN 'Director Loan Repayment - '
      ELSE 'Supplier Payment - '
    END || v_pv.voucher_number,
    v_debit_amount, 0,
    v_invoice_currency, (v_gross + v_settle_diff), 0, v_rate,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );
  v_line := v_line + 1;

  -- Line 2: Bank Charge
  IF v_charge_amt > 0 AND v_charge_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_charge_coa, 'Bank Charge - ' || v_pv.voucher_number, v_charge_amt, 0,
      v_bank_currency, v_charge_amt, 0, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 3: PPh Withholding
  IF v_pph_bank > 0 AND v_pph_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_pph_coa, 'PPh Withholding - ' || v_pv.voucher_number, 0, v_pph_bank,
      v_bank_currency, 0, v_pv.pph_amount, v_rate,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 4: Settlement Discount / Difference Credit
  IF v_settle_diff > 0 AND v_diff_coa IS NOT NULL THEN
    INSERT INTO public.journal_entry_lines(
      journal_entry_id, line_number, account_id, description, debit, credit,
      transaction_currency, transaction_debit, transaction_credit, exchange_rate,
      supplier_id, customer_id, payee_id
    ) VALUES (
      v_je, v_line, v_diff_coa,
      COALESCE(v_pv.adjustment_reason, 'Settlement discount') || ' - ' || v_pv.voucher_number,
      0, v_settle_diff,
      v_bank_currency, 0, v_settle_diff, 1,
      v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
    );
    v_line := v_line + 1;
  END IF;

  -- Line 5: Credit Bank / Cash with actual cash paid
  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description, debit, credit,
    transaction_currency, transaction_debit, transaction_credit, exchange_rate,
    supplier_id, customer_id, payee_id
  ) VALUES (
    v_je, v_line, v_bank_coa, 'Bank Payment - ' || v_pv.voucher_number, 0, v_actual,
    v_bank_currency, 0, v_actual, 1,
    v_pv.supplier_id, v_pv.customer_id, v_pv.staff_id
  );

  UPDATE public.payment_vouchers SET is_posted = true, journal_entry_id = v_je WHERE id = p_pv_id;

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES('payment_vouchers', p_pv_id, 'update', jsonb_build_object('is_posted', false), jsonb_build_object('is_posted', true, 'journal_entry_id', v_je), v_actual_poster);
END;
$function$;

-- ------------------------------------------------------------------------------
-- 5. Update cancel_payment_voucher_posting() to sync bank balance
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_payment_voucher_posting(p_pv_id uuid, p_cancelled_by uuid, p_reason text DEFAULT 'Posting cancelled by administrator'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_pv RECORD;
  v_je RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  PERFORM public._sec_check_finance_role();
  IF p_cancelled_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Cancelled-by identity must match the authenticated user';
  END IF;

  SELECT * INTO v_pv FROM payment_vouchers WHERE id = p_pv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment voucher % not found', p_pv_id; END IF;
  IF NOT v_pv.is_posted THEN
    RAISE EXCEPTION 'Payment voucher % is not posted', COALESCE(v_pv.voucher_number, p_pv_id::TEXT);
  END IF;

  SELECT * INTO v_je FROM journal_entries WHERE id = v_pv.journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No journal entry found for payment voucher %', v_pv.voucher_number;
  END IF;

  -- Clear any settlement adjustments linked to this payment voucher
  PERFORM public.clear_payment_allocation_rounding_adjustment(NULL, p_pv_id);

  -- Clear the FK reference FIRST so cancel_gl_posting can delete the JE row
  UPDATE payment_vouchers
  SET is_posted = FALSE, journal_entry_id = NULL
  WHERE id = p_pv_id;

  PERFORM cancel_gl_posting(
    v_je.id, p_pv_id, 'payment_vouchers', p_cancelled_by, p_reason,
    jsonb_build_object(
      'voucher_number', v_pv.voucher_number,
      'amount',         v_pv.amount,
      'is_posted',      TRUE
    )
  );

  -- Synchronize bank account current_balance with authoritative GL
  IF v_pv.bank_account_id IS NOT NULL THEN
    PERFORM public.sync_bank_account_balance(v_pv.bank_account_id);
  END IF;
END;
$function$;

-- ------------------------------------------------------------------------------
-- 6. Initial synchronisation of all bank account balances
-- ------------------------------------------------------------------------------
SELECT public.sync_bank_account_balance(NULL);
