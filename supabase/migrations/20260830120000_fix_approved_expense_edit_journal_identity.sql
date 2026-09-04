/*
 * Keep approved-expense post-update validation compatible with legacy
 * journals whose canonical identity is carried by reference_number while
 * reference_id is NULL. This migration changes only the RPC definition.
 */

BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_old_identity_check text := $old$
     WHERE id=v_journal_id AND reference_number='EXP-'||p_expense_id::text
       AND is_posted AND NOT COALESCE(is_reversed,false)
$old$;
  v_new_identity_check text := $new$
     WHERE id=v_journal_id
       AND source_module IN('expense','expenses')
       AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
       AND is_posted AND NOT COALESCE(is_reversed,false)
$new$;
  v_old_count_check text := $old$
       WHERE source_module IN('expense','expenses') AND reference_id=p_expense_id
         AND is_posted AND NOT COALESCE(is_reversed,false))<>1 THEN
$old$;
  v_new_count_check text := $new$
       WHERE source_module IN('expense','expenses')
         AND (reference_id=p_expense_id OR reference_number='EXP-'||p_expense_id::text)
         AND is_posted AND NOT COALESCE(is_reversed,false))<>1 THEN
$new$;
BEGIN
  SELECT pg_get_functiondef(
    'public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)'::regprocedure
  ) INTO v_definition;

  IF position(v_old_identity_check IN v_definition)>0 THEN
    v_definition:=replace(v_definition,v_old_identity_check,v_new_identity_check);
  ELSIF position(v_new_identity_check IN v_definition)=0 THEN
    RAISE EXCEPTION 'Unexpected approved-expense journal identity validation definition';
  END IF;

  IF position(v_old_count_check IN v_definition)>0 THEN
    v_definition:=replace(v_definition,v_old_count_check,v_new_count_check);
  ELSIF position(v_new_count_check IN v_definition)=0 THEN
    RAISE EXCEPTION 'Unexpected approved-expense active-journal count definition';
  END IF;

  EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.edit_approved_finance_expense_atomic(uuid,jsonb,uuid,numeric)
  TO authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
