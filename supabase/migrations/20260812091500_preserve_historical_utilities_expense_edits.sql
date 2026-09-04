/*
  Complete the expense-category contract repair.

  `utilities` is intentionally retained by the category CHECK for historical
  finance_expenses, while its master record is archived/non-posting. Permit an
  existing utilities expense to be saved unchanged; every new or changed
  category must continue to resolve through the active posting master.
*/
CREATE OR REPLACE FUNCTION public.validate_expense_category_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.expense_category = 'utilities'
     AND NEW.expense_category = 'utilities' THEN
    RETURN NEW;
  END IF;

  IF NEW.expense_category IS NOT NULL
     AND public.get_expense_account_id(NEW.expense_category) IS NULL THEN
    RAISE EXCEPTION 'This category has no configured Chart of Account.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
