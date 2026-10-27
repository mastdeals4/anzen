/*
  # Centralized Auto Journal Posting for Approved Transactions

  Ensures automatic and consistent posting for:
  - petty_cash_transactions
  - finance_expenses
  - fund_transfers

  Rules:
  - Triggered on INSERT and UPDATE
  - Only posts when approval_status = 'approved'
  - Idempotent: skips if journal already exists
  - Logs failures to journal_posting_failures
*/

CREATE TABLE IF NOT EXISTS journal_posting_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table TEXT NOT NULL,
  reference_id UUID NOT NULL,
  operation TEXT NOT NULL,
  error_message TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_posting_failures_source
  ON journal_posting_failures(source_table, reference_id, created_at DESC);

CREATE OR REPLACE FUNCTION log_journal_posting_failure(
  p_source_table TEXT,
  p_reference_id UUID,
  p_operation TEXT,
  p_error_message TEXT,
  p_payload JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO journal_posting_failures (
    source_table,
    reference_id,
    operation,
    error_message,
    payload
  ) VALUES (
    p_source_table,
    p_reference_id,
    p_operation,
    p_error_message,
    p_payload
  );
END;
$$;

CREATE OR REPLACE FUNCTION post_journal_for_approved_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_module TEXT;
  v_reference_number TEXT;
  v_exists BOOLEAN := FALSE;
BEGIN
  IF COALESCE(NEW.approval_status, '') <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'petty_cash_transactions' THEN
    v_source_module := 'petty_cash';
    v_reference_number := NULL;
  ELSIF TG_TABLE_NAME = 'finance_expenses' THEN
    v_source_module := 'expenses';
    v_reference_number := 'EXP-' || NEW.id::TEXT;
  ELSIF TG_TABLE_NAME = 'fund_transfers' THEN
    v_source_module := 'fund_transfers';
    v_reference_number := COALESCE(NEW.transfer_number, 'FT-' || NEW.id::TEXT);
  ELSE
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM journal_entries je
    WHERE je.source_module = v_source_module
      AND (
        je.reference_id = NEW.id
        OR (v_reference_number IS NOT NULL AND je.reference_number = v_reference_number)
      )
  ) INTO v_exists;

  IF v_exists THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF TG_TABLE_NAME = 'petty_cash_transactions' THEN
      PERFORM post_petty_cash_to_journal() FROM (SELECT NEW.*) n;
    ELSIF TG_TABLE_NAME = 'finance_expenses' THEN
      PERFORM auto_post_expense_accounting() FROM (SELECT NEW.*) n;
    ELSIF TG_TABLE_NAME = 'fund_transfers' THEN
      PERFORM auto_post_fund_transfer_journal() FROM (SELECT NEW.*) n;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      PERFORM log_journal_posting_failure(
        TG_TABLE_NAME,
        NEW.id,
        TG_OP,
        SQLERRM,
        to_jsonb(NEW)
      );
      RAISE WARNING 'Journal posting failed for %.% (%): %', TG_TABLE_NAME, NEW.id, TG_OP, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Replace direct posting triggers with centralized trigger
DROP TRIGGER IF EXISTS trigger_post_petty_cash ON petty_cash_transactions;
DROP TRIGGER IF EXISTS trigger_auto_post_expense_accounting ON finance_expenses;
DROP TRIGGER IF EXISTS trigger_auto_post_fund_transfer_journal ON fund_transfers;

DROP TRIGGER IF EXISTS trigger_central_auto_post_journal ON petty_cash_transactions;
CREATE TRIGGER trigger_central_auto_post_journal
  AFTER INSERT OR UPDATE ON petty_cash_transactions
  FOR EACH ROW
  EXECUTE FUNCTION post_journal_for_approved_transaction();

DROP TRIGGER IF EXISTS trigger_central_auto_post_journal ON finance_expenses;
CREATE TRIGGER trigger_central_auto_post_journal
  AFTER INSERT OR UPDATE ON finance_expenses
  FOR EACH ROW
  EXECUTE FUNCTION post_journal_for_approved_transaction();

DROP TRIGGER IF EXISTS trigger_central_auto_post_journal ON fund_transfers;
CREATE TRIGGER trigger_central_auto_post_journal
  AFTER INSERT OR UPDATE ON fund_transfers
  FOR EACH ROW
  EXECUTE FUNCTION post_journal_for_approved_transaction();
