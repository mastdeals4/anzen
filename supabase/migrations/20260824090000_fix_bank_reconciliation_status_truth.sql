-- Keep bank reconciliation status derived from actual links/allocations.
-- This migration installs the trigger that the canonical status function
-- already defines; it does not mutate existing bank statement data.

BEGIN;

CREATE OR REPLACE FUNCTION public.bsl_sync_reconciliation_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_has_allocation boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.bank_statement_allocations
    WHERE bank_statement_line_id = NEW.id
  ) INTO v_has_allocation;

  IF NEW.matched_expense_id IS NOT NULL
     OR NEW.matched_receipt_id IS NOT NULL
     OR NEW.matched_payment_id IS NOT NULL
     OR NEW.matched_fund_transfer_id IS NOT NULL
     OR NEW.matched_petty_cash_id IS NOT NULL
     OR NEW.matched_tax_payment_id IS NOT NULL
     OR NEW.matched_entry_id IS NOT NULL
     OR v_has_allocation THEN
    IF NEW.reconciliation_status IS NULL OR NEW.reconciliation_status = 'unmatched' THEN
      NEW.reconciliation_status := 'matched';
    END IF;
  ELSE
    NEW.reconciliation_status := 'unmatched';
    NEW.matching_status := 'none';
    NEW.matched_at := NULL;
    NEW.matched_by := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bsl_sync_reconciliation_status ON public.bank_statement_lines;
CREATE TRIGGER trg_bsl_sync_reconciliation_status
BEFORE INSERT OR UPDATE OF
  reconciliation_status,
  matched_expense_id,
  matched_receipt_id,
  matched_payment_id,
  matched_fund_transfer_id,
  matched_petty_cash_id,
  matched_tax_payment_id,
  matched_entry_id
ON public.bank_statement_lines
FOR EACH ROW
EXECUTE FUNCTION public.bsl_sync_reconciliation_status();

COMMENT ON TRIGGER trg_bsl_sync_reconciliation_status ON public.bank_statement_lines IS
  'Ensures matched/recorded state cannot exist without a real document link or allocation.';

COMMIT;
