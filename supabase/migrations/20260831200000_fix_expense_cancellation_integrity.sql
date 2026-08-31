BEGIN;

-- A cancelled posting is retained for audit/referential integrity, but it is
-- not a pending document and must never be approved again in place.
ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_approval_status_check;
ALTER TABLE public.finance_expenses
  ADD CONSTRAINT finance_expenses_approval_status_check
  CHECK (approval_status IN ('pending_approval', 'approved', 'rejected', 'cancelled'));

-- Historical repair commands deliberately retain their immutable before/after
-- evidence. When their canonical bank allocation is later unlinked, snapshot
-- that allocation and detach only the nullable live FK before deleting it.
CREATE OR REPLACE FUNCTION public.unmatch_bank_statement_allocation(p_allocation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_a public.bank_statement_allocations%ROWTYPE;
  v_count integer;
  v_only public.bank_statement_allocations%ROWTYPE;
BEGIN
  PERFORM public._sec_check_finance_role();

  SELECT * INTO v_a
  FROM public.bank_statement_allocations
  WHERE id = p_allocation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank allocation not found';
  END IF;

  UPDATE public.finance_historical_repair_commands
  SET after_state = after_state || jsonb_build_object(
        'released_allocation_id', v_a.id,
        'released_allocation_snapshot', to_jsonb(v_a),
        'allocation_released_at', clock_timestamp(),
        'allocation_released_by', auth.uid(),
        'allocation_release_operation', 'bank_allocation_unlink'
      ),
      created_allocation_id = NULL
  WHERE created_allocation_id = v_a.id;

  DELETE FROM public.bank_statement_allocations WHERE id = p_allocation_id;

  SELECT count(*) INTO v_count
  FROM public.bank_statement_allocations
  WHERE bank_statement_line_id = v_a.bank_statement_line_id;

  IF v_count = 1 THEN
    SELECT * INTO v_only
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = v_a.bank_statement_line_id;

    UPDATE public.bank_statement_lines
    SET matched_expense_id = CASE WHEN v_only.document_type = 'expense' THEN v_only.document_id END,
        matched_receipt_id = CASE WHEN v_only.document_type = 'receipt' THEN v_only.document_id END,
        matched_payment_id = CASE WHEN v_only.document_type = 'payment' THEN v_only.document_id END,
        matched_fund_transfer_id = CASE WHEN v_only.document_type = 'fund_transfer' THEN v_only.document_id END,
        matched_petty_cash_id = CASE WHEN v_only.document_type = 'petty_cash' THEN v_only.document_id END,
        matched_tax_payment_id = CASE WHEN v_only.document_type = 'tax_payment' THEN v_only.document_id END,
        matched_entry_id = v_only.journal_entry_id,
        payment_kind = v_only.payment_kind
    WHERE id = v_a.bank_statement_line_id;
  ELSIF v_count = 0 THEN
    UPDATE public.bank_statement_lines
    SET matched_expense_id = NULL,
        matched_receipt_id = NULL,
        matched_payment_id = NULL,
        matched_fund_transfer_id = NULL,
        matched_petty_cash_id = NULL,
        matched_tax_payment_id = NULL,
        matched_entry_id = NULL
    WHERE id = v_a.bank_statement_line_id;
  END IF;

  PERFORM public.refresh_bank_statement_allocation_status(v_a.bank_statement_line_id);
  IF v_a.document_type = 'expense' THEN
    PERFORM public.recalculate_expense_payment_state(v_a.document_id);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'bank_line_id', v_a.bank_statement_line_id,
    'allocation_id', p_allocation_id
  );
END;
$$;

-- Route every line-level unlink through the allocation command above so no
-- caller can bypass the historical-repair dependency handling.
CREATE OR REPLACE FUNCTION public.unmatch_bank_line(p_bank_line_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_allocation_id uuid;
BEGIN
  PERFORM public._sec_check_finance_role();
  PERFORM 1 FROM public.bank_statement_lines WHERE id = p_bank_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line not found';
  END IF;

  FOR v_allocation_id IN
    SELECT id
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = p_bank_line_id
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM public.unmatch_bank_statement_allocation(v_allocation_id);
  END LOOP;

  UPDATE public.bank_statement_lines
  SET matched_expense_id = NULL,
      matched_receipt_id = NULL,
      matched_payment_id = NULL,
      matched_fund_transfer_id = NULL,
      matched_petty_cash_id = NULL,
      matched_tax_payment_id = NULL,
      matched_entry_id = NULL,
      matching_status = 'none',
      reconciliation_status = 'unmatched',
      matched_at = NULL,
      matched_by = NULL,
      notes = NULL,
      manually_unlinked = true,
      payment_kind = 'supplier'
  WHERE id = p_bank_line_id;

  RETURN jsonb_build_object('success', true, 'bank_line_id', p_bank_line_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_expense_posting(
  p_exp_id uuid,
  p_cancelled_by uuid,
  p_reason text DEFAULT 'Posting cancelled by administrator'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_exp public.finance_expenses%ROWTYPE;
  v_je public.journal_entries%ROWTYPE;
  v_reversal_id uuid;
  v_period_status text;
  v_reversal_number text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_cancelled_by IS NULL OR p_cancelled_by <> auth.uid() THEN
    RAISE EXCEPTION 'Cancelled-by identity must match the authenticated user';
  END IF;
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'Cancellation reason is required';
  END IF;

  SELECT * INTO v_exp
  FROM public.finance_expenses
  WHERE id = p_exp_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense % not found', p_exp_id;
  END IF;
  IF v_exp.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Cannot cancel posting: expense % is not approved (current: %)',
      p_exp_id, v_exp.approval_status;
  END IF;

  SELECT * INTO v_je
  FROM public.journal_entries
  WHERE source_module IN ('expense', 'expenses')
    AND (reference_id = p_exp_id OR reference_number = 'EXP-' || p_exp_id::text)
    AND is_posted = true
    AND NOT COALESCE(is_reversed, false)
  ORDER BY created_at DESC, id DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active journal entry found for expense %', p_exp_id;
  END IF;

  SELECT ap.status INTO v_period_status
  FROM public.accounting_periods ap
  WHERE ap.start_date <= v_je.entry_date AND ap.end_date >= v_je.entry_date
  ORDER BY ap.start_date DESC
  LIMIT 1;
  IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot cancel posting: the accounting period for % is closed. Contact your finance manager to reopen the period.',
      to_char(v_je.entry_date, 'FMMonth YYYY');
  END IF;

  IF COALESCE(v_exp.paid_amount, 0) > 0
     OR COALESCE(v_exp.pph_paid_amount, 0) > 0
     OR EXISTS (SELECT 1 FROM public.voucher_allocations va WHERE va.finance_expense_id = p_exp_id)
     OR EXISTS (SELECT 1 FROM public.bank_statement_allocations a
                WHERE (a.document_type = 'expense' AND a.document_id = p_exp_id)
                   OR a.journal_entry_id = v_je.id)
     OR EXISTS (SELECT 1 FROM public.bank_statement_lines b
                WHERE b.matched_expense_id = p_exp_id OR b.matched_entry_id = v_je.id)
     OR EXISTS (SELECT 1 FROM public.bank_reconciliation_items bri WHERE bri.journal_entry_id = v_je.id) THEN
    RAISE EXCEPTION
      'Cannot cancel posting for paid/settled expense %. Reverse or unlink its payment/bank allocation first.',
      COALESCE(v_exp.voucher_number, p_exp_id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  v_reversal_number := public.generate_journal_entry_number();
  INSERT INTO public.journal_entries(
    entry_number, entry_date, period_id, source_module, reference_id,
    reference_number, description, total_debit, total_credit,
    is_posted, is_reversed, posted_by, posted_at, created_by,
    transaction_category, transaction_currency, functional_currency,
    exchange_rate, amounts_are_functional
  ) VALUES (
    v_reversal_number, v_je.entry_date, v_je.period_id, 'expense_cancellation', p_exp_id,
    'CANCEL-' || COALESCE(v_exp.voucher_number, p_exp_id::text),
    'Cancellation reversal of ' || v_je.entry_number || ': ' || p_reason,
    v_je.total_credit, v_je.total_debit,
    true, true, p_cancelled_by, now(), p_cancelled_by,
    v_je.transaction_category, v_je.transaction_currency, v_je.functional_currency,
    v_je.exchange_rate, v_je.amounts_are_functional
  ) RETURNING id INTO v_reversal_id;

  INSERT INTO public.journal_entry_lines(
    journal_entry_id, line_number, account_id, description,
    debit, credit, tax_code_id, customer_id, supplier_id, batch_id,
    transaction_currency, transaction_debit, transaction_credit,
    functional_currency, exchange_rate
  )
  SELECT v_reversal_id, l.line_number, l.account_id,
         'CANCEL: ' || COALESCE(l.description, ''),
         l.credit, l.debit, l.tax_code_id, l.customer_id, l.supplier_id, l.batch_id,
         l.transaction_currency, l.transaction_credit, l.transaction_debit,
         l.functional_currency, l.exchange_rate
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id = v_je.id
  ORDER BY l.line_number;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_reversal_id) THEN
    RAISE EXCEPTION 'Cannot cancel empty journal entry %', v_je.id;
  END IF;

  UPDATE public.journal_entries
  SET is_reversed = true, reversed_by_id = v_reversal_id
  WHERE id = v_je.id AND NOT COALESCE(is_reversed, false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense journal % was already reversed', v_je.id;
  END IF;

  INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values, user_id)
  VALUES (
    'finance_expenses', p_exp_id, 'update',
    jsonb_build_object(
      '_action', 'CANCEL_POSTING',
      'journal_entry_id', v_je.id,
      'journal_entry_number', v_je.entry_number,
      'reversal_journal_id', v_reversal_id,
      'reversal_journal_number', v_reversal_number,
      'entry_date', v_je.entry_date,
      'amount', v_exp.amount,
      'expense_category', v_exp.expense_category,
      'approval_status', v_exp.approval_status,
      'reason', p_reason
    ),
    jsonb_build_object(
      'approval_status', 'cancelled',
      'cancelled_by', p_cancelled_by,
      'cancelled_at', now()
    ),
    p_cancelled_by
  );

  UPDATE public.finance_expenses
  SET approval_status = 'cancelled', approved_by = NULL, approved_at = NULL
  WHERE id = p_exp_id;

  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_module IN ('expense', 'expenses')
      AND reference_id = p_exp_id AND is_posted AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Expense % still has an active journal after cancellation', p_exp_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlink_finance_expense_bank_atomic(
  p_expense_id uuid,
  p_reason text DEFAULT 'Bank statement link removed by user'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense public.finance_expenses%ROWTYPE;
  v_allocation record;
  v_released integer := 0;
BEGIN
  PERFORM public._sec_check_finance_role();
  IF btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'An unlink reason is required';
  END IF;

  SELECT * INTO v_expense
  FROM public.finance_expenses
  WHERE id = p_expense_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  IF v_expense.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Only an active posted expense can be unlinked through this workflow';
  END IF;

  FOR v_allocation IN
    SELECT id
    FROM public.bank_statement_allocations
    WHERE document_type = 'expense'
      AND document_id = p_expense_id
    ORDER BY id
    FOR UPDATE
  LOOP
    PERFORM public.unmatch_bank_statement_allocation(v_allocation.id);
    v_released := v_released + 1;
  END LOOP;
  IF v_released = 0 THEN
    RAISE EXCEPTION 'Expense has no canonical bank allocation to unlink';
  END IF;

  PERFORM public.recalculate_expense_payment_state(p_expense_id);
  PERFORM public.cancel_expense_posting(p_expense_id, auth.uid(), p_reason);

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
    WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN
    RAISE EXCEPTION 'Expense unlink left a bank allocation behind';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
    WHERE source_module IN ('expense', 'expenses')
      AND (reference_id = p_expense_id OR reference_number = 'EXP-' || p_expense_id::text)
      AND is_posted AND NOT COALESCE(is_reversed, false)
  ) THEN
    RAISE EXCEPTION 'Expense unlink left an active journal behind';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses
    WHERE id = p_expense_id AND approval_status = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Expense unlink did not cancel the document';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', p_expense_id,
    'released_allocations', v_released
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unmatch_bank_statement_allocation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unmatch_bank_line(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlink_finance_expense_bank_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_statement_allocation(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_line(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_finance_expense_bank_atomic(uuid, text) TO authenticated, service_role;

COMMIT;
