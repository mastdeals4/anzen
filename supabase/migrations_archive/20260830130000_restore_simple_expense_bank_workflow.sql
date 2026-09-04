/*
 * Restore the document-first expense workflow without introducing another
 * journal builder. The orchestration functions below call the existing
 * save/approve/link/cancel commands, so their validations and the canonical
 * auto_post_expense_accounting trigger remain authoritative.
 *
 * This migration changes functions only; it contains no data repair.
 */

BEGIN;

CREATE OR REPLACE FUNCTION public.validate_expense_bank_allocation_against_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bank_coa uuid;
  v_bank_account_id uuid;
  v_statement_is_debit boolean;
  v_journal_bank_amount numeric;
  v_document_bank_allocated numeric;
BEGIN
  IF NEW.document_type <> 'expense' OR NEW.payment_kind <> 'supplier' THEN
    RETURN NEW;
  END IF;

  SELECT b.bank_account_id, COALESCE(b.debit_amount, 0) > 0
    INTO v_bank_account_id, v_statement_is_debit
    FROM public.bank_statement_lines b
   WHERE b.id = NEW.bank_statement_line_id;
  SELECT coa_id INTO v_bank_coa
    FROM public.bank_accounts WHERE id = v_bank_account_id;
  SELECT COALESCE(sum(
           CASE WHEN v_statement_is_debit
             THEN COALESCE(l.transaction_credit, l.credit)
             ELSE COALESCE(l.transaction_debit, l.debit)
           END
         ), 0)
    INTO v_journal_bank_amount
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = NEW.journal_entry_id
     AND l.account_id = v_bank_coa;
  SELECT COALESCE(sum(a.allocation_amount), 0) + NEW.allocation_amount
    INTO v_document_bank_allocated
    FROM public.bank_statement_allocations a
    JOIN public.bank_statement_lines b ON b.id = a.bank_statement_line_id
   WHERE a.document_type = 'expense'
     AND a.document_id = NEW.document_id
     AND a.payment_kind = 'supplier'
     AND b.bank_account_id = v_bank_account_id
     AND (TG_OP <> 'UPDATE' OR a.id <> NEW.id);
  IF v_journal_bank_amount + 0.01 < v_document_bank_allocated THEN
    RAISE EXCEPTION
      'Edited expense no longer supports its existing bank allocation. Select a matching bank transaction or unlink first.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_validate_expense_bank_allocations_after_edit
  ON public.finance_expenses;
DROP FUNCTION IF EXISTS public.validate_expense_bank_allocations_after_edit();
DROP TRIGGER IF EXISTS zz_validate_expense_bank_allocation_against_journal
  ON public.bank_statement_allocations;
CREATE TRIGGER zz_validate_expense_bank_allocation_against_journal
BEFORE INSERT OR UPDATE OF bank_statement_line_id, document_type, document_id,
  journal_entry_id, allocation_amount, payment_kind
ON public.bank_statement_allocations
FOR EACH ROW EXECUTE FUNCTION public.validate_expense_bank_allocation_against_journal();

CREATE OR REPLACE FUNCTION public.save_and_link_finance_expense_atomic(
  p_expense_id uuid DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_bank_statement_line_id uuid DEFAULT NULL,
  p_allocation_amount numeric DEFAULT NULL,
  p_approved_by uuid DEFAULT NULL,
  p_apply_salary_advances boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expense_id uuid;
  v_journal_id uuid;
  v_journal_count integer;
  v_allocation_count integer;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_bank_statement_line_id IS NULL THEN
    RAISE EXCEPTION 'A bank statement line is required for atomic expense linking';
  END IF;

  -- Serialize concurrent attempts against both the source document and bank
  -- line before any document or accounting write is made.
  PERFORM 1
    FROM public.bank_statement_lines
   WHERE id = p_bank_statement_line_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found'; END IF;

  IF p_expense_id IS NOT NULL THEN
    PERFORM 1 FROM public.finance_expenses WHERE id = p_expense_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
    IF EXISTS (
      SELECT 1 FROM public.finance_expenses
       WHERE id = p_expense_id AND approval_status = 'approved'
    ) THEN
      RAISE EXCEPTION 'Approved expenses must use the canonical approved-edit command';
    END IF;
  END IF;

  -- Existing document command: a new/unlinked expense remains pending until
  -- the approval call below. Any later failure rolls this insert/update back.
  PERFORM set_config('app.expense_atomic_bank_link', 'on', true);
  v_expense_id := public.save_finance_expense(p_expense_id, p_payload);

  IF p_apply_salary_advances THEN
    PERFORM public.apply_salary_advances_to_expense(v_expense_id, true);
  END IF;

  -- Existing approval command invokes the one canonical expense journal
  -- builder through trigger_auto_post_expense_accounting.
  PERFORM public.approve_finance_expense(
    v_expense_id,
    COALESCE(p_approved_by, auth.uid())
  );

  SELECT count(*), (array_agg(id ORDER BY created_at DESC, id DESC))[1]
    INTO v_journal_count, v_journal_id
    FROM public.journal_entries
   WHERE source_module IN ('expense', 'expenses')
     AND (
       reference_id = v_expense_id
       OR reference_number = 'EXP-' || v_expense_id::text
     )
     AND is_posted = true
     AND NOT COALESCE(is_reversed, false);
  IF v_journal_count <> 1 THEN
    RAISE EXCEPTION 'Expense bank link requires exactly one active effective journal';
  END IF;

  -- Existing canonical link command validates bank account, currency, amount,
  -- journal bank side, split-allocation capacity, and duplicate allocation.
  PERFORM public.link_bank_statement_line(
    p_bank_statement_line_id,
    'expense',
    v_expense_id,
    'supplier',
    p_allocation_amount
  );

  SELECT count(*) INTO v_allocation_count
    FROM public.bank_statement_allocations
   WHERE bank_statement_line_id = p_bank_statement_line_id
     AND document_type = 'expense'
     AND document_id = v_expense_id
     AND payment_kind = 'supplier'
     AND journal_entry_id = v_journal_id;
  IF v_allocation_count <> 1 THEN
    RAISE EXCEPTION 'Expense bank link did not preserve exactly one canonical allocation';
  END IF;

  PERFORM public.recalculate_expense_payment_state(v_expense_id);
  RETURN v_expense_id;
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
  v_expense public.finance_expenses%rowtype;
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
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_expense.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'Only an active posted expense can be unlinked through this workflow';
  END IF;

  -- Remove only allocations owned by this expense. Split allocations for
  -- other documents on the same statement line remain untouched.
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

  -- Once its cash evidence is safely released, use the existing audited,
  -- period-checked reversal command to return the document to pending. This
  -- is the explicit unlink operation, never part of ordinary editing.
  PERFORM public.cancel_expense_posting(
    p_expense_id,
    auth.uid(),
    p_reason
  );

  IF EXISTS (
    SELECT 1 FROM public.bank_statement_allocations
     WHERE document_type = 'expense' AND document_id = p_expense_id
  ) THEN RAISE EXCEPTION 'Expense unlink left a bank allocation behind'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.journal_entries
     WHERE source_module IN ('expense', 'expenses')
       AND (reference_id = p_expense_id OR reference_number = 'EXP-' || p_expense_id::text)
       AND is_posted AND NOT COALESCE(is_reversed, false)
  ) THEN RAISE EXCEPTION 'Expense unlink left an active journal behind'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_expenses
     WHERE id = p_expense_id AND approval_status = 'pending_approval'
  ) THEN RAISE EXCEPTION 'Expense unlink did not return the document to pending'; END IF;

  RETURN jsonb_build_object(
    'success', true,
    'expense_id', p_expense_id,
    'released_allocations', v_released
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_and_link_finance_expense_atomic(uuid,jsonb,uuid,numeric,uuid,boolean)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.unlink_finance_expense_bank_atomic(uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_finance_expense_bank_atomic(uuid,text)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.validate_expense_bank_allocation_against_journal()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_expense_bank_allocation_against_journal()
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
