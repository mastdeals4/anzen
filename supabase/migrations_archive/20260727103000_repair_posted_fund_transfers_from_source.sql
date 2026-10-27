-- A posted Fund Transfer is the authoritative business document for its
-- existing transfer journal and validation metadata. This repair is
-- deliberately metadata/link-only: it neither posts nor creates a journal,
-- and never writes debit or credit values.

CREATE OR REPLACE FUNCTION public.repair_posted_fund_transfer_from_source(p_fund_transfer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_transfer public.fund_transfers%ROWTYPE;
  v_journal public.journal_entries%ROWTYPE;
  v_from_coa uuid;
  v_to_coa uuid;
  v_from_currency text;
  v_to_currency text;
  v_journal_currency text;
  v_expected_rate numeric;
  v_before_lines jsonb;
  v_after_lines jsonb;
  v_repaired_fields text[] := ARRAY[]::text[];
  v_possible_bank_transactions integer;
  v_validation_failures integer;
  v_live_validation_failures integer;
  v_validation_passed boolean;
BEGIN
  PERFORM public._sec_check_finance_role();
  PERFORM set_config('app.finance_historical_repair', 'on', true);
  PERFORM set_config('app.finance_metadata_repair', 'on', true);

  SELECT * INTO v_transfer
  FROM public.fund_transfers
  WHERE id = p_fund_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fund Transfer not found';
  END IF;
  IF v_transfer.status <> 'posted' OR v_transfer.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer is not posted with an existing journal');
  END IF;

  SELECT * INTO v_journal
  FROM public.journal_entries
  WHERE id = v_transfer.journal_entry_id
  FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_journal.is_posted, false) OR COALESCE(v_journal.is_reversed, false) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer journal is not an active posted journal');
  END IF;
  IF v_journal.source_module NOT IN ('fund_transfer', 'fund_transfers')
     OR v_journal.reference_id IS DISTINCT FROM v_transfer.id THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer and journal do not prove an authoritative relationship');
  END IF;

  IF v_transfer.from_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO v_from_coa, v_from_currency
    FROM public.bank_accounts WHERE id = v_transfer.from_bank_account_id AND is_active;
  ELSIF v_transfer.from_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_from_coa, v_from_currency FROM public.chart_of_accounts WHERE code = '1102' AND is_active LIMIT 1;
  ELSIF v_transfer.from_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_from_coa, v_from_currency FROM public.chart_of_accounts WHERE code = '1101' AND is_active LIMIT 1;
  END IF;

  IF v_transfer.to_account_type = 'bank' THEN
    SELECT coa_id, upper(currency) INTO v_to_coa, v_to_currency
    FROM public.bank_accounts WHERE id = v_transfer.to_bank_account_id AND is_active;
  ELSIF v_transfer.to_account_type = 'petty_cash' THEN
    SELECT id, 'IDR' INTO v_to_coa, v_to_currency FROM public.chart_of_accounts WHERE code = '1102' AND is_active LIMIT 1;
  ELSIF v_transfer.to_account_type = 'cash_on_hand' THEN
    SELECT id, 'IDR' INTO v_to_coa, v_to_currency FROM public.chart_of_accounts WHERE code = '1101' AND is_active LIMIT 1;
  END IF;

  IF v_from_coa IS NULL OR v_to_coa IS NULL OR v_from_currency IS NULL OR v_to_currency IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer source does not contain complete active account and currency information');
  END IF;
  IF v_transfer.from_amount IS NULL OR v_transfer.to_amount IS NULL OR v_transfer.exchange_rate IS NULL THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer source is missing an amount or exchange rate');
  END IF;

  v_expected_rate := CASE
    WHEN v_from_currency = v_to_currency THEN 1
    WHEN v_from_currency = 'IDR' AND v_transfer.to_amount > 0 THEN v_transfer.from_amount / v_transfer.to_amount
    WHEN v_to_currency = 'IDR' AND v_transfer.from_amount > 0 THEN v_transfer.to_amount / v_transfer.from_amount
  END;
  IF v_expected_rate IS NULL OR abs(v_transfer.exchange_rate - v_expected_rate) > 0.000001 THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Fund Transfer exchange rate is not internally consistent with its stored amounts');
  END IF;
  IF (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id AND line_number = 1 AND COALESCE(debit, 0) > 0 AND COALESCE(credit, 0) = 0)
     OR NOT EXISTS (SELECT 1 FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id AND line_number = 2 AND COALESCE(credit, 0) > 0 AND COALESCE(debit, 0) = 0) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Existing journal lines are not a safe two-line transfer journal');
  END IF;
  IF abs(COALESCE(v_journal.total_debit, 0) - COALESCE(v_transfer.from_amount, 0)) > 0.01
     OR abs(COALESCE(v_journal.total_credit, 0) - COALESCE(v_transfer.from_amount, 0)) > 0.01
     OR EXISTS (
       SELECT 1 FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = v_journal.id
         AND ((l.line_number = 1 AND abs(COALESCE(l.debit, 0) - v_transfer.from_amount) > 0.01)
           OR (l.line_number = 2 AND abs(COALESCE(l.credit, 0) - v_transfer.from_amount) > 0.01))
     ) THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Existing posted journal amounts do not match the Fund Transfer source');
  END IF;

  -- No bank transaction is inferred or relinked. If the source document does
  -- not name a line, explicitly refuse to guess, especially when candidates
  -- are ambiguous. The accountant can resolve the missing source information.
  IF v_transfer.from_bank_statement_line_id IS NULL AND v_transfer.from_account_type = 'bank' THEN
    SELECT count(*) INTO v_possible_bank_transactions
    FROM public.bank_statement_lines b
    WHERE b.bank_account_id = v_transfer.from_bank_account_id
      AND abs(b.transaction_date - v_transfer.transfer_date) <= 8
      AND (COALESCE(b.debit_amount, 0) = v_transfer.from_amount OR COALESCE(b.credit_amount, 0) = v_transfer.from_amount);
    IF v_possible_bank_transactions > 1 THEN
      RETURN jsonb_build_object('repaired', false, 'reason', 'Multiple possible From Bank transactions exist; no bank link was guessed');
    END IF;
  END IF;
  IF v_transfer.to_bank_statement_line_id IS NULL AND v_transfer.to_account_type = 'bank' THEN
    SELECT count(*) INTO v_possible_bank_transactions
    FROM public.bank_statement_lines b
    WHERE b.bank_account_id = v_transfer.to_bank_account_id
      AND abs(b.transaction_date - v_transfer.transfer_date) <= 8
      AND (COALESCE(b.debit_amount, 0) = v_transfer.to_amount OR COALESCE(b.credit_amount, 0) = v_transfer.to_amount);
    IF v_possible_bank_transactions > 1 THEN
      RETURN jsonb_build_object('repaired', false, 'reason', 'Multiple possible To Bank transactions exist; no bank link was guessed');
    END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'debit', debit, 'credit', credit) ORDER BY id)
  INTO v_before_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id;

  v_journal_currency := CASE WHEN v_from_currency = v_to_currency THEN v_from_currency ELSE 'IDR' END;
  UPDATE public.journal_entries
  SET source_module = 'fund_transfers', reference_id = v_transfer.id,
      reference_number = v_transfer.transfer_number, transaction_currency = v_journal_currency,
      functional_currency = 'IDR', exchange_rate = v_transfer.exchange_rate,
      amounts_are_functional = true
  WHERE id = v_journal.id
    AND (source_module IS DISTINCT FROM 'fund_transfers' OR reference_id IS DISTINCT FROM v_transfer.id
      OR reference_number IS DISTINCT FROM v_transfer.transfer_number OR transaction_currency IS DISTINCT FROM v_journal_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM v_transfer.exchange_rate
      OR amounts_are_functional IS DISTINCT FROM true);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_metadata'); END IF;

  UPDATE public.journal_entry_lines
  SET account_id = v_to_coa, transaction_currency = v_to_currency,
      functional_currency = 'IDR', exchange_rate = CASE WHEN v_to_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END
  WHERE journal_entry_id = v_journal.id AND line_number = 1
    AND (account_id IS DISTINCT FROM v_to_coa OR transaction_currency IS DISTINCT FROM v_to_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM CASE WHEN v_to_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_debit_line_metadata'); END IF;

  UPDATE public.journal_entry_lines
  SET account_id = v_from_coa, transaction_currency = v_from_currency,
      functional_currency = 'IDR', exchange_rate = CASE WHEN v_from_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END
  WHERE journal_entry_id = v_journal.id AND line_number = 2
    AND (account_id IS DISTINCT FROM v_from_coa OR transaction_currency IS DISTINCT FROM v_from_currency
      OR functional_currency IS DISTINCT FROM 'IDR' OR exchange_rate IS DISTINCT FROM CASE WHEN v_from_currency = 'USD' THEN v_transfer.exchange_rate ELSE 1 END);
  IF FOUND THEN v_repaired_fields := array_append(v_repaired_fields, 'journal_credit_line_metadata'); END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'debit', debit, 'credit', credit) ORDER BY id)
  INTO v_after_lines FROM public.journal_entry_lines WHERE journal_entry_id = v_journal.id;
  IF v_before_lines IS DISTINCT FROM v_after_lines THEN
    RAISE EXCEPTION 'Fund Transfer repair cancelled because a debit or credit value changed';
  END IF;

  -- The existing validation projections are live views. Read them after the
  -- metadata updates; resolve the false-positive only when they are clean.
  SELECT count(*) INTO v_validation_failures
  FROM public.finance_historical_repair_verification_failures f
  WHERE f.document_type = 'fund_transfer' AND f.database_id = v_transfer.id;
  SELECT count(*) INTO v_live_validation_failures
  FROM public.finance_live_verification_failures f
  WHERE f.document_type = 'fund_transfer' AND f.document_id = v_transfer.id;
  v_validation_failures := v_validation_failures + v_live_validation_failures;
  v_validation_passed := v_validation_failures = 0;
  IF v_validation_passed THEN
    UPDATE public.finance_historical_repair_exceptions
    SET status = 'resolved'
    WHERE status = 'manual_review' AND document_type = 'fund_transfer' AND document_id = v_transfer.id;
  END IF;

  -- A no-op retry produces no second audit mutation. The first successful
  -- call records the exact derived fields changed and immutable line values.
  IF COALESCE(array_length(v_repaired_fields, 1), 0) > 0 THEN
    INSERT INTO public.audit_logs(table_name, action_type, record_id, old_values, new_values, changed_fields)
    VALUES ('fund_transfers', 'update', v_transfer.id,
      jsonb_build_object('journal_entry_id', v_journal.id, 'journal_lines', v_before_lines),
      jsonb_build_object('journal_entry_id', v_journal.id, 'journal_lines', v_after_lines,
        'validation_rerun', true, 'validation_passed', v_validation_passed),
      v_repaired_fields);
  END IF;

  IF NOT v_validation_passed THEN
    RETURN jsonb_build_object('repaired', false, 'reason', 'Derived data still fails the existing Finance validation', 'validation_failures', v_validation_failures);
  END IF;

  RETURN jsonb_build_object('repaired', true, 'repaired_fields', v_repaired_fields,
    'validation_rerun', true, 'journal_entry_id', v_journal.id);
END;
$$;

REVOKE ALL ON FUNCTION public.repair_posted_fund_transfer_from_source(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repair_posted_fund_transfer_from_source(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
