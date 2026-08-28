-- Record non-customer bank receipts directly as journal entries.
-- Customer receipts continue to use receipt_vouchers and the existing posting RPC.

-- Keep the journal-only reconciliation guard, but allow a journal that is
-- explicitly owned by this bank statement line. Arbitrary manual journals
-- remain blocked.
CREATE OR REPLACE FUNCTION public.enforce_no_journal_only_bank_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.matched_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.matched_expense_id IS NOT NULL
     OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL
     OR NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM public.journal_entries je
   WHERE je.id = NEW.matched_entry_id
     AND (
       je.source_module = 'payment'
       OR (
         je.source_module = 'bank_reconciliation'
         AND je.reference_id = NEW.id
       )
     );

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Direct journal-to-bank reconciliation is not allowed. Use a supported finance document or record a non-customer bank receipt.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_non_customer_bank_receipt(
  p_bank_statement_line_id uuid,
  p_receipt_type text,
  p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_line public.bank_statement_lines%ROWTYPE;
  v_bank_account_id uuid;
  v_counter_account_id uuid;
  v_counter_account_code text;
  v_type text;
  v_type_label text;
  v_description text;
  v_journal_id uuid;
  v_entry_number text;
  v_existing_journal public.journal_entries%ROWTYPE;
BEGIN
  PERFORM public._sec_check_finance_role();

  IF p_bank_statement_line_id IS NULL THEN
    RAISE EXCEPTION 'Bank statement line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_type := lower(trim(COALESCE(p_receipt_type, '')));
  SELECT mapped.account_code, mapped.type_label
    INTO v_counter_account_code, v_type_label
    FROM (
      VALUES
        ('capital',       '3100', 'Capital Injection'),
        ('loan',          '2210', 'Loan Received'),
        ('bank_interest', '4920', 'Bank Interest'),
        ('other_income',  '4900', 'Other Income'),
        ('misc_income',   '4910', 'Miscellaneous Income'),
        ('refund',        '4900', 'Refund / Cash Return')
    ) AS mapped(receipt_type, account_code, type_label)
   WHERE mapped.receipt_type = v_type;

  IF v_counter_account_code IS NULL THEN
    RAISE EXCEPTION 'Unsupported non-customer receipt type: %', p_receipt_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
    INTO v_line
    FROM public.bank_statement_lines
   WHERE id = p_bank_statement_line_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank statement line % not found', p_bank_statement_line_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF COALESCE(v_line.credit_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Only bank credit transactions can be recorded as receipts'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_existing_journal
    FROM public.journal_entries
   WHERE source_module = 'bank_reconciliation'
     AND reference_id = v_line.id
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  -- A retry after a successful call returns the original journal instead of
  -- creating duplicate accounting.
  IF v_line.matched_entry_id IS NOT NULL THEN
    IF v_existing_journal.id = v_line.matched_entry_id THEN
      RETURN jsonb_build_object(
        'journal_entry_id', v_existing_journal.id,
        'entry_number', v_existing_journal.entry_number,
        'reused', true
      );
    END IF;

    RAISE EXCEPTION 'Bank statement line is already linked to another journal entry'
      USING ERRCODE = 'unique_violation';
  END IF;

  IF v_line.matched_expense_id IS NOT NULL
     OR v_line.matched_receipt_id IS NOT NULL
     OR v_line.matched_petty_cash_id IS NOT NULL
     OR v_line.matched_fund_transfer_id IS NOT NULL
     OR v_line.matched_tax_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Bank statement line is already linked to another accounting document'
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT ba.coa_id
    INTO v_bank_account_id
    FROM public.bank_accounts ba
   WHERE ba.id = v_line.bank_account_id
     AND ba.is_active = true;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'Selected bank account is not linked to an active Chart of Accounts entry'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT coa.id
    INTO v_counter_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.code = v_counter_account_code
     AND coa.is_active = true
     AND COALESCE(coa.is_header, false) = false;

  IF v_counter_account_id IS NULL THEN
    RAISE EXCEPTION 'Required account % for % is missing or inactive',
      v_counter_account_code, v_type_label
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_description := COALESCE(
    NULLIF(trim(p_description), ''),
    NULLIF(trim(v_line.description), ''),
    v_type_label
  );

  IF v_existing_journal.id IS NULL THEN
    v_entry_number := public.generate_journal_entry_number();

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
      created_by
    ) VALUES (
      v_entry_number,
      v_line.transaction_date,
      'bank_reconciliation',
      v_line.id,
      'BSL-' || v_line.id::text,
      v_description,
      v_line.credit_amount,
      v_line.credit_amount,
      true,
      auth.uid(),
      auth.uid()
    )
    RETURNING id INTO v_journal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      line_number,
      account_id,
      description,
      debit,
      credit
    ) VALUES
      (
        v_journal_id,
        1,
        v_bank_account_id,
        v_description,
        v_line.credit_amount,
        0
      ),
      (
        v_journal_id,
        2,
        v_counter_account_id,
        v_description,
        0,
        v_line.credit_amount
      );
  ELSE
    v_journal_id := v_existing_journal.id;
    v_entry_number := v_existing_journal.entry_number;
  END IF;

  UPDATE public.bank_statement_lines
     SET matched_entry_id = v_journal_id,
         reconciliation_status = 'recorded',
         matching_status = 'confirmed',
         matched_at = now(),
         matched_by = auth.uid(),
         manually_unlinked = false,
         notes = v_type_label || ' - ' || v_entry_number
   WHERE id = v_line.id;

  RETURN jsonb_build_object(
    'journal_entry_id', v_journal_id,
    'entry_number', v_entry_number,
    'reused', v_existing_journal.id IS NOT NULL
  );
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_journal_entries_bank_reconciliation_reference
ON public.journal_entries (source_module, reference_id)
WHERE source_module = 'bank_reconciliation'
  AND reference_id IS NOT NULL;

REVOKE ALL ON FUNCTION public.record_non_customer_bank_receipt(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_non_customer_bank_receipt(uuid, text, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
