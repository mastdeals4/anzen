-- Trial balance must aggregate the same effective, posted, non-reversed
-- journal population used by the General Ledger and financial reports.
-- This is a read-path correction only; no journal or line is changed.
BEGIN;

CREATE OR REPLACE VIEW public.trial_balance_view AS
WITH active_balances AS (
  SELECT l.account_id,
         COALESCE(sum(l.debit), 0) AS total_debit,
         COALESCE(sum(l.credit), 0) AS total_credit
    FROM public.journal_entry_lines l
    JOIN public.journal_entries j
      ON j.id = l.journal_entry_id
     AND j.is_posted = true
     AND NOT COALESCE(j.is_reversed, false)
   GROUP BY l.account_id
)
SELECT coa.code,
       coa.name,
       coa.name_id,
       coa.account_type,
       coa.account_group,
       coa.normal_balance,
       COALESCE(b.total_debit, 0) AS total_debit,
       COALESCE(b.total_credit, 0) AS total_credit,
       COALESCE(b.total_debit, 0) - COALESCE(b.total_credit, 0) AS balance
  FROM public.chart_of_accounts coa
  LEFT JOIN active_balances b ON b.account_id = coa.id
 WHERE coa.is_header = false
   AND coa.is_active = true
 ORDER BY coa.code;

ALTER VIEW public.trial_balance_view SET (security_invoker = true);
COMMENT ON VIEW public.trial_balance_view IS
  'Canonical trial balance over posted, non-reversed journal entries only.';
GRANT SELECT ON public.trial_balance_view TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
