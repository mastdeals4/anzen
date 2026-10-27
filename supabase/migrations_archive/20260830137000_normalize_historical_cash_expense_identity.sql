-- A historical cash restatement (HR-CASH) is the current accounting path when
-- it replaces one reversed expense journal. It is not a cancelled business
-- document. Promote that deterministic effective journal to the ordinary
-- expense identity so every consumer resolves the same transaction.
--
-- No journal line, amount, date, bank-statement amount, or allocation amount
-- changes. Reversed originals remain immutable audit evidence.
BEGIN;

CREATE OR REPLACE FUNCTION public.expense_explicit_replacement_journals()
RETURNS TABLE (expense_id uuid, journal_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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
     AND je.source_module NOT IN ('expense', 'expenses')

  UNION

  SELECT fe.id, cash_restatement.id
    FROM public.finance_expenses fe
    JOIN public.journal_entries cash_restatement
      ON cash_restatement.reference_id = fe.id
     AND cash_restatement.source_module = 'historical_repair'
     AND cash_restatement.reference_number LIKE 'HR-CASH-%'
     AND cash_restatement.is_posted = true
     AND NOT COALESCE(cash_restatement.is_reversed, false)
   WHERE EXISTS (
     SELECT 1
       FROM public.journal_entries original
      WHERE original.source_module IN ('expense', 'expenses')
        AND original.is_posted = true
        AND COALESCE(original.is_reversed, false)
        AND (original.reference_id = fe.id
          OR (original.reference_id IS NULL
            AND original.reference_number = 'EXP-' || fe.id::text))
   );
$$;

CREATE TEMP TABLE canonical_cash_expense_paths ON COMMIT DROP AS
SELECT s.expense_id,
       s.original_journal_id,
       s.replacement_journal_id AS effective_journal_id
  FROM public.effective_expense_posting_state s
 WHERE s.effective_posting_state = 'REPLACED'
   AND s.active_original_count = 0
   AND s.reversed_original_count = 1
   AND s.active_replacement_count = 1
   AND s.replacement_source_module = 'historical_repair'
   AND s.replacement_reference LIKE 'HR-CASH-%';

DO $$
DECLARE
  v_unresolved integer;
  v_safe integer;
BEGIN
  SELECT count(*) INTO v_unresolved
    FROM public.effective_expense_posting_state s
    JOIN public.journal_entries j
      ON j.reference_id = s.expense_id
     AND j.source_module = 'historical_repair'
     AND j.reference_number LIKE 'HR-CASH-%'
     AND j.is_posted AND NOT COALESCE(j.is_reversed, false)
   WHERE s.effective_posting_state = 'REPLACED';
  SELECT count(*) INTO v_safe FROM canonical_cash_expense_paths;
  IF v_unresolved <> v_safe THEN
    RAISE EXCEPTION 'Historical cash expense normalization is ambiguous (% safe of % candidates)',
      v_safe, v_unresolved;
  END IF;
END $$;

CREATE TEMP TABLE canonical_cash_expense_line_totals ON COMMIT DROP AS
SELECT p.effective_journal_id,
       l.account_id,
       sum(l.debit) AS debit,
       sum(l.credit) AS credit
  FROM canonical_cash_expense_paths p
  JOIN public.journal_entry_lines l ON l.journal_entry_id = p.effective_journal_id
 GROUP BY p.effective_journal_id, l.account_id;

UPDATE public.journal_entries original
   SET source_module = 'expense_history'
  FROM canonical_cash_expense_paths p
 WHERE original.id = p.original_journal_id
   AND original.is_reversed = true;

UPDATE public.journal_entries current_journal
   SET source_module = 'expenses',
       reference_id = p.expense_id,
       reference_number = 'EXP-' || p.expense_id::text
  FROM canonical_cash_expense_paths p
 WHERE current_journal.id = p.effective_journal_id
   AND current_journal.is_posted = true
   AND NOT COALESCE(current_journal.is_reversed, false);

INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values)
SELECT 'journal_entries',
       p.effective_journal_id,
       'update',
       jsonb_build_object('business_state', 'historical_cash_restatement',
                          'original_journal_id', p.original_journal_id),
       jsonb_build_object('business_state', 'current',
                          'source_module', 'expenses',
                          'reference_id', p.expense_id,
                          'bank_allocation_preserved', true)
  FROM canonical_cash_expense_paths p;

DO $$
DECLARE
  v_expected integer;
  v_active integer;
BEGIN
  SELECT count(*) INTO v_expected FROM canonical_cash_expense_paths;
  SELECT count(*) INTO v_active
    FROM public.effective_expense_posting_state s
    JOIN canonical_cash_expense_paths p ON p.expense_id = s.expense_id
   WHERE s.effective_posting_state = 'ACTIVE'
     AND s.effective_journal_id = p.effective_journal_id;
  IF v_active <> v_expected THEN
    RAISE EXCEPTION 'Historical cash expense normalization failed (% active of %)', v_active, v_expected;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM canonical_cash_expense_line_totals before_lines
      JOIN public.journal_entry_lines after_lines
        ON after_lines.journal_entry_id = before_lines.effective_journal_id
       AND after_lines.account_id = before_lines.account_id
     GROUP BY before_lines.effective_journal_id, before_lines.account_id,
              before_lines.debit, before_lines.credit
    HAVING sum(after_lines.debit) <> before_lines.debit
        OR sum(after_lines.credit) <> before_lines.credit
  ) THEN
    RAISE EXCEPTION 'Historical cash expense normalization changed accounting lines';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.expense_explicit_replacement_journals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_explicit_replacement_journals() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
