-- Trigger-only SECURITY DEFINER helpers must never be callable by anon.
BEGIN;

REVOKE ALL ON FUNCTION public.validate_expense_category_master() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_expense_category_assignment() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
