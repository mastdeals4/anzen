-- Make the configurable Expense Category Master authoritative for expense
-- posting. Category keys must never be duplicated in a finance_expenses CHECK
-- allow-list: administrators may add a valid posting leaf without a migration.

BEGIN;

-- Safety: every existing non-legacy expense key must already exist in the
-- master before the stale allow-list is removed. Historical Utilities rows are
-- intentionally preserved by the compatibility rule below.
DO $$
DECLARE
  v_invalid text;
BEGIN
  SELECT string_agg(DISTINCT fe.expense_category, ', ' ORDER BY fe.expense_category)
    INTO v_invalid
    FROM public.finance_expenses fe
    LEFT JOIN public.expense_categories ec
      ON ec.category_key = fe.expense_category
   WHERE fe.expense_category <> 'utilities'
     AND (
       ec.id IS NULL
       OR NOT ec.is_active
       OR NOT ec.is_posting_category
       OR ec.coa_account_id IS NULL
       OR public.get_expense_account_id(fe.expense_category) IS NULL
     );

  IF v_invalid IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enable master-driven expense categories; existing expense keys are invalid: %',
      v_invalid;
  END IF;
END;
$$;

ALTER TABLE public.finance_expenses
  DROP CONSTRAINT IF EXISTS finance_expenses_expense_category_check;

COMMENT ON COLUMN public.finance_expenses.expense_category IS
  'Canonical category_key from expense_categories. Validated as an active posting leaf with an active non-header COA; no hard-coded category allow-list.';

-- Report a useful master-data error for every new or changed assignment.
-- Existing historical Utilities rows remain editable only while their category
-- is unchanged, as established by the prior compatibility migration.
CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category public.expense_categories%ROWTYPE;
  v_coa public.chart_of_accounts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.expense_category = 'utilities'
     AND NEW.expense_category = 'utilities' THEN
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(NEW.expense_category), '') IS NULL THEN
    RAISE EXCEPTION 'Expense category is required.' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_category
    FROM public.expense_categories
   WHERE category_key = NEW.expense_category;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category "%" does not exist in Expense Category Master.',
      NEW.expense_category USING ERRCODE = '23514';
  END IF;
  IF NOT v_category.is_active THEN
    RAISE EXCEPTION 'Expense category "%" is inactive.', v_category.name
      USING ERRCODE = '23514';
  END IF;
  IF NOT v_category.is_posting_category THEN
    RAISE EXCEPTION 'Expense category "%" is a grouping category. Select an active posting leaf.',
      v_category.name USING ERRCODE = '23514';
  END IF;
  IF v_category.coa_account_id IS NULL THEN
    RAISE EXCEPTION 'Expense category "%" has no configured Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_coa
    FROM public.chart_of_accounts
   WHERE id = v_category.coa_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense category "%" references a missing Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;
  IF NOT v_coa.is_active OR v_coa.is_header THEN
    RAISE EXCEPTION 'Expense category "%" must use an active non-header Chart of Account.',
      v_category.name USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- expense_type is the legacy transaction context used by existing reports and
-- constraints (general/import/sales). category_type is broader configurable
-- master metadata. Derive the former from the latter instead of trusting UI
-- payloads or maintaining another category-key list.
CREATE OR REPLACE FUNCTION public.validate_expense_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_category_type text;
  v_requires_container boolean;
BEGIN
  SELECT category_type, requires_container
    INTO v_category_type, v_requires_container
    FROM public.expense_categories
   WHERE category_key = NEW.expense_category;

  NEW.expense_type := CASE v_category_type
    WHEN 'import' THEN 'import'
    WHEN 'sales' THEN 'sales'
    ELSE 'general'
  END;

  IF COALESCE(v_requires_container, false) AND NEW.import_container_id IS NULL THEN
    RAISE EXCEPTION 'Expense category "%" requires an Import Container.',
      NEW.expense_category USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Donations was created as an Operations posting leaf but without its existing
-- grouping parent. This is master-data hierarchy only; its key and COA remain
-- unchanged.
UPDATE public.expense_categories child
   SET parent_id = parent.id
  FROM public.expense_categories parent
 WHERE child.category_key = 'donations'
   AND child.category_type = 'operations'
   AND child.parent_id IS NULL
   AND parent.category_key = 'operations'
   AND parent.category_type = 'operations'
   AND parent.is_active
   AND NOT parent.is_posting_category;

REVOKE ALL ON FUNCTION public.validate_expense_category_assignment(),
  public.validate_expense_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_expense_category_assignment(),
  public.validate_expense_context() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
