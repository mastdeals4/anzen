-- Parents organise the Finance Category Master only; only leaf rows post.
BEGIN;

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS is_posting_category boolean NOT NULL DEFAULT true;

ALTER TABLE public.expense_categories
  ALTER COLUMN coa_account_id DROP NOT NULL;

-- Replace the original mandatory-COA validator before converting existing
-- grouping rows, otherwise its old rule rejects a parent with no COA.
CREATE OR REPLACE FUNCTION public.validate_expense_category_master()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account record;
BEGIN
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'An expense category cannot be its own parent';
  END IF;
  IF NOT NEW.is_posting_category THEN
    NEW.coa_account_id := NULL;
  ELSE
    SELECT is_active, is_header INTO v_account FROM public.chart_of_accounts WHERE id=NEW.coa_account_id;
    IF NOT FOUND OR NOT v_account.is_active OR v_account.is_header THEN
      RAISE EXCEPTION 'Each posting expense category must use an active posting Chart of Account';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Any row with children is a grouping row, not a selectable/posting category.
UPDATE public.expense_categories parent
SET is_posting_category=false,
    coa_account_id=NULL
WHERE EXISTS (
  SELECT 1 FROM public.expense_categories child WHERE child.parent_id=parent.id
);

CREATE OR REPLACE FUNCTION public.validate_expense_category_master()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account record;
BEGIN
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'An expense category cannot be its own parent';
  END IF;

  IF NOT NEW.is_posting_category THEN
    NEW.coa_account_id := NULL;
  ELSE
    SELECT is_active, is_header INTO v_account
    FROM public.chart_of_accounts WHERE id=NEW.coa_account_id;
    IF NOT FOUND OR NOT v_account.is_active OR v_account.is_header THEN
      RAISE EXCEPTION 'Each posting expense category must use an active posting Chart of Account';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_expense_category_parent_nonposting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    UPDATE public.expense_categories
    SET is_posting_category=false, coa_account_id=NULL
    WHERE id=NEW.parent_id AND is_posting_category;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_expense_category_parent_nonposting ON public.expense_categories;
CREATE TRIGGER trg_enforce_expense_category_parent_nonposting
AFTER INSERT OR UPDATE OF parent_id ON public.expense_categories
FOR EACH ROW EXECUTE FUNCTION public.enforce_expense_category_parent_nonposting();

CREATE OR REPLACE FUNCTION public.get_expense_account_id(p_category text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ec.coa_account_id
  FROM public.expense_categories ec
  JOIN public.chart_of_accounts coa ON coa.id=ec.coa_account_id
  WHERE ec.category_key=p_category
    AND ec.is_active
    AND ec.is_posting_category
    AND coa.is_active
    AND NOT coa.is_header
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.validate_expense_category_master() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_expense_category_parent_nonposting() FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.expense_categories.is_posting_category IS 'True only for leaf categories. Parent rows organise UI and reporting and cannot post.';
NOTIFY pgrst, 'reload schema';
COMMIT;
