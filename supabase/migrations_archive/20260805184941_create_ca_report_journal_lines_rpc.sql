/*
# Create CA Report Journal Lines RPC

## Purpose
The CA Reports page fetches all journal_entries for a date range, then queries
journal_entry_lines with `.in('journal_entry_id', entryIds)`. When there are 500+
journal entries, the resulting URL exceeds HTTP GET length limits (~8KB) and
Supabase/PostgREST returns 400 Bad Request.

This RPC moves the heavy join server-side: it accepts a date range (and optional
account_id filter) and returns the joined journal_entry + journal_entry_lines data
in a single POST request with no URL length concerns.

## New Functions
- `ca_report_journal_lines(p_date_from date, p_date_to date, p_account_ids uuid[])`
  Returns: journal_entry_id, entry_date, entry_number, source_module, reference_number,
           entry_description, line_account_id, line_number, debit, credit, line_description

## Security
- SECURITY INVOKER (runs as calling user, respects RLS)
- EXECUTE granted to authenticated only
*/

CREATE OR REPLACE FUNCTION public.ca_report_journal_lines(
  p_date_from date,
  p_date_to date,
  p_account_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  journal_entry_id uuid,
  entry_date date,
  entry_number text,
  source_module text,
  reference_number text,
  entry_description text,
  line_account_id uuid,
  line_number integer,
  debit numeric,
  credit numeric,
  line_description text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    je.id            AS journal_entry_id,
    je.entry_date,
    je.entry_number,
    je.source_module,
    je.reference_number,
    je.description   AS entry_description,
    jel.account_id   AS line_account_id,
    jel.line_number,
    jel.debit,
    jel.credit,
    jel.description  AS line_description
  FROM journal_entries je
  JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
  WHERE je.is_posted = true
    AND (je.is_reversed = false OR je.is_reversed IS NULL)
    AND je.entry_date >= p_date_from
    AND je.entry_date <= p_date_to
    AND (p_account_ids IS NULL OR jel.account_id = ANY(p_account_ids))
  ORDER BY je.entry_date, je.entry_number, jel.line_number;
$$;

REVOKE ALL ON FUNCTION public.ca_report_journal_lines(date, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_report_journal_lines(date, date, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_report_journal_lines(date, date, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
