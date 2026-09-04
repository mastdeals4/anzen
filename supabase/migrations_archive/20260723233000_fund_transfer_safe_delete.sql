-- Make Contra deletion production-safe without changing posting or journal logic.
-- The existing RPC remains the single atomic deletion path.

CREATE OR REPLACE FUNCTION public.delete_fund_transfer(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transfer             public.fund_transfers%ROWTYPE;
  v_je_ids               uuid[];
  v_period               record;
  v_dependency           record;
  v_orphan_count         integer;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'Fund transfer id is required'
      USING ERRCODE = 'invalid_parameter_value';
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

  IF v_transfer.status = 'posted' THEN
    RAISE EXCEPTION
      'Posted fund transfer % cannot be deleted. Reverse it first, then delete it while the accounting period is open.',
      v_transfer.transfer_number
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT ap.fiscal_year, ap.period_month, ap.status
    INTO v_period
    FROM public.accounting_periods ap
   WHERE ap.start_date <= v_transfer.transfer_date
     AND ap.end_date >= v_transfer.transfer_date
   ORDER BY ap.start_date DESC
   LIMIT 1;

  IF FOUND AND v_period.status <> 'open' THEN
    RAISE EXCEPTION
      'Cannot delete fund transfer %: accounting period %-% is %.',
      v_transfer.transfer_number,
      v_period.fiscal_year,
      lpad(v_period.period_month::text, 2, '0'),
      v_period.status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT je.id), ARRAY[]::uuid[])
    INTO v_je_ids
    FROM public.journal_entries je
   WHERE je.source_module = 'fund_transfers'
     AND (
       je.reference_id = p_id
       OR je.reference_number IN (
         v_transfer.transfer_number,
         'REV-' || v_transfer.transfer_number
       )
     );

  FOR v_period IN
    SELECT DISTINCT
           ap.fiscal_year,
           ap.period_month,
           ap.status,
           je.entry_date
      FROM public.journal_entries je
      JOIN public.accounting_periods ap
        ON ap.start_date <= je.entry_date
       AND ap.end_date >= je.entry_date
     WHERE je.id = ANY(v_je_ids)
       AND ap.status <> 'open'
  LOOP
    RAISE EXCEPTION
      'Cannot delete fund transfer %: journal accounting period %-% for % is %.',
      v_transfer.transfer_number,
      v_period.fiscal_year,
      lpad(v_period.period_month::text, 2, '0'),
      v_period.entry_date,
      v_period.status
      USING ERRCODE = 'check_violation';
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.reversed_by_id = ANY(v_je_ids)
       AND NOT (je.id = ANY(v_je_ids))
  ) THEN
    RAISE EXCEPTION
      'Cannot delete fund transfer %: an unrelated journal entry depends on its reversal journal.',
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Refuse to let an unexpected ON DELETE action modify another document.
  -- Expected Contra, ledger, and reconciliation owners are cleaned below.
  FOR v_dependency IN
    SELECT c.conrelid::regclass AS relation_name,
           a.attname AS column_name
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.journal_entries'::regclass
       AND array_length(c.conkey, 1) = 1
       AND NOT (
         (c.conrelid = 'public.journal_entry_lines'::regclass
          AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.fund_transfers'::regclass
             AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.bank_statement_lines'::regclass
             AND a.attname = 'matched_entry_id')
         OR (c.conrelid = 'public.bank_reconciliation_items'::regclass
             AND a.attname = 'journal_entry_id')
         OR (c.conrelid = 'public.journal_entries'::regclass
             AND a.attname = 'reversed_by_id')
       )
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s WHERE %I = ANY($1)',
      v_dependency.relation_name,
      v_dependency.column_name
    )
    INTO v_orphan_count
    USING v_je_ids;

    IF v_orphan_count <> 0 THEN
      RAISE EXCEPTION
        'Cannot delete fund transfer %: % dependent record(s) in % still reference its journal entry.',
        v_transfer.transfer_number,
        v_orphan_count,
        v_dependency.relation_name
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;

  -- Break the Fund Transfer -> Journal Entry FK cycle before deleting journals.
  UPDATE public.fund_transfers
     SET journal_entry_id = NULL
   WHERE id = p_id;

  -- Release only links owned by this Contra or one of its collected journals.
  UPDATE public.bank_statement_lines
     SET matched_fund_transfer_id = NULL,
         matched_entry_id = NULL,
         reconciliation_status = 'unmatched',
         matched_at = NULL,
         matched_by = NULL,
         notes = NULL
   WHERE matched_fund_transfer_id = p_id
      OR matched_entry_id = ANY(v_je_ids);

  UPDATE public.bank_reconciliation_items
     SET journal_entry_id = NULL,
         is_matched = false,
         matched_at = NULL
   WHERE journal_entry_id = ANY(v_je_ids);

  -- Petty Cash displays current Fund Transfers directly. This cleanup is only
  -- for legacy projection rows and cannot create or alter accounting.
  DELETE FROM public.petty_cash_transactions
   WHERE fund_transfer_id = p_id;

  UPDATE public.journal_entries
     SET is_reversed = false,
         reversed_by_id = NULL
   WHERE id = ANY(v_je_ids)
     AND reversed_by_id = ANY(v_je_ids);

  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id = ANY(v_je_ids);

  DELETE FROM public.journal_entries
   WHERE id = ANY(v_je_ids);

  DELETE FROM public.fund_transfers
   WHERE id = p_id;

  -- Every check runs before commit. Any failure rolls the entire deletion back.
  SELECT count(*)
    INTO v_orphan_count
    FROM public.fund_transfers
   WHERE id = p_id;
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: fund transfer % still exists. No changes were committed.',
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.journal_entries
   WHERE id = ANY(v_je_ids)
      OR (
        source_module = 'fund_transfers'
        AND (
          reference_id = p_id
          OR reference_number IN (
            v_transfer.transfer_number,
            'REV-' || v_transfer.transfer_number
          )
        )
      );
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related journal entries remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.journal_entry_lines
   WHERE journal_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related ledger postings remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.petty_cash_transactions
   WHERE fund_transfer_id = p_id;
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % related Petty Cash rows remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.bank_statement_lines
   WHERE matched_fund_transfer_id = p_id
      OR matched_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % Bank Reconciliation links remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT count(*)
    INTO v_orphan_count
    FROM public.bank_reconciliation_items
   WHERE journal_entry_id = ANY(v_je_ids);
  IF v_orphan_count <> 0 THEN
    RAISE EXCEPTION
      'Delete failed: % Bank Reconciliation items remain for fund transfer %. No changes were committed.',
      v_orphan_count,
      v_transfer.transfer_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_fund_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fund_transfer(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
