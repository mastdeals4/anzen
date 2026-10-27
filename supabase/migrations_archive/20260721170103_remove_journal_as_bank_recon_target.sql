-- Remove direct Journal Entry as a bank reconciliation target.\n-- Journal links were either redundant (a typed FK already keeps the link) or\n-- legacy (a manual JE that should have been a receipt/payment voucher).\n-- Payment Voucher links (source_module='payment' with reference_id and no\n-- typed FK) are PRESERVED — they use matched_entry_id as their canonical link.\n\n-- Step 1: Clear matched_entry_id on all redundant links (typed FK already set)\n-- and the single manual-JE-only link. Do NOT touch PV-only links.\nUPDATE bank_statement_lines bsl\nSET matched_entry_id = NULL\nFROM journal_entries je\nWHERE bsl.matched_entry_id = je.id\n  AND (\n    -- Redundant: a typed FK already carries the reconciliation\n    bsl.matched_expense_id IS NOT NULL\n    OR bsl.matched_receipt_id IS NOT NULL\n    OR bsl.matched_fund_transfer_id IS NOT NULL\n    OR bsl.matched_petty_cash_id IS NOT NULL\n    OR bsl.matched_tax_payment_id IS NOT NULL\n    -- Legacy: manual JE with no document backing\n    OR (je.source_module = 'manual' AND je.reference_id IS NULL)\n  )

\n\n-- Step 2: Add a CHECK constraint to prevent future journal-only links.\n-- matched_entry_id may only be set when a typed FK is also set (expense,\n-- receipt, fund_transfer, petty_cash, tax_payment) OR the JE is a payment\n-- voucher (source_module='payment'). We enforce this via a trigger since\n-- CHECK constraints cannot reference other tables.\nCREATE OR REPLACE FUNCTION enforce_no_journal_only_bank_link()\nRETURNS TRIGGER AS $$\nBEGIN\n  -- Allow clearing matched_entry_id\n  IF NEW.matched_entry_id IS NULL THEN\n    RETURN NEW

\n  END IF

\n\n  -- Allow if a typed FK is set (redundant but harmless display fallback)\n  IF NEW.matched_expense_id IS NOT NULL\n     OR NEW.matched_receipt_id IS NOT NULL\n     OR NEW.matched_fund_transfer_id IS NOT NULL\n     OR NEW.matched_petty_cash_id IS NOT NULL\n     OR NEW.matched_tax_payment_id IS NOT NULL THEN\n    RETURN NEW

\n  END IF

\n\n  -- Otherwise, the JE must be a payment voucher (source_module='payment')\n  PERFORM 1 FROM journal_entries je\n  WHERE je.id = NEW.matched_entry_id\n    AND je.source_module = 'payment'

\n\n  IF NOT FOUND THEN\n    RAISE EXCEPTION 'Direct journal-to-bank reconciliation is not allowed. Use Expense, Receipt, Payment Voucher, Fund Transfer, Tax Payment, or Petty Cash instead.'\n      USING ERRCODE = 'check_violation'

\n  END IF

\n\n  RETURN NEW

\nEND

\n$$ LANGUAGE plpgsql SECURITY DEFINER\nSET search_path = public

\n\nDROP TRIGGER IF EXISTS trg_no_journal_only_bank_link ON bank_statement_lines

\nCREATE TRIGGER trg_no_journal_only_bank_link\n  BEFORE INSERT OR UPDATE OF matched_entry_id ON bank_statement_lines\n  FOR EACH ROW\n  EXECUTE FUNCTION enforce_no_journal_only_bank_link()
