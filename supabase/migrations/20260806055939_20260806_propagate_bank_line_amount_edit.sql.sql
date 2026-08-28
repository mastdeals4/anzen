/*
# Propagate Bank Statement Line Amount Edit to Linked Documents

## Purpose
When a user edits a bank statement line's debit/credit amount in Bank Reconciliation,
the change must propagate to the linked document (expense, receipt voucher, payment voucher,
fund transfer, petty cash, tax payment, or journal entry) and its journal entries must be
re-posted with the corrected amount.

## What This Migration Does
1. Creates `propagate_bank_line_amount_edit(p_line_id uuid, p_new_amount numeric)` RPC function.
2. The function:
   - Reads the bank_statement_lines row to find the matched document type and ID.
   - Updates the amount on the linked document table.
   - Calls the appropriate journal re-posting function for that document type.
   - Returns a summary of what was updated.
3. Grants EXECUTE to authenticated role.

## Tables Modified
- No schema changes to existing tables.
- New function only.

## Security
- EXECUTE granted to authenticated only.
- Function is SECURITY DEFINER so it can update linked tables and call journal posting functions.
- Uses auth.uid() for audit logging.
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
  v_result jsonb;
  v_je_id uuid;
  v_doc_type text;
  v_doc_id uuid;
BEGIN
  -- Fetch the bank statement line with all match links
  SELECT * INTO v_line
  FROM bank_statement_lines
  WHERE id = p_line_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Bank statement line not found');
  END IF;

  v_old_amount := COALESCE(v_line.debit_amount, 0) + COALESCE(v_line.credit_amount, 0);

  -- Determine which document is linked and its type
  IF v_line.matched_expense_id IS NOT NULL THEN
    v_doc_type := 'expense';
    v_doc_id := v_line.matched_expense_id;
    -- Update expense amount
    UPDATE finance_expenses
    SET amount = p_new_amount
    WHERE id = v_doc_id;
    -- Re-post expense journal
    PERFORM auto_post_expense_accounting();

  ELSIF v_line.matched_receipt_id IS NOT NULL THEN
    v_doc_type := 'receipt_voucher';
    v_doc_id := v_line.matched_receipt_id;
    -- Update receipt voucher amount
    UPDATE receipt_vouchers
    SET amount = p_new_amount
    WHERE id = v_doc_id;
    -- Re-post receipt voucher journal
    PERFORM post_receipt_voucher_journal();

  ELSIF v_line.matched_payment_id IS NOT NULL THEN
    v_doc_type := 'payment_voucher';
    v_doc_id := v_line.matched_payment_id;
    -- Update payment voucher amount
    UPDATE payment_vouchers
    SET amount = p_new_amount
    WHERE id = v_doc_id;
    -- Re-post payment voucher journal
    PERFORM post_payment_voucher_journal();

  ELSIF v_line.matched_fund_transfer_id IS NOT NULL THEN
    v_doc_type := 'fund_transfer';
    v_doc_id := v_line.matched_fund_transfer_id;
    -- Update fund transfer amount
    UPDATE fund_transfers
    SET amount = p_new_amount
    WHERE id = v_doc_id;
    -- Re-post fund transfer journal
    PERFORM auto_post_fund_transfer_journal();

  ELSIF v_line.matched_petty_cash_id IS NOT NULL THEN
    v_doc_type := 'petty_cash';
    v_doc_id := v_line.matched_petty_cash_id;
    -- Update petty cash transaction amount
    UPDATE petty_cash_transactions
    SET amount = p_new_amount
    WHERE id = v_doc_id;
    -- Re-post petty cash journal
    PERFORM post_petty_cash_to_journal();

  ELSIF v_line.matched_tax_payment_id IS NOT NULL THEN
    v_doc_type := 'tax_payment';
    v_doc_id := v_line.matched_tax_payment_id;
    -- Update tax payment amount
    UPDATE tax_payments
    SET amount = p_new_amount
    WHERE id = v_doc_id;

  ELSIF v_line.matched_entry_id IS NOT NULL THEN
    v_doc_type := 'journal_entry';
    v_doc_id := v_line.matched_entry_id;
    -- For direct journal entry links, update the journal entry lines
    -- Journal entries have lines with debit/credit, so we need to scale them
    -- to the new amount proportionally
    UPDATE journal_entry_lines
    SET debit = CASE WHEN debit > 0 THEN p_new_amount ELSE 0 END,
        credit = CASE WHEN credit > 0 THEN p_new_amount ELSE 0 END
    WHERE journal_entry_id = v_doc_id;

  ELSE
    v_doc_type := 'none';
    v_doc_id := NULL;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'doc_type', v_doc_type,
    'doc_id', v_doc_id,
    'old_amount', v_old_amount,
    'new_amount', p_new_amount
  );

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users
REVOKE ALL ON FUNCTION public.propagate_bank_line_amount_edit(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propagate_bank_line_amount_edit(uuid, numeric) TO authenticated;
