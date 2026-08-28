-- Promote every deterministic effective expense journal to the normal expense
-- identity. Repair/reversal evidence remains in the audit tables and reversed
-- journal, but ordinary workflows no longer operate on a "replacement" state.
BEGIN;

CREATE TEMP TABLE expense_current_normalization ON COMMIT DROP AS
SELECT expense_id,
       voucher_number,
       original_journal_id,
       effective_journal_id
  FROM public.effective_expense_posting_state
 WHERE effective_posting_state = 'REPLACED'
   AND active_original_count = 0
   AND reversed_original_count = 1
   AND active_replacement_count = 1;

CREATE TEMP TABLE expense_current_line_totals ON COMMIT DROP AS
SELECT n.effective_journal_id,
       l.account_id,
       COALESCE(sum(l.debit), 0) AS debit,
       COALESCE(sum(l.credit), 0) AS credit
  FROM expense_current_normalization n
  JOIN public.journal_entry_lines l ON l.journal_entry_id = n.effective_journal_id
 GROUP BY n.effective_journal_id, l.account_id;

DO $$
DECLARE
  v_replaced integer;
  v_safe integer;
BEGIN
  SELECT count(*) INTO v_replaced
    FROM public.effective_expense_posting_state
   WHERE effective_posting_state = 'REPLACED';
  SELECT count(*) INTO v_safe FROM expense_current_normalization;
  IF v_replaced <> v_safe THEN
    RAISE EXCEPTION 'Not every replacement-path expense has one deterministic current journal (% of % safe)',
      v_safe, v_replaced;
  END IF;
END $$;

-- The reversed journal is retained as audit history but is no longer a normal
-- expense source. Its dates, entry number, amounts, lines and reversal link do
-- not change.
UPDATE public.journal_entries je
   SET source_module = 'expense_history'
  FROM expense_current_normalization n
 WHERE je.id = n.original_journal_id
   AND je.is_reversed = true;

-- The sole current journal receives the canonical business-document identity.
-- This lets normal edit/link/cancel functions reuse one implementation.
UPDATE public.journal_entries je
   SET source_module = 'expenses',
       reference_id = n.expense_id,
       reference_number = 'EXP-' || n.expense_id::text
  FROM expense_current_normalization n
 WHERE je.id = n.effective_journal_id
   AND je.is_posted = true
   AND NOT COALESCE(je.is_reversed, false);

-- Once a repaired journal has been normalized to the ordinary expense source,
-- the audit metadata still identifies its origin but it is no longer resolved
-- as a second, parallel replacement candidate.
CREATE OR REPLACE FUNCTION public.expense_explicit_replacement_journals()
RETURNS TABLE (expense_id uuid, journal_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT
    i.document_id,
    (i.new_metadata ->> 'replacement_journal_id')::uuid
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
    AND je.source_module NOT IN ('expense', 'expenses');
$$;

-- Canonical allocations follow the effective journal id. This runs after the
-- business identity is normalized because allocation-owner triggers refresh
-- the expense payment state and must see exactly one current expense journal.
-- The allocation row, statement line, source document, amount and economic
-- bank event are stable.
SELECT set_config('app.finance_historical_repair', 'on', true);
UPDATE public.bank_statement_allocations a
   SET journal_entry_id = n.effective_journal_id
  FROM expense_current_normalization n
  JOIN public.journal_entries old_journal ON old_journal.id = n.original_journal_id
 WHERE a.document_type = 'expense'
   AND a.document_id = n.expense_id
   AND a.journal_entry_id = n.original_journal_id
   AND old_journal.is_reversed = true;
SELECT set_config('app.finance_historical_repair', 'off', true);

INSERT INTO public.audit_logs(table_name, record_id, action_type, old_values, new_values)
SELECT 'journal_entries',
       n.effective_journal_id,
       'update',
       jsonb_build_object('business_state', 'replacement_path',
                          'original_journal_id', n.original_journal_id),
       jsonb_build_object('business_state', 'current',
                          'source_module', 'expenses',
                          'reference_id', n.expense_id)
  FROM expense_current_normalization n;

DO $$
DECLARE
  v_expected integer;
  v_active integer;
BEGIN
  SELECT count(*) INTO v_expected FROM expense_current_normalization;
  SELECT count(*) INTO v_active
    FROM public.effective_expense_posting_state s
    JOIN expense_current_normalization n ON n.expense_id = s.expense_id
   WHERE s.effective_posting_state = 'ACTIVE'
     AND s.effective_journal_id = n.effective_journal_id;
  IF v_active <> v_expected THEN
    RAISE EXCEPTION 'Expense current-identity normalization failed (% of % active)', v_active, v_expected;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.effective_expense_posting_state
     WHERE active_original_count > 1 OR active_replacement_count > 1
  ) THEN
    RAISE EXCEPTION 'Expense normalization created duplicate current journals';
  END IF;
  IF EXISTS (
    (SELECT effective_journal_id, account_id, debit, credit
       FROM expense_current_line_totals
     EXCEPT
     SELECT n.effective_journal_id, l.account_id,
            COALESCE(sum(l.debit), 0), COALESCE(sum(l.credit), 0)
       FROM expense_current_normalization n
       JOIN public.journal_entry_lines l ON l.journal_entry_id = n.effective_journal_id
      GROUP BY n.effective_journal_id, l.account_id)
    UNION ALL
    (SELECT n.effective_journal_id, l.account_id,
            COALESCE(sum(l.debit), 0), COALESCE(sum(l.credit), 0)
       FROM expense_current_normalization n
       JOIN public.journal_entry_lines l ON l.journal_entry_id = n.effective_journal_id
      GROUP BY n.effective_journal_id, l.account_id
     EXCEPT
     SELECT effective_journal_id, account_id, debit, credit
       FROM expense_current_line_totals)
  ) THEN
    RAISE EXCEPTION 'Expense normalization changed journal accounting lines';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.expense_explicit_replacement_journals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_explicit_replacement_journals() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
