-- Keep expense recognition and actual bank payment as separate accounting events.
--
-- The existing expense journal trigger is intentionally preserved.  For a new
-- or still-editable expense, selecting `bank_transfer` must not make the
-- recognition journal credit Bank. Normalising that input to the existing NULL
-- payment method makes
-- the trigger post Dr expense/tax and Cr A/P (2110).  The existing payment
-- voucher commands remain the only path that posts an actual bank movement.
--
-- Historical rows and existing journal rows are not rewritten by this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_unlinked_expense_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.payment_method = 'bank_transfer' THEN
    -- A bank account is only meaningful on the actual payment event.  Keep
    -- payment_reference for document traceability; it is not a bank posting.
    NEW.payment_method := NULL;
    NEW.bank_account_id := NULL;
    NEW.paid_by := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_unlinked_expense_payment
  ON public.finance_expenses;
CREATE TRIGGER trg_normalize_unlinked_expense_payment
BEFORE INSERT OR UPDATE
ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.normalize_unlinked_expense_payment();

REVOKE ALL ON FUNCTION public.normalize_unlinked_expense_payment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_unlinked_expense_payment() TO service_role;

COMMENT ON FUNCTION public.normalize_unlinked_expense_payment() IS
  'Prevents an unlinked bank_transfer expense from crediting Bank at recognition time; actual payment is posted by payment voucher/reconciliation.';

NOTIFY pgrst, 'reload schema';
COMMIT;
