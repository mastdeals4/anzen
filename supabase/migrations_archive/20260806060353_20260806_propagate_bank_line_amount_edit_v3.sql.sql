/*
# Fix propagate_bank_line_amount_edit: Petty Cash handling

## Problem
The previous version relied on the petty cash trigger to re-post the journal
when amount changed. But trigger_post_petty_cash_on_approval only fires when
approval_status changes to 'approved' — NOT on amount-only updates.
So updating a petty cash amount via bank recon edit would update the petty_cash_transactions
row but leave the old journal entry with the wrong amount.

## Fix
For petty cash, find the linked journal entry via reference_id = petty_cash_transactions.id
AND source_module = 'petty_cash', then update its journal_entry_lines and totals directly.
This is the same approach used for receipt vouchers, payment vouchers, fund transfers, etc.

## Idempotency
- Expense trigger: fires on amount change, deletes old JE first, creates new — no double post.
- Petty cash: now manually updates existing JE lines — no new JE created.
- All other doc types: manually update existing JE lines — no new JE created.
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
    -- Update expense amount; trigger_auto_post_expense_accounting_update will:
    -- 1. Check if amount actually changed (idempotency guard)
    -- 2. Delete old journal entry
    -- 3. Create new journal entry with correct amount
    -- No double post possible — trigger deletes before inserting.
    UPDATE finance_expenses SET amount = p_new_amount WHERE id = v_doc_id;

  ELSIF v_line.matched_receipt_id IS NOT NULL THEN
    v_doc_type := 'receipt_voucher';
    v_doc_id := v_line.matched_receipt_id;
    UPDATE receipt_vouchers SET amount = p_new_amount WHERE id = v_doc_id;
    -- Find linked JE and update lines (no trigger re-posts on amount change)
    SELECT journal_entry_id INTO v_je_id FROM receipt_vouchers WHERE id = v_doc_id;
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
    -- Update petty cash amount
    UPDATE petty_cash_transactions SET amount = p_new_amount WHERE id = v_doc_id;
    -- trigger_post_petty_cash_on_approval only fires on approval_status change,
    -- NOT on amount-only update. So find the linked JE manually and update lines.
    SELECT id INTO v_je_id FROM journal_entries
    WHERE reference_id = v_doc_id AND source_module = 'petty_cash'
    LIMIT 1;
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
