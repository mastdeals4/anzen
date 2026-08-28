/*
  # Fix bank reconciliation unlink - prevent auto re-match after manual unlink

  ## Problem
  When a user unlinks a bank statement line, the auto-match trigger immediately
  re-matches it because it fires BEFORE UPDATE and sees all match IDs as NULL.

  ## Solution
  Add a `manually_unlinked` boolean flag to bank_statement_lines.
  When set to TRUE, the auto-match trigger skips that row.
  The unlink operation sets this flag. Re-importing or manual re-matching clears it.

  Also update the trigger WHEN condition to exclude manually unlinked rows.
*/

-- Add manually_unlinked column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bank_statement_lines' AND column_name = 'manually_unlinked'
  ) THEN
    ALTER TABLE bank_statement_lines ADD COLUMN manually_unlinked BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Recreate the trigger with an updated WHEN condition that respects manually_unlinked
DROP TRIGGER IF EXISTS trg_auto_match_bank_statement ON bank_statement_lines;

CREATE TRIGGER trg_auto_match_bank_statement
  BEFORE INSERT OR UPDATE ON bank_statement_lines
  FOR EACH ROW
  WHEN (
    NEW.matched_petty_cash_id IS NULL 
    AND NEW.matched_expense_id IS NULL 
    AND NEW.matched_receipt_id IS NULL
    AND (NEW.manually_unlinked IS NULL OR NEW.manually_unlinked = false)
  )
  EXECUTE FUNCTION auto_match_bank_statement_line();
