BEGIN;

-- The legacy auto-matcher counted candidate UUIDs with MIN(uuid). PostgreSQL
-- has no UUID MIN aggregate. Preserve the intended rule (match only one unique
-- candidate) and choose that candidate deterministically by creation order.
CREATE OR REPLACE FUNCTION public.auto_match_bank_statement_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_count integer;
  v_tolerance numeric := 1.0;
BEGIN
  IF NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_expense_id IS NOT NULL
     OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL
     OR NEW.matched_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.debit_amount, 0) > 0 THEN
    WITH candidates AS MATERIALIZED (
      SELECT x.id, x.created_at
      FROM public.petty_cash_transactions x
      WHERE x.transaction_type = 'withdraw'
        AND x.bank_account_id = NEW.bank_account_id
        AND x.transaction_date = NEW.transaction_date
        AND abs(x.amount - NEW.debit_amount) <= v_tolerance
        AND NOT EXISTS (
          SELECT 1 FROM public.bank_statement_lines b
          WHERE b.id <> NEW.id AND b.matched_petty_cash_id = x.id
        )
    )
    SELECT count(*),
           (SELECT c.id FROM candidates c ORDER BY c.created_at DESC, c.id LIMIT 1)
      INTO v_count, v_id
      FROM candidates;
    IF v_count = 1 THEN
      NEW.matched_petty_cash_id := v_id;
      NEW.reconciliation_status := 'matched';
      NEW.matched_at := now();
      RETURN NEW;
    END IF;

    WITH candidates AS MATERIALIZED (
      SELECT x.id, x.created_at
      FROM public.finance_expenses x
      WHERE x.bank_account_id = NEW.bank_account_id
        AND x.expense_date = NEW.transaction_date
        AND abs(x.amount - NEW.debit_amount) <= v_tolerance
        AND x.payment_method IN ('bank_transfer', 'check')
        AND NOT EXISTS (
          SELECT 1 FROM public.bank_statement_lines b
          WHERE b.id <> NEW.id AND b.matched_expense_id = x.id
        )
    )
    SELECT count(*),
           (SELECT c.id FROM candidates c ORDER BY c.created_at DESC, c.id LIMIT 1)
      INTO v_count, v_id
      FROM candidates;
    IF v_count = 1 THEN
      NEW.matched_expense_id := v_id;
      NEW.reconciliation_status := 'matched';
      NEW.matched_at := now();
      RETURN NEW;
    END IF;
  END IF;

  IF COALESCE(NEW.credit_amount, 0) > 0 THEN
    WITH candidates AS MATERIALIZED (
      SELECT x.id, x.created_at
      FROM public.receipt_vouchers x
      WHERE x.bank_account_id = NEW.bank_account_id
        AND x.voucher_date = NEW.transaction_date
        AND abs(x.amount - NEW.credit_amount) <= v_tolerance
        AND x.payment_method IN ('bank_transfer', 'check')
        AND NOT EXISTS (
          SELECT 1 FROM public.bank_statement_lines b
          WHERE b.id <> NEW.id AND b.matched_receipt_id = x.id
        )
    )
    SELECT count(*),
           (SELECT c.id FROM candidates c ORDER BY c.created_at DESC, c.id LIMIT 1)
      INTO v_count, v_id
      FROM candidates;
    IF v_count = 1 THEN
      NEW.matched_receipt_id := v_id;
      NEW.reconciliation_status := 'matched';
      NEW.matched_at := now();
      RETURN NEW;
    END IF;
  END IF;

  IF NEW.reconciliation_status IS NULL THEN
    NEW.reconciliation_status := 'unmatched';
  END IF;
  RETURN NEW;
END;
$$;

-- Expense cancellation has a narrower accounting contract than deletion:
-- settled cash evidence must be reversed/unlinked through its own workflow;
-- an unsettled posting is retained with an explicit, non-effective reversal
-- journal and an audit link. No journal or cash evidence is deleted here.
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
      'approval_status', 'pending_approval',
      'cancelled_by', p_cancelled_by,
      'cancelled_at', now()
    ),
    p_cancelled_by
  );

  UPDATE public.finance_expenses
  SET approval_status = 'pending_approval', approved_by = NULL, approved_at = NULL
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

REVOKE ALL ON FUNCTION public.auto_match_bank_statement_line() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_match_bank_statement_line() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_expense_posting(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
