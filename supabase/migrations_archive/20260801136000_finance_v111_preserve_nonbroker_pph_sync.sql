-- Finance V1.1.1 follow-up: retain the certified PPh synchronization cadence
-- for every non-broker Expense (including Salary), while excluding only
-- payment-state-only Customs Broker updates from journal mutation.

BEGIN;

DROP TRIGGER IF EXISTS zzz_sync_expense_pph_account
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzz_sync_expense_pph_account_insert
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzz_sync_expense_pph_account_update
  ON public.finance_expenses;

CREATE TRIGGER zzz_sync_expense_pph_account_insert
AFTER INSERT ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_expense_pph_account();

CREATE TRIGGER zzz_sync_expense_pph_account_update
AFTER UPDATE ON public.finance_expenses
FOR EACH ROW
WHEN (
  NEW.expense_category <> 'import_broker'
  OR OLD.expense_category IS DISTINCT FROM NEW.expense_category
  OR OLD.approval_status IS DISTINCT FROM NEW.approval_status
  OR OLD.amount IS DISTINCT FROM NEW.amount
  OR OLD.expense_date IS DISTINCT FROM NEW.expense_date
  OR OLD.description IS DISTINCT FROM NEW.description
  OR OLD.payment_method IS DISTINCT FROM NEW.payment_method
  OR OLD.bank_account_id IS DISTINCT FROM NEW.bank_account_id
  OR OLD.broker_items IS DISTINCT FROM NEW.broker_items
  OR OLD.ppn_amount IS DISTINCT FROM NEW.ppn_amount
  OR OLD.pph_amount IS DISTINCT FROM NEW.pph_amount
  OR OLD.pph_code_id IS DISTINCT FROM NEW.pph_code_id
  OR OLD.stamp_duty_amount IS DISTINCT FROM NEW.stamp_duty_amount
  OR OLD.supplier_id IS DISTINCT FROM NEW.supplier_id
)
EXECUTE FUNCTION public.trg_sync_expense_pph_account();

NOTIFY pgrst, 'reload schema';

COMMIT;
