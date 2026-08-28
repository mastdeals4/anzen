-- Finance V1.1.1: keep Customs Broker journal identity stable while bank
-- reconciliation updates payment-state metadata.
--
-- The canonical broker trigger is the final and authoritative posting engine.
-- Two older compatibility triggers still rebuilt an intermediate journal on
-- every finance_expenses UPDATE, and the canonical trigger then rebuilt it a
-- third time.  Linking/unlinking a bank line recalculates paid_amount, so that
-- metadata-only update deleted the journal that link_bank_statement_line()
-- had just validated and stored.
--
-- Retain the legacy functions for migration/history compatibility, but remove
-- their redundant trigger bindings.  Scope the canonical trigger to approved
-- documents and accounting-relevant source changes.  No accounting formula,
-- journal line, reconciliation validation, or historical row is changed.

BEGIN;

DROP TRIGGER IF EXISTS zzz_post_customs_broker_accounting
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzzz_correct_customs_broker_reimbursement_totals
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical
  ON public.finance_expenses;

DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_insert
  ON public.finance_expenses;
DROP TRIGGER IF EXISTS zzzzz_post_customs_broker_canonical_update
  ON public.finance_expenses;

CREATE TRIGGER zzzzz_post_customs_broker_canonical_insert
AFTER INSERT ON public.finance_expenses
FOR EACH ROW
WHEN (
  NEW.expense_category = 'import_broker'
  AND NEW.approval_status = 'approved'
)
EXECUTE FUNCTION public.post_customs_broker_canonical();

CREATE TRIGGER zzzzz_post_customs_broker_canonical_update
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
