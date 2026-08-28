-- Add actionable bank-reconciliation diagnostics to Undo Reverse without
-- weakening the existing atomic validation.

CREATE OR REPLACE FUNCTION public.prevent_multiple_bank_line_document_owners()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF num_nonnulls(
    NEW.matched_expense_id,
    NEW.matched_receipt_id,
    NEW.matched_petty_cash_id,
    NEW.matched_fund_transfer_id,
    NEW.matched_tax_payment_id
  ) > 1 THEN
    RAISE EXCEPTION
      'Bank statement line % cannot be linked to more than one source document',
      NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_multiple_bank_line_document_owners
  ON public.bank_statement_lines;

CREATE TRIGGER prevent_multiple_bank_line_document_owners
  BEFORE INSERT OR UPDATE OF
    matched_expense_id,
    matched_receipt_id,
    matched_petty_cash_id,
    matched_fund_transfer_id,
    matched_tax_payment_id
  ON public.bank_statement_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_multiple_bank_line_document_owners();

CREATE OR REPLACE FUNCTION public.describe_undo_reverse_bank_conflict(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer       public.fund_transfers%ROWTYPE;
  v_line           record;
  v_allowed_je_ids uuid[];
  v_doc_type       text;
  v_doc_number     text;
  v_je_id          uuid;
  v_je_number      text;
  v_je_source      text;
  v_je_reference   text;
  v_linked_je_id   uuid;
BEGIN
  SELECT *
    INTO v_transfer
    FROM public.fund_transfers
   WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_allowed_je_ids
    FROM public.journal_entries
   WHERE source_module = 'fund_transfers'
     AND (
       reference_id = p_id
       OR reference_number IN (
         v_transfer.transfer_number,
         'REV-' || v_transfer.transfer_number
       )
     );

  SELECT bsl.*, expected.link_side
    INTO v_line
    FROM (
      VALUES
        (v_transfer.from_bank_statement_line_id, 'source', 1),
        (v_transfer.to_bank_statement_line_id, 'destination', 2)
    ) AS expected(line_id, link_side, sort_order)
    JOIN public.bank_statement_lines bsl ON bsl.id = expected.line_id
   WHERE bsl.matched_expense_id IS NOT NULL
      OR bsl.matched_receipt_id IS NOT NULL
      OR bsl.matched_petty_cash_id IS NOT NULL
      OR bsl.matched_tax_payment_id IS NOT NULL
      OR (
        bsl.matched_fund_transfer_id IS NOT NULL
        AND bsl.matched_fund_transfer_id <> p_id
      )
      OR (
        bsl.matched_entry_id IS NOT NULL
        AND NOT (bsl.matched_entry_id = ANY(v_allowed_je_ids))
      )
   ORDER BY expected.sort_order
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_je_id := CASE
    WHEN v_line.matched_entry_id IS NOT NULL
     AND NOT (v_line.matched_entry_id = ANY(v_allowed_je_ids))
    THEN v_line.matched_entry_id
    ELSE NULL
  END;

  IF v_line.matched_expense_id IS NOT NULL THEN
    v_doc_type := 'Expense';
    SELECT voucher_number
      INTO v_doc_number
      FROM public.finance_expenses
     WHERE id = v_line.matched_expense_id;

    IF v_je_id IS NULL THEN
      SELECT id
        INTO v_je_id
        FROM public.journal_entries
       WHERE source_module = 'expenses'
         AND reference_id = v_line.matched_expense_id
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;
  ELSIF v_line.matched_receipt_id IS NOT NULL THEN
    v_doc_type := 'Receipt Voucher';
    SELECT voucher_number, journal_entry_id
      INTO v_doc_number, v_linked_je_id
      FROM public.receipt_vouchers
     WHERE id = v_line.matched_receipt_id;
    v_je_id := COALESCE(v_je_id, v_linked_je_id);
  ELSIF v_line.matched_petty_cash_id IS NOT NULL THEN
    v_doc_type := 'Petty Cash Transaction';
    SELECT transaction_number
      INTO v_doc_number
      FROM public.petty_cash_transactions
     WHERE id = v_line.matched_petty_cash_id;

    IF v_je_id IS NULL THEN
      SELECT id
        INTO v_je_id
        FROM public.journal_entries
       WHERE source_module = 'petty_cash'
         AND reference_id = v_line.matched_petty_cash_id
       ORDER BY created_at DESC
       LIMIT 1;
    END IF;
  ELSIF v_line.matched_tax_payment_id IS NOT NULL THEN
    v_doc_type := 'Tax Payment';
    SELECT COALESCE(ntpn, billing_code, government_reference, id::text),
           journal_entry_id
      INTO v_doc_number, v_linked_je_id
      FROM public.tax_payments
     WHERE id = v_line.matched_tax_payment_id;
    v_je_id := COALESCE(v_je_id, v_linked_je_id);
  ELSIF v_line.matched_fund_transfer_id IS NOT NULL
        AND v_line.matched_fund_transfer_id <> p_id THEN
    v_doc_type := 'Contra Voucher';
    SELECT transfer_number, journal_entry_id
      INTO v_doc_number, v_linked_je_id
      FROM public.fund_transfers
     WHERE id = v_line.matched_fund_transfer_id;
    v_je_id := COALESCE(v_je_id, v_linked_je_id);
  END IF;

  IF v_je_id IS NOT NULL THEN
    SELECT entry_number, source_module, reference_number
      INTO v_je_number, v_je_source, v_je_reference
      FROM public.journal_entries
     WHERE id = v_je_id;

    v_doc_number := COALESCE(v_doc_number, v_je_reference);
    IF v_doc_type IS NULL THEN
      v_doc_type := CASE v_je_source
        WHEN 'payment' THEN 'Payment Voucher'
        WHEN 'payment_vouchers' THEN 'Payment Voucher'
        WHEN 'receipt' THEN 'Receipt Voucher'
        WHEN 'receipt_vouchers' THEN 'Receipt Voucher'
        WHEN 'fund_transfers' THEN 'Contra Voucher'
        WHEN 'petty_cash' THEN 'Petty Cash Transaction'
        WHEN 'expenses' THEN 'Expense'
        WHEN 'tax_payment' THEN 'Tax Payment'
        WHEN 'tax_payments' THEN 'Tax Payment'
        ELSE 'Journal Entry'
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'kind', 'bank_reconciliation_conflict',
    'bank_statement_line_id', v_line.id,
    'bank_account_id', v_line.bank_account_id,
    'transaction_date', v_line.transaction_date,
    'amount', COALESCE(
      NULLIF(v_line.debit_amount, 0),
      NULLIF(v_line.credit_amount, 0),
      0
    ),
    'currency', COALESCE(
      (SELECT currency
         FROM public.bank_accounts
        WHERE id = v_line.bank_account_id),
      'IDR'
    ),
    'document_type', COALESCE(v_doc_type, 'Linked Transaction'),
    'document_number', COALESCE(v_doc_number, 'Unavailable'),
    'journal_entry_id', v_je_id,
    'journal_entry_number', v_je_number
  );
END;
$$;

ALTER FUNCTION public.undo_reverse_fund_transfer(uuid, text)
  RENAME TO undo_reverse_fund_transfer_core;

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
  v_message  text;
  v_conflict jsonb;
BEGIN
  BEGIN
    RETURN public.undo_reverse_fund_transfer_core(p_id, p_reason);
  EXCEPTION WHEN integrity_constraint_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;

    IF v_message LIKE
       'Cannot undo reversal: the % bank statement line is now linked to another transaction' THEN
      v_conflict := public.describe_undo_reverse_bank_conflict(p_id);
      IF v_conflict IS NOT NULL THEN
        RAISE EXCEPTION '%', v_message
          USING
            ERRCODE = 'integrity_constraint_violation',
            DETAIL = v_conflict::text;
      END IF;
    END IF;

    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_reverse_fund_transfer_core(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.describe_undo_reverse_bank_conflict(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prevent_multiple_bank_line_document_owners() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.undo_reverse_fund_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_reverse_fund_transfer(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
