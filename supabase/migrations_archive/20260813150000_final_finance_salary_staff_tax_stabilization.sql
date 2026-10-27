-- Final finance QA stabilization: preserve settled salaries and make the
-- Staff Master COA relationship canonical.  No new accounting subsystem.
BEGIN;

ALTER TABLE public.finance_staff_master
  ADD COLUMN IF NOT EXISTS default_gl_account_id uuid
  REFERENCES public.chart_of_accounts(id) ON DELETE RESTRICT;

-- Backfill only equivalent legacy mappings; never replace a legitimate
-- custom legacy mapping.  Unmapped active staff use the existing salary COA.
UPDATE public.finance_staff_master staff
   SET default_gl_account_id = coa.id
  FROM public.chart_of_accounts coa
 WHERE staff.default_gl_account_id IS NULL
   AND coa.code = COALESCE(NULLIF(staff.default_gl_code, ''), '6100')
   AND coa.is_active AND NOT coa.is_header;

UPDATE public.finance_staff_master staff
   SET default_gl_account_id = coa.id
  FROM public.chart_of_accounts coa
 WHERE staff.default_gl_account_id IS NULL
   AND staff.status = 'active'
   AND coa.code = '6100'
   AND coa.is_active AND NOT coa.is_header;

CREATE OR REPLACE FUNCTION public.finance_staff_master_sync_salary_gl()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_coa public.chart_of_accounts%rowtype;
BEGIN
  IF NEW.default_gl_account_id IS NULL THEN
    SELECT * INTO v_coa FROM public.chart_of_accounts
     WHERE code = '6100' AND is_active AND NOT is_header LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Canonical salary COA 6100 is missing or inactive'; END IF;
    NEW.default_gl_account_id := v_coa.id;
  ELSE
    SELECT * INTO v_coa FROM public.chart_of_accounts WHERE id = NEW.default_gl_account_id;
    IF NOT FOUND OR NOT v_coa.is_active OR v_coa.is_header OR lower(v_coa.account_type) <> 'expense' THEN
      RAISE EXCEPTION 'Staff salary GL must reference an active posting expense Chart of Account';
    END IF;
  END IF;
  NEW.default_gl_code := v_coa.code;
  NEW.default_gl_name := v_coa.name;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_finance_staff_master_sync_salary_gl ON public.finance_staff_master;
CREATE TRIGGER trg_finance_staff_master_sync_salary_gl
  BEFORE INSERT OR UPDATE OF default_gl_account_id, default_gl_code, default_gl_name
  ON public.finance_staff_master FOR EACH ROW
  EXECUTE FUNCTION public.finance_staff_master_sync_salary_gl();

-- Apply the invariant to all active rows now that the canonical FK exists.
UPDATE public.finance_staff_master SET default_gl_account_id = default_gl_account_id
 WHERE status = 'active';

-- A settled advance is an accounting relationship.  Metadata remains editable,
-- but changing economic identity requires a deliberate reversal/correction.
CREATE OR REPLACE FUNCTION public.prevent_unsafe_settled_salary_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.expense_category = 'salary'
     AND EXISTS (SELECT 1 FROM public.salary_advance_applications sa WHERE sa.salary_expense_id = OLD.id)
     AND (OLD.amount, OLD.staff_id, OLD.pph_amount, OLD.payment_method, OLD.bank_account_id)
         IS DISTINCT FROM (NEW.amount, NEW.staff_id, NEW.pph_amount, NEW.payment_method, NEW.bank_account_id) THEN
    RAISE EXCEPTION
      'Salary % has applied advances. Reverse or correct its settlement before changing gross, staff, withholding, payment method, or bank account.', OLD.voucher_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_prevent_unsafe_settled_salary_edit ON public.finance_expenses;
CREATE TRIGGER trg_prevent_unsafe_settled_salary_edit
  BEFORE UPDATE ON public.finance_expenses FOR EACH ROW
  EXECUTE FUNCTION public.prevent_unsafe_settled_salary_edit();

COMMENT ON COLUMN public.finance_staff_master.default_gl_account_id IS
  'Canonical active posting expense COA for staff salary; legacy code/name are derived display fields.';

NOTIFY pgrst, 'reload schema';
COMMIT;
