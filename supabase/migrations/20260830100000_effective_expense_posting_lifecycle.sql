/*
 * Canonical, read-only expense posting lifecycle.
 *
 * This migration intentionally changes no finance_expenses, journals, journal
 * lines, bank data or accounting values.  It resolves the effective posting
 * from preserved journal/reversal/repair evidence so every consumer uses the
 * same lifecycle truth.
 */

-- Repair metadata is intentionally restricted to accounting/audit roles. This
-- narrow helper exposes only the two UUIDs required for lifecycle resolution,
-- never repair notes, before/after values or accounting amounts.
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
  WHERE i.document_type IN ('expense', 'salary_advance_expense')
    AND COALESCE(i.new_metadata ->> 'replacement_journal_id', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
$$;

REVOKE ALL ON FUNCTION public.expense_explicit_replacement_journals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expense_explicit_replacement_journals() TO authenticated, service_role;

CREATE OR REPLACE VIEW public.effective_expense_posting_state
WITH (security_invoker = true)
AS
WITH original_journals AS (
  SELECT
    fe.id AS expense_id,
    je.id,
    je.entry_number,
    je.entry_date,
    je.created_at,
    je.is_reversed,
    je.reversed_by_id
  FROM public.finance_expenses fe
  JOIN public.journal_entries je
    ON je.is_posted = true
   AND je.source_module IN ('expense', 'expenses')
   AND (
     je.reference_id = fe.id
     OR (je.reference_id IS NULL AND je.reference_number = 'EXP-' || fe.id::text)
   )
),
explicit_replacement_ids AS (
  SELECT expense_id, journal_id
  FROM public.expense_explicit_replacement_journals()
),
replacement_candidates AS (
  SELECT eri.expense_id, je.id, je.entry_number, je.entry_date,
         je.reference_number, je.source_module, je.created_at
  FROM explicit_replacement_ids eri
  JOIN public.journal_entries je ON je.id = eri.journal_id
  WHERE je.is_posted = true AND NOT COALESCE(je.is_reversed, false)

  UNION

  SELECT fe.id, je.id, je.entry_number, je.entry_date,
         je.reference_number, je.source_module, je.created_at
  FROM public.finance_expenses fe
  JOIN public.journal_entries je
    ON je.reference_id = fe.id
   AND je.is_posted = true
   AND NOT COALESCE(je.is_reversed, false)
   AND (
     je.source_module = 'historical_salary_advance_repair'
     OR (je.source_module = 'historical_repair' AND je.reference_number LIKE 'HR-AP-%')
   )
),
original_rollup AS (
  SELECT
    expense_id,
    count(*) FILTER (WHERE NOT COALESCE(is_reversed, false))::integer AS active_original_count,
    count(*) FILTER (WHERE COALESCE(is_reversed, false))::integer AS reversed_original_count,
    (array_agg(id ORDER BY created_at DESC, id DESC)
      FILTER (WHERE NOT COALESCE(is_reversed, false)))[1] AS active_journal_id,
    (array_agg(entry_number ORDER BY created_at DESC, id DESC)
      FILTER (WHERE NOT COALESCE(is_reversed, false)))[1] AS active_journal_number,
    (array_agg(entry_date ORDER BY created_at DESC, id DESC)
      FILTER (WHERE NOT COALESCE(is_reversed, false)))[1] AS active_journal_date,
    (array_agg(id ORDER BY created_at DESC, id DESC)
      FILTER (WHERE COALESCE(is_reversed, false)))[1] AS original_journal_id,
    (array_agg(entry_number ORDER BY created_at DESC, id DESC)
      FILTER (WHERE COALESCE(is_reversed, false)))[1] AS original_journal_number,
    (array_agg(reversed_by_id ORDER BY created_at DESC, id DESC)
      FILTER (WHERE COALESCE(is_reversed, false) AND reversed_by_id IS NOT NULL))[1] AS reversal_journal_id
  FROM original_journals
  GROUP BY expense_id
),
replacement_rollup AS (
  SELECT
    expense_id,
    count(*)::integer AS active_replacement_count,
    (array_agg(id ORDER BY created_at DESC, id DESC))[1] AS replacement_journal_id,
    (array_agg(entry_number ORDER BY created_at DESC, id DESC))[1] AS replacement_journal_number,
    (array_agg(entry_date ORDER BY created_at DESC, id DESC))[1] AS replacement_journal_date,
    (array_agg(reference_number ORDER BY created_at DESC, id DESC))[1] AS replacement_reference,
    (array_agg(source_module ORDER BY created_at DESC, id DESC))[1] AS replacement_source_module
  FROM replacement_candidates
  GROUP BY expense_id
),
resolved AS (
  SELECT
    fe.id AS expense_id,
    fe.voucher_number,
    fe.approval_status AS document_approval_status,
    COALESCE(o.active_original_count, 0) AS active_original_count,
    COALESCE(o.reversed_original_count, 0) AS reversed_original_count,
    COALESCE(r.active_replacement_count, 0) AS active_replacement_count,
    o.active_journal_id,
    o.active_journal_number,
    o.active_journal_date,
    o.original_journal_id,
    o.original_journal_number,
    o.reversal_journal_id,
    r.replacement_journal_id,
    r.replacement_journal_number,
    r.replacement_journal_date,
    r.replacement_reference,
    r.replacement_source_module
  FROM public.finance_expenses fe
  LEFT JOIN original_rollup o ON o.expense_id = fe.id
  LEFT JOIN replacement_rollup r ON r.expense_id = fe.id
)
SELECT
  x.*,
  CASE
    WHEN active_original_count > 1 THEN 'AMBIGUOUS'
    WHEN active_replacement_count > 1 THEN 'AMBIGUOUS'
    WHEN active_original_count > 0 AND active_replacement_count > 0 THEN 'AMBIGUOUS'
    WHEN document_approval_status <> 'approved'
      AND (active_original_count > 0 OR active_replacement_count > 0) THEN 'AMBIGUOUS'
    WHEN active_original_count = 1 THEN 'ACTIVE'
    WHEN reversed_original_count > 0 AND active_replacement_count = 1 THEN 'REPLACED'
    WHEN reversed_original_count > 0 AND active_replacement_count = 0 THEN 'REVERSED'
    WHEN document_approval_status = 'rejected' THEN 'REJECTED'
    WHEN document_approval_status = 'pending_approval' THEN 'PENDING'
    ELSE 'AMBIGUOUS'
  END::text AS effective_posting_state,
  COALESCE(active_journal_id, replacement_journal_id) AS effective_journal_id,
  COALESCE(active_journal_number, replacement_journal_number) AS effective_journal_number,
  COALESCE(active_journal_date, replacement_journal_date) AS effective_journal_date,
  CASE
    WHEN active_original_count > 1 THEN 'multiple_active_original_journals'
    WHEN active_replacement_count > 1 THEN 'multiple_active_replacement_journals'
    WHEN active_original_count > 0 AND active_replacement_count > 0 THEN 'active_original_and_replacement_coexist'
    WHEN document_approval_status = 'approved'
      AND active_original_count = 0 AND reversed_original_count = 0
      AND active_replacement_count = 0 THEN 'approved_without_posted_journal_evidence'
    WHEN document_approval_status = 'rejected'
      AND (active_original_count > 0 OR active_replacement_count > 0) THEN 'rejected_with_active_accounting_path'
    ELSE NULL
  END::text AS ambiguity_reason
FROM resolved x;

COMMENT ON VIEW public.effective_expense_posting_state IS
  'Canonical read-only expense lifecycle. ACTIVE uses the original journal; REPLACED uses an explicit/known full repair journal; REVERSED has no effective journal.';

CREATE OR REPLACE VIEW public.expense_posting_lifecycle_audit
WITH (security_invoker = true)
AS
SELECT *
FROM public.effective_expense_posting_state
WHERE document_approval_status = 'approved'
  AND effective_posting_state <> 'ACTIVE';

COMMENT ON VIEW public.expense_posting_lifecycle_audit IS
  'Read-only audit population of approved expense documents whose effective posting is reversed, replaced or ambiguous.';

CREATE OR REPLACE FUNCTION public.resolve_effective_expense_posting_state(p_expense_id uuid)
RETURNS SETOF public.effective_expense_posting_state
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT s.*
  FROM public.effective_expense_posting_state s
  WHERE s.expense_id = p_expense_id;
$$;

REVOKE ALL ON TABLE public.effective_expense_posting_state FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.expense_posting_lifecycle_audit FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.effective_expense_posting_state TO authenticated, service_role;
GRANT SELECT ON TABLE public.expense_posting_lifecycle_audit TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_effective_expense_posting_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_effective_expense_posting_state(uuid) TO authenticated, service_role;

-- Payment Voucher must not offer an approved-but-reversed document as an
-- outstanding payable.  Preserve the established payable calculation and
-- output signature; only add the canonical effective-state predicate.
CREATE OR REPLACE FUNCTION public.get_outstanding_expense_bills(
  p_as_of_date date DEFAULT current_date
)
RETURNS TABLE(
  id uuid, supplier_id uuid, supplier_name text, staff_id uuid, staff_name text,
  invoice_number text, invoice_date date, due_date date, expense_category text,
  description text, amount numeric, paid_amount numeric, balance_amount numeric,
  days_overdue integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT fe.id, fe.supplier_id, s.company_name::text, fe.staff_id,
    sm.full_name::text, fe.invoice_number::text, fe.expense_date, fe.due_date,
    fe.expense_category::text, fe.description::text,
    public.calculate_finance_expense_payable(fe.id), COALESCE(fe.paid_amount,0),
    public.calculate_finance_expense_payable(fe.id)-COALESCE(fe.paid_amount,0),
    CASE WHEN fe.due_date IS NOT NULL AND fe.due_date < p_as_of_date
      THEN (p_as_of_date-fe.due_date)::integer ELSE 0 END
  FROM public.finance_expenses fe
  JOIN public.effective_expense_posting_state eps ON eps.expense_id=fe.id
  LEFT JOIN public.suppliers s ON s.id=fe.supplier_id
  LEFT JOIN public.finance_staff_master sm ON sm.id=fe.staff_id
  WHERE fe.expense_date <= p_as_of_date
    AND eps.effective_posting_state IN ('ACTIVE','REPLACED')
    AND public.calculate_finance_expense_payable(fe.id)>COALESCE(fe.paid_amount,0)
  ORDER BY COALESCE(fe.due_date,fe.expense_date);
END;
$$;

REVOKE ALL ON FUNCTION public.get_outstanding_expense_bills(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_outstanding_expense_bills(date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
