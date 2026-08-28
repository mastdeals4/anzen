/*
# Propagate Bank Statement Line Amount Edit to Linked Documents (v2)

## Purpose
When a user edits a bank statement line's debit/credit amount in Bank Reconciliation,
the change must propagate to the linked document and its journal entries.

## Approach
- Expenses: UPDATE amount → trigger_auto_post_expense_accounting_update fires automatically
- Petty cash: UPDATE amount → trigger_post_petty_cash_on_approval fires automatically
- Fund transfers: UPDATE amount, then manually update journal entry lines (only INSERT trigger exists)
- Payment vouchers: UPDATE amount, then manually update journal entry lines (sync trigger only handles currency)
- Receipt vouchers: UPDATE amount, then manually update journal entry lines (sync trigger only handles currency)
- Tax payments: UPDATE amount, then manually update journal entry lines
- Journal entries: update lines directly

## Security
- EXECUTE granted to authenticated only.
- SECURITY DEFINER so it can update linked tables and journal entries.
*/

CREATE OR REPLACE FUNCTION public.propagate_bank_line_amount_edit(
  p_line_id uuid,
  p_new_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_line record;
  v_old_amount numeric;
  v_doc_type text;
  v_doc_id uuid;
  v_je_id uuid;
  v_bank_coa uuid;
  v_counter_coa uuid;
BEGIN
  SELECT * INTO v_line FROM bank_statement_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Bank statement line not found');
  END IF;

  v_old_amount := COALESCE(v_line.debit_amount, 0) + COALESCE(v_line.credit_amount, 0);

  -- Determine linked document type and ID
  IF v_line.matched_expense_id IS NOT NULL THEN
    v_doc_type := 'expense';
    v_doc_id := v_line.matched_expense_id;
    -- Update expense amount; trigger_auto_post_expense_accounting_update will re-post journal
    UPDATE finance_expenses SET amount = p_new_amount WHERE id = v_doc_id;

  ELSIF v_line.matched_receipt_id IS NOT NULL THEN
    v_doc_type := 'receipt_voucher';
    v_doc_id := v_line.matched_receipt_id;
    UPDATE receipt_vouchers SET amount = p_new_amount WHERE id = v_doc_id;
    -- Manually update journal entry lines if a JE exists
    SELECT journal_entry_id INTO v_je_id FROM receipt_vouchers WHERE id = v_doc_id;
    IF v_je_id IS NOT NULL THEN
      -- Update the bank/cash debit line and the AR credit line
      UPDATE journal_entry_lines
      SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE debit END,
          credit = CASE WHEN credit > 0 THEN p_new_amount ELSE credit END
      WHERE journal_entry_id = v_je_id;
      -- Update JE totals
      UPDATE journal_entries
      SET total_debit = (SELECT COALESCE(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
          total_credit = (SELECT COALESCE(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
      WHERE id = v_je_id;
    END IF;

  ELSIF v_line.matched_payment_id IS NOT NULL THEN
    v_doc_type := 'payment_voucher';
    v_doc_id := v_line.matched_payment_id;
    UPDATE payment_vouchers SET amount = p_new_amount WHERE id = v_doc_id;
    SELECT journal_entry_id INTO v_je_id FROM payment_vouchers WHERE id = v_doc_id;
    IF v_je_id IS NOT NULL THEN
      UPDATE journal_entry_lines
      SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE debit END,
          credit = CASE WHEN credit > 0 THEN p_new_amount ELSE credit END
      WHERE journal_entry_id = v_je_id;
      UPDATE journal_entries
      SET total_debit = (SELECT COALESCE(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
          total_credit = (SELECT COALESCE(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
      WHERE id = v_je_id;
    END IF;

  ELSIF v_line.matched_fund_transfer_id IS NOT NULL THEN
    v_doc_type := 'fund_transfer';
    v_doc_id := v_line.matched_fund_transfer_id;
    UPDATE fund_transfers SET amount = p_new_amount WHERE id = v_doc_id;
    -- Fund transfer only has INSERT trigger, so manually update JE lines
    SELECT journal_entry_id INTO v_je_id FROM fund_transfers WHERE id = v_doc_id;
    IF v_je_id IS NOT NULL THEN
      UPDATE journal_entry_lines
      SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE debit END,
          credit = CASE WHEN credit > 0 THEN p_new_amount ELSE credit END
      WHERE journal_entry_id = v_je_id;
      UPDATE journal_entries
      SET total_debit = (SELECT COALESCE(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
          total_credit = (SELECT COALESCE(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
      WHERE id = v_je_id;
    END IF;

  ELSIF v_line.matched_petty_cash_id IS NOT NULL THEN
    v_doc_type := 'petty_cash';
    v_doc_id := v_line.matched_petty_cash_id;
    -- Update petty cash amount; trigger_post_petty_cash_on_approval will re-post journal
    UPDATE petty_cash_transactions SET amount = p_new_amount WHERE id = v_doc_id;

  ELSIF v_line.matched_tax_payment_id IS NOT NULL THEN
    v_doc_type := 'tax_payment';
    v_doc_id := v_line.matched_tax_payment_id;
    UPDATE tax_payments SET amount = p_new_amount WHERE id = v_doc_id;
    SELECT journal_entry_id INTO v_je_id FROM tax_payments WHERE id = v_doc_id;
    IF v_je_id IS NOT NULL THEN
      UPDATE journal_entry_lines
      SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE debit END,
          credit = CASE WHEN credit > 0 THEN p_new_amount ELSE credit END
      WHERE journal_entry_id = v_je_id;
      UPDATE journal_entries
      SET total_debit = (SELECT COALESCE(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
          total_credit = (SELECT COALESCE(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
      WHERE id = v_je_id;
    END IF;

  ELSIF v_line.matched_entry_id IS NOT NULL THEN
    v_doc_type := 'journal_entry';
    v_doc_id := v_line.matched_entry_id;
    v_je_id := v_doc_id;
    UPDATE journal_entry_lines
    SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE debit END,
        credit = CASE WHEN credit > 0 THEN p_new_amount ELSE credit END
    WHERE journal_entry_id = v_je_id;
    UPDATE journal_entries
    SET total_debit = (SELECT COALESCE(sum(debit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id),
        total_credit = (SELECT COALESCE(sum(credit),0) FROM journal_entry_lines WHERE journal_entry_id = v_je_id)
    WHERE id = v_je_id;

  ELSE
    v_doc_type := 'none';
    v_doc_id := NULL;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'doc_type', v_doc_type,
    'doc_id', v_doc_id,
    'old_amount', v_old_amount,
    'new_amount', p_new_amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.propagate_bank_line_amount_edit(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propagate_bank_line_amount_edit(uuid, numeric) TO authenticated;
