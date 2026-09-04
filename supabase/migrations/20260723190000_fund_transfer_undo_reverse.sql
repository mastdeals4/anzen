-- Production-safe Undo Reverse for Contra Vouchers.
--
-- Accounting history is preserved:
--   * the original journal is reactivated;
--   * the reversing journal and its lines remain stored but become inactive;
--   * the Fund Transfer returns to posted;
--   * one audit_logs row records the operation.
--
-- A later Reverse reuses the preserved reversing journal instead of creating
-- another journal entry.

CREATE OR REPLACE FUNCTION public.undo_reverse_fund_transfer(
  p_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id             uuid := auth.uid();
  v_role                text;
  v_user_active         boolean;
  v_transfer            public.fund_transfers%ROWTYPE;
  v_original_je         public.journal_entries%ROWTYPE;
  v_reversal_je         public.journal_entries%ROWTYPE;
  v_related_je_count    integer;
  v_active_je_count     integer;
  v_period_status       text;
  v_bank_link           record;
  v_bank_line           public.bank_statement_lines%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role, is_active
    INTO v_role, v_user_active
    FROM public.user_profiles
   WHERE id = v_user_id;

  IF NOT FOUND OR NOT COALESCE(v_user_active, false)
     OR v_role NOT IN ('admin', 'accounts') THEN
    RAISE EXCEPTION 'Permission denied: only active admin or accounts users can undo a Contra reversal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT *
    INTO v_transfer
    FROM public.fund_transfers
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_transfer.status <> 'reversed' THEN
    RAISE EXCEPTION
      'Undo Reverse is unavailable for % because its status is %; the reversal may already have been undone',
      v_transfer.transfer_number, v_transfer.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_transfer.journal_entry_id IS NOT NULL THEN
    SELECT *
      INTO v_original_je
      FROM public.journal_entries
     WHERE id = v_transfer.journal_entry_id
     FOR UPDATE;
  END IF;

  IF v_original_je.id IS NULL THEN
    SELECT *
      INTO v_original_je
      FROM public.journal_entries
     WHERE source_module = 'fund_transfers'
       AND reference_id = p_id
       AND reference_number = v_transfer.transfer_number
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE;
  END IF;

  IF v_original_je.id IS NULL THEN
    RAISE EXCEPTION 'Cannot undo reversal: original journal for % was not found',
      v_transfer.transfer_number USING ERRCODE = 'no_data_found';
  END IF;

  IF v_original_je.source_module <> 'fund_transfers'
     OR v_original_je.reference_id IS DISTINCT FROM p_id
     OR v_original_je.reference_number IS DISTINCT FROM v_transfer.transfer_number THEN
    RAISE EXCEPTION 'Cannot undo reversal: the original journal link for % is inconsistent',
      v_transfer.transfer_number USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT COALESCE(v_original_je.is_posted, false)
     OR NOT COALESCE(v_original_je.is_reversed, false)
     OR v_original_je.reversed_by_id IS NULL THEN
    RAISE EXCEPTION 'Cannot undo reversal: original journal % is not in the expected reversed state',
      v_original_je.entry_number USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_reversal_je
    FROM public.journal_entries
   WHERE id = v_original_je.reversed_by_id
   FOR UPDATE;

  IF v_reversal_je.id IS NULL THEN
    RAISE EXCEPTION 'Cannot undo reversal: reversing journal for % was not found',
      v_transfer.transfer_number USING ERRCODE = 'no_data_found';
  END IF;

  IF v_reversal_je.source_module <> 'fund_transfers'
     OR v_reversal_je.reference_id IS DISTINCT FROM p_id
     OR v_reversal_je.reference_number IS DISTINCT FROM ('REV-' || v_transfer.transfer_number)
     OR NOT COALESCE(v_reversal_je.is_posted, false)
     OR COALESCE(v_reversal_je.is_reversed, false) THEN
    RAISE EXCEPTION 'Cannot undo reversal: reversing journal % is not active or is linked inconsistently',
      v_reversal_je.entry_number USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT COUNT(*)
    INTO v_related_je_count
    FROM public.journal_entries
   WHERE source_module = 'fund_transfers'
     AND (
       reference_id = p_id
       OR reference_number IN (
         v_transfer.transfer_number,
         'REV-' || v_transfer.transfer_number
       )
     );

  IF v_related_je_count <> 2 THEN
    RAISE EXCEPTION
      'Cannot undo reversal: expected exactly two journals for %, found %',
      v_transfer.transfer_number, v_related_je_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines
     WHERE journal_entry_id = v_original_je.id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines
     WHERE journal_entry_id = v_reversal_je.id
  ) THEN
    RAISE EXCEPTION 'Cannot undo reversal: original or reversing journal has no ledger lines'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF EXISTS (
    (
      SELECT line_number, account_id, debit, credit
        FROM public.journal_entry_lines
       WHERE journal_entry_id = v_original_je.id
      EXCEPT ALL
      SELECT line_number, account_id, credit, debit
        FROM public.journal_entry_lines
       WHERE journal_entry_id = v_reversal_je.id
    )
    UNION ALL
    (
      SELECT line_number, account_id, debit, credit
        FROM public.journal_entry_lines
       WHERE journal_entry_id = v_reversal_je.id
      EXCEPT ALL
      SELECT line_number, account_id, credit, debit
        FROM public.journal_entry_lines
       WHERE journal_entry_id = v_original_je.id
    )
  ) THEN
    RAISE EXCEPTION 'Cannot undo reversal: journal % is no longer the exact inverse of %',
      v_reversal_je.entry_number, v_original_je.entry_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT status
    INTO v_period_status
    FROM public.accounting_periods
   WHERE start_date <= v_original_je.entry_date
     AND end_date >= v_original_je.entry_date
   ORDER BY start_date DESC
   LIMIT 1;

  IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot undo reversal: the original accounting period for % is %',
      to_char(v_original_je.entry_date, 'FMMonth YYYY'), v_period_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_period_status := NULL;
  SELECT status
    INTO v_period_status
    FROM public.accounting_periods
   WHERE start_date <= v_reversal_je.entry_date
     AND end_date >= v_reversal_je.entry_date
   ORDER BY start_date DESC
   LIMIT 1;

  IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot undo reversal: the reversal accounting period for % is %',
      to_char(v_reversal_je.entry_date, 'FMMonth YYYY'), v_period_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bank_statement_lines
     WHERE matched_fund_transfer_id = p_id
       AND id IS DISTINCT FROM v_transfer.from_bank_statement_line_id
       AND id IS DISTINCT FROM v_transfer.to_bank_statement_line_id
  ) THEN
    RAISE EXCEPTION
      'Cannot undo reversal: an unexpected bank statement line is linked to %',
      v_transfer.transfer_number USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.bank_statement_lines
     WHERE matched_entry_id = v_reversal_je.id
       AND id IS DISTINCT FROM v_transfer.from_bank_statement_line_id
       AND id IS DISTINCT FROM v_transfer.to_bank_statement_line_id
  ) THEN
    RAISE EXCEPTION
      'Cannot undo reversal: the reversing journal has a later bank reconciliation dependency'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  FOR v_bank_link IN
    SELECT *
      FROM (
        VALUES
          (
            v_transfer.from_bank_statement_line_id,
            CASE WHEN v_transfer.from_account_type = 'bank'
                 THEN v_transfer.from_bank_account_id ELSE NULL END,
            'source'
          ),
          (
            v_transfer.to_bank_statement_line_id,
            CASE WHEN v_transfer.to_account_type = 'bank'
                 THEN v_transfer.to_bank_account_id ELSE NULL END,
            'destination'
          )
      ) AS expected(line_id, bank_account_id, link_side)
     WHERE line_id IS NOT NULL
  LOOP
    SELECT *
      INTO v_bank_line
      FROM public.bank_statement_lines
     WHERE id = v_bank_link.line_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'Cannot undo reversal: the % bank statement line no longer exists',
        v_bank_link.link_side USING ERRCODE = 'no_data_found';
    END IF;

    IF v_bank_link.bank_account_id IS NULL
       OR v_bank_line.bank_account_id IS DISTINCT FROM v_bank_link.bank_account_id THEN
      RAISE EXCEPTION
        'Cannot undo reversal: the % bank statement line belongs to a different bank account',
        v_bank_link.link_side USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF v_bank_line.matched_expense_id IS NOT NULL
       OR v_bank_line.matched_receipt_id IS NOT NULL
       OR v_bank_line.matched_petty_cash_id IS NOT NULL
       OR v_bank_line.matched_tax_payment_id IS NOT NULL
       OR (
         v_bank_line.matched_fund_transfer_id IS NOT NULL
         AND v_bank_line.matched_fund_transfer_id <> p_id
       )
       OR (
         v_bank_line.matched_entry_id IS NOT NULL
         AND v_bank_line.matched_entry_id NOT IN (v_original_je.id, v_reversal_je.id)
       ) THEN
      RAISE EXCEPTION
        'Cannot undo reversal: the % bank statement line is now linked to another transaction',
        v_bank_link.link_side USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;

  UPDATE public.journal_entries
     SET is_posted = false,
         is_reversed = true
   WHERE id = v_reversal_je.id;

  UPDATE public.journal_entries
     SET is_posted = true,
         is_reversed = false,
         reversed_by_id = NULL
   WHERE id = v_original_je.id;

  UPDATE public.fund_transfers
     SET status = 'posted',
         journal_entry_id = v_original_je.id,
         reversed_at = NULL,
         reversed_by = NULL
   WHERE id = p_id;

  FOR v_bank_link IN
    SELECT *
      FROM (
        VALUES
          (v_transfer.from_bank_statement_line_id, 'source'),
          (v_transfer.to_bank_statement_line_id, 'destination')
      ) AS expected(line_id, link_side)
     WHERE line_id IS NOT NULL
  LOOP
    UPDATE public.bank_statement_lines
       SET matched_fund_transfer_id = p_id,
           matched_entry_id = v_original_je.id,
           reconciliation_status = 'matched',
           matched_at = now(),
           matched_by = v_user_id,
           manually_unlinked = false,
           notes = 'Linked to Fund Transfer ' || v_transfer.transfer_number
     WHERE id = v_bank_link.line_id;
  END LOOP;

  SELECT COUNT(*)
    INTO v_active_je_count
    FROM public.journal_entries
   WHERE source_module = 'fund_transfers'
     AND reference_id = p_id
     AND is_posted = true
     AND COALESCE(is_reversed, false) = false;

  IF v_active_je_count <> 1 THEN
    RAISE EXCEPTION
      'Undo Reverse aborted: expected one active journal for %, found %',
      v_transfer.transfer_number, v_active_je_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.audit_logs (
    table_name,
    record_id,
    action_type,
    old_values,
    new_values,
    user_id
  ) VALUES (
    'fund_transfers',
    p_id,
    'update',
    jsonb_build_object(
      '_action', 'UNDO_REVERSE',
      'status', 'reversed',
      'reversed_at', v_transfer.reversed_at,
      'reversed_by', v_transfer.reversed_by,
      'original_journal_id', v_original_je.id,
      'original_journal_number', v_original_je.entry_number,
      'reversal_journal_id', v_reversal_je.id,
      'reversal_reference', v_reversal_je.entry_number,
      'reason', NULLIF(BTRIM(p_reason), '')
    ),
    jsonb_build_object(
      'status', 'posted',
      'active_journal_id', v_original_je.id,
      'voided_reversal_journal_id', v_reversal_je.id,
      'undone_by', v_user_id,
      'undone_at', now()
    ),
    v_user_id
  );

  RETURN v_original_je.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.undo_reverse_fund_transfer(uuid, text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.undo_reverse_fund_transfer(uuid, text) FROM anon;

-- Preserve idempotency across a Reverse -> Undo Reverse -> Reverse lifecycle.
CREATE OR REPLACE FUNCTION public.reverse_fund_transfer(p_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row                    public.fund_transfers%ROWTYPE;
  v_original_je_id         uuid;
  v_new_je_id              uuid;
  v_new_je_number          text;
  v_existing_reversal      public.journal_entries%ROWTYPE;
  v_period_status          text;
BEGIN
  SELECT *
    INTO v_row
    FROM public.fund_transfers
   WHERE id = p_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund transfer % not found', p_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted fund transfers can be reversed (current status: %)', v_row.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT id
    INTO v_original_je_id
    FROM public.journal_entries
   WHERE source_module = 'fund_transfers'
     AND reference_id = p_id
     AND reference_number = v_row.transfer_number
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE;

  IF v_original_je_id IS NULL THEN
    RAISE EXCEPTION 'Original journal entry for fund transfer % not found', v_row.transfer_number
      USING ERRCODE = 'no_data_found';
  END IF;

  v_new_je_number := 'REV-' || v_row.transfer_number;

  SELECT *
    INTO v_existing_reversal
    FROM public.journal_entries
   WHERE source_module = 'fund_transfers'
     AND reference_id = p_id
     AND reference_number = v_new_je_number
   LIMIT 1
   FOR UPDATE;

  IF v_existing_reversal.id IS NOT NULL THEN
    IF COALESCE(v_existing_reversal.is_posted, false)
       OR NOT COALESCE(v_existing_reversal.is_reversed, false) THEN
      RAISE EXCEPTION 'Cannot reverse %: its preserved reversal journal is already active or inconsistent',
        v_row.transfer_number USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF EXISTS (
      (
        SELECT line_number, account_id, debit, credit
          FROM public.journal_entry_lines
         WHERE journal_entry_id = v_original_je_id
        EXCEPT ALL
        SELECT line_number, account_id, credit, debit
          FROM public.journal_entry_lines
         WHERE journal_entry_id = v_existing_reversal.id
      )
      UNION ALL
      (
        SELECT line_number, account_id, debit, credit
          FROM public.journal_entry_lines
         WHERE journal_entry_id = v_existing_reversal.id
        EXCEPT ALL
        SELECT line_number, account_id, credit, debit
          FROM public.journal_entry_lines
         WHERE journal_entry_id = v_original_je_id
      )
    ) THEN
      RAISE EXCEPTION 'Cannot reverse %: its preserved reversal journal no longer matches the original',
        v_row.transfer_number USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT status
      INTO v_period_status
      FROM public.accounting_periods
     WHERE start_date <= v_existing_reversal.entry_date
       AND end_date >= v_existing_reversal.entry_date
     ORDER BY start_date DESC
     LIMIT 1;

    IF v_period_status IS NOT NULL AND v_period_status <> 'open' THEN
      RAISE EXCEPTION
        'Cannot reverse %: the preserved reversal period for % is %',
        v_row.transfer_number,
        to_char(v_existing_reversal.entry_date, 'FMMonth YYYY'),
        v_period_status USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.journal_entries
       SET is_posted = true,
           is_reversed = false
     WHERE id = v_existing_reversal.id;

    UPDATE public.journal_entries
       SET is_reversed = true,
           reversed_by_id = v_existing_reversal.id
     WHERE id = v_original_je_id;

    UPDATE public.fund_transfers
       SET status = 'reversed',
           reversed_at = now(),
           reversed_by = auth.uid()
     WHERE id = p_id;

    RETURN v_existing_reversal.id;
  END IF;

  INSERT INTO public.journal_entries (
    entry_number,
    entry_date,
    description,
    source_module,
    reference_id,
    reference_number,
    is_posted,
    created_by
  )
  SELECT
    v_new_je_number,
    CURRENT_DATE,
    'Reversal of ' || COALESCE(je.description, je.entry_number),
    'fund_transfers',
    p_id,
    v_new_je_number,
    true,
    auth.uid()
  FROM public.journal_entries je
  WHERE je.id = v_original_je_id
  RETURNING id INTO v_new_je_id;

  UPDATE public.journal_entries
     SET is_reversed = true,
         reversed_by_id = v_new_je_id
   WHERE id = v_original_je_id;

  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    line_number,
    account_id,
    description,
    debit,
    credit
  )
  SELECT
    v_new_je_id,
    line_number,
    account_id,
    'REV: ' || COALESCE(description, ''),
    credit,
    debit
  FROM public.journal_entry_lines
  WHERE journal_entry_id = v_original_je_id;

  UPDATE public.fund_transfers
     SET status = 'reversed',
         reversed_at = now(),
         reversed_by = auth.uid()
   WHERE id = p_id;

  RETURN v_new_je_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reverse_fund_transfer(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.reverse_fund_transfer(uuid) FROM anon;

NOTIFY pgrst, 'reload schema';
