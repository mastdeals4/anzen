-- Ensure the canonical import-broker poster runs before the expense journal
-- state synchronizer. PostgreSQL executes same-kind triggers alphabetically;
-- the previous zzzzz_ names let the synchronizer reject an approval before
-- post_customs_broker_canonical could create the journal.
--
-- This migration changes trigger order only. It neither changes the canonical
-- calculation nor touches existing expenses, journals, allocations, or banks.

BEGIN;

DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_insert
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_update
  ON public.finance_expenses;

CREATE TRIGGER a_post_customs_broker_canonical_insert
AFTER INSERT ON public.finance_expenses
FOR EACH ROW
WHEN (
  NEW.expense_category = 'import_broker'
  AND NEW.approval_status = 'approved'
)
EXECUTE FUNCTION public.post_customs_broker_canonical();

CREATE TRIGGER a_post_customs_broker_canonical_update
AFTER UPDATE ON public.finance_expenses
FOR EACH ROW
WHEN (
  NEW.expense_category = 'import_broker'
  AND NEW.approval_status = 'approved'
  AND (
    OLD.expense_category IS DISTINCT FROM NEW.expense_category
    OR OLD.approval_status IS DISTINCT FROM NEW.approval_status
    OR OLD.amount IS DISTINCT FROM NEW.amount
    OR OLD.expense_date IS DISTINCT FROM NEW.expense_date
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
    OR OLD.bank_account_id IS DISTINCT FROM NEW.bank_account_id
    OR OLD.broker_items IS DISTINCT FROM NEW.broker_items
    OR OLD.ppn_amount IS DISTINCT FROM NEW.ppn_amount
    OR OLD.pph_amount IS DISTINCT FROM NEW.pph_amount
    OR OLD.stamp_duty_amount IS DISTINCT FROM NEW.stamp_duty_amount
    OR OLD.supplier_id IS DISTINCT FROM NEW.supplier_id
  )
)
EXECUTE FUNCTION public.post_customs_broker_canonical();

NOTIFY pgrst, 'reload schema';

COMMIT;
