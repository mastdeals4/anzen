-- Migration: 20260923140000_fix_receipt_voucher_cancellation_and_repair_fk.sql
-- Description:
-- 1. Alter finance_historical_repair_commands.created_allocation_id FK to ON DELETE SET NULL
--    so historical audit/repair commands are preserved when created allocations are reversed/unlinked.
-- 2. Extend cancel_receipt_voucher_posting() to safely identify and unlink bank statement allocations
--    via existing canonical unmatch_bank_statement_allocation() before GL posting cancellation,
--    refresh bank statement line status and ownership, and return receipt to Draft state without FK violations.
-- 3. Fix post_receipt_voucher() to reference v_rv.settlement_amount rather than non-existent bank_amount column.

-- 1. Fix the FK constraint on finance_historical_repair_commands
ALTER TABLE public.finance_historical_repair_commands
  DROP CONSTRAINT IF EXISTS finance_historical_repair_commands_created_allocation_id_fkey;

ALTER TABLE public.finance_historical_repair_commands
  ADD CONSTRAINT finance_historical_repair_commands_created_allocation_id_fkey
  FOREIGN KEY (created_allocation_id)
  REFERENCES public.bank_statement_allocations(id)
  ON DELETE SET NULL;

-- 2. Harden cancel_receipt_voucher_posting
CREATE OR REPLACE FUNCTION public.cancel_receipt_voucher_posting(
  p_rv_id uuid,
  p_cancelled_by uuid DEFAULT NULL::uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

    -- Explicitly NULL created_allocation_id on historical repair records
    -- so historical audit/repair commands are completely preserved
    UPDATE public.finance_historical_repair_commands
    SET created_allocation_id = NULL
    WHERE created_allocation_id = v_alloc.id;

    -- Unlink/delete bank allocation row via canonical unmatch_bank_statement_allocation
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
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_receipt_voucher_posting(uuid, uuid, text) TO authenticated, service_role;

-- 3. Fix post_receipt_voucher column reference
CREATE OR REPLACE FUNCTION public.post_receipt_voucher(p_rv_id uuid, p_posted_by uuid DEFAULT NULL::uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rv                 RECORD;
  v_je_id              UUID;
  v_je_number          TEXT;
  v_debit_account_id   UUID;
  v_credit_account_id  UUID;
  v_fx_loss_id         UUID;
  v_fx_gain_id         UUID;
  v_actual_poster      UUID;
  v_rate               NUMERIC := 1;
  v_actual_received    NUMERIC;
  v_carrying_ar        NUMERIC;
  v_realized_fx        NUMERIC := 0;
  v_total_debit        NUMERIC;
  v_total_credit       NUMERIC;
  v_line               INTEGER := 1;
BEGIN
  PERFORM public._sec_check_finance_role();
  v_actual_poster := COALESCE(auth.uid(), p_posted_by);

  SELECT * INTO v_rv FROM receipt_vouchers WHERE id = p_rv_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt voucher % not found', p_rv_id; END IF;
  IF v_rv.is_posted THEN RAISE EXCEPTION 'Receipt voucher % is already posted', v_rv.voucher_number; END IF;

  IF v_rv.bank_account_id IS NOT NULL THEN
    SELECT coa_id INTO v_debit_account_id FROM bank_accounts WHERE id = v_rv.bank_account_id;
  ELSIF v_rv.payment_method = 'cash' THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1101' LIMIT 1;
  END IF;
  IF v_debit_account_id IS NULL THEN
    SELECT id INTO v_debit_account_id FROM chart_of_accounts WHERE code = '1111' LIMIT 1;
  END IF;

  IF v_rv.coa_account_id IS NOT NULL THEN
    v_credit_account_id := v_rv.coa_account_id;
  ELSE
    SELECT id INTO v_credit_account_id FROM chart_of_accounts WHERE code = '1120' LIMIT 1;
  END IF;

  SELECT id INTO v_fx_loss_id FROM chart_of_accounts WHERE code = '7300' LIMIT 1;
  SELECT id INTO v_fx_gain_id FROM chart_of_accounts WHERE code = '4930' LIMIT 1;

  IF v_debit_account_id IS NULL OR v_credit_account_id IS NULL THEN
    RAISE EXCEPTION 'Cannot post: required chart of accounts entries missing';
  END IF;

  v_rate := COALESCE(v_rv.exchange_rate, 1);
  IF v_rate <= 0 THEN v_rate := 1; END IF;

  -- If cross-currency receipt:
  -- v_rv.amount is in receipt currency, v_rv.settlement_amount is actual bank receipt in IDR
  v_actual_received := COALESCE(v_rv.settlement_amount, v_rv.amount * v_rate);
  v_carrying_ar := v_rv.amount * v_rate; -- Default carrying if standard IDR invoice

  -- If sales invoice has carrying rate:
  IF EXISTS (SELECT 1 FROM voucher_allocations va JOIN sales_invoices si ON si.id = va.sales_invoice_id WHERE va.receipt_voucher_id = p_rv_id) THEN
    SELECT 
      COALESCE(SUM(va.allocated_amount), v_carrying_ar)
    INTO v_carrying_ar
    FROM voucher_allocations va
    WHERE va.receipt_voucher_id = p_rv_id;
  END IF;

  -- Realized FX for Customer Receipt:
  v_realized_fx := v_actual_received - v_carrying_ar;

  v_total_debit := v_actual_received + CASE WHEN v_realized_fx < 0 THEN abs(v_realized_fx) ELSE 0 END;
  v_total_credit := v_carrying_ar + CASE WHEN v_realized_fx > 0 THEN v_realized_fx ELSE 0 END;

  v_je_number := next_journal_entry_number();

  INSERT INTO journal_entries (
    entry_number, entry_date, source_module, reference_id, reference_number,
    description, total_debit, total_credit, is_posted, posted_by,
    transaction_currency, functional_currency, exchange_rate
  ) VALUES (
    v_je_number, v_rv.voucher_date, 'receipt', v_rv.id, v_rv.voucher_number,
    'Receipt Voucher: ' || v_rv.voucher_number,
    v_total_debit, v_total_credit, TRUE, v_actual_poster,
    COALESCE(v_rv.payment_currency, 'IDR'), 'IDR', v_rate
  ) RETURNING id INTO v_je_id;

  -- Line 1: Debit Bank/Cash with Actual IDR received
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_debit_account_id, 'Cash Receipt - ' || v_rv.voucher_number, v_actual_received, 0, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 2: Debit FX Loss if Received Less than Carrying
  IF v_realized_fx < 0 AND v_fx_loss_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line, v_fx_loss_id, 'Realized FX loss - ' || v_rv.voucher_number, abs(v_realized_fx), 0, v_rv.customer_id);
    v_line := v_line + 1;
  END IF;

  -- Line 3: Credit AR with Carrying Value
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
  VALUES (v_je_id, v_line, v_credit_account_id, 'Receipt - ' || v_rv.voucher_number, 0, v_carrying_ar, v_rv.customer_id);
  v_line := v_line + 1;

  -- Line 4: Credit FX Gain if Received More than Carrying
  IF v_realized_fx > 0 AND v_fx_gain_id IS NOT NULL THEN
    INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, description, debit, credit, customer_id)
    VALUES (v_je_id, v_line, v_fx_gain_id, 'Realized FX gain - ' || v_rv.voucher_number, 0, v_realized_fx, v_rv.customer_id);
    v_line := v_line + 1;
  END IF;

  UPDATE receipt_vouchers
  SET is_posted = TRUE, journal_entry_id = v_je_id
  WHERE id = p_rv_id;

  INSERT INTO audit_logs (table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'receipt_vouchers', p_rv_id, 'update',
    jsonb_build_object('is_posted', FALSE),
    jsonb_build_object('is_posted', TRUE, 'journal_entry_id', v_je_id, 'journal_entry_number', v_je_number, 'posted_by', v_actual_poster),
    v_actual_poster
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_receipt_voucher(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_receipt_voucher(uuid, uuid) TO authenticated, service_role;
