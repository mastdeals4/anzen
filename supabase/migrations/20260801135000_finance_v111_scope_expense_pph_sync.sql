-- Finance V1.1.1: payment-state metadata must not rewrite posted PPh or bank
-- journal lines.  Keep the certified PPh account resolver unchanged and run
-- it only when source accounting fields can create/regenerate an Expense JE.

BEGIN;

DROP TRIGGER IF EXISTS zzz_sync_expense_pph_account
  ON public.finance_expenses;

CREATE TRIGGER zzz_sync_expense_pph_account
AFTER INSERT OR UPDATE OF
  approval_status,
  amount,
  expense_category,
  expense_date,
  description,
  payment_method,
  bank_account_id,
  supplier_id,
  fixed_asset_account_id,
  ppn_amount,
  pph_amount,
  pph_code_id,
  pib_bm_amount,
  pib_ppn_amount,
  pib_pph_amount,
  stamp_duty_amount,
  bank_charges_amount,
  broker_items
ON public.finance_expenses
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_expense_pph_account();

NOTIFY pgrst, 'reload schema';

COMMIT;
