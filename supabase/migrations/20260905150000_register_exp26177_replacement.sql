-- Register the already-posted replacement journal for EXP/26/177.
-- This records lifecycle provenance only; it does not alter journal or business amounts.
BEGIN;

CREATE OR REPLACE FUNCTION public.expense_explicit_replacement_journals()
RETURNS TABLE(expense_id uuid, journal_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT DISTINCT i.document_id, je.id
    FROM public.finance_historical_repair_items i
    JOIN public.journal_entries je
      ON je.id = CASE
        WHEN COALESCE(i.new_metadata ->> 'replacement_journal_id', '')
             ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (i.new_metadata ->> 'replacement_journal_id')::uuid
      END
   WHERE i.document_type IN ('expense', 'salary_advance_expense')
     AND COALESCE(i.new_metadata ->> 'replacement_journal_id', '')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND je.is_posted = true
     AND NOT COALESCE(je.is_reversed, false)
     AND je.source_module NOT IN ('expense', 'expenses');
$$;

REVOKE ALL ON FUNCTION public.expense_explicit_replacement_journals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_explicit_replacement_journals() TO authenticated, service_role;

-- Existing replacement: EXP/26/177 -> JE2609-0022.
-- Idempotent metadata registration; no journal, expense, payment, or allocation values are changed.
INSERT INTO public.finance_historical_repair_items
  (run_id, document_type, document_id, document_number, repaired_fields,
   old_metadata, new_metadata, repair_reason)
SELECT
  'f2617700-0000-4000-8000-000000000001'::uuid,
  'expense',
  fe.id,
  fe.voucher_number,
  ARRAY['replacement_journal_registration'],
  '{}'::jsonb,
  jsonb_build_object('replacement_journal_id', je.id),
  'Register existing replacement posting for effective expense lifecycle resolution'
FROM public.finance_expenses fe
JOIN public.journal_entries je
  ON je.entry_number = 'JE2609-0022'
 AND je.is_posted = true
 AND NOT COALESCE(je.is_reversed, false)
WHERE fe.voucher_number = 'EXP/26/177'
  AND NOT EXISTS (
    SELECT 1
      FROM public.finance_historical_repair_items i
     WHERE i.document_type = 'expense'
       AND i.document_id = fe.id
       AND i.new_metadata ->> 'replacement_journal_id' = je.id::text
  );

COMMIT;
