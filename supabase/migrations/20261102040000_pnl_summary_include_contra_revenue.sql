-- ==============================================================================
-- MIGRATION: 20261102040000_pnl_summary_include_contra_revenue.sql
-- Description: Harmonize get_pnl_summary to deduct contra revenue (GL 4300 Sales Returns, GL 4200 Sales Discounts)
--              so net revenue and net income reconcile 100% with the posted Trial Balance.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_pnl_summary(p_start_date date, p_end_date date, p_usd_rate numeric)
 RETURNS TABLE(total_revenue numeric, total_expenses numeric, net_income numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    COALESCE(SUM(CASE 
      WHEN coa.account_type = 'revenue' OR (coa.account_type = 'contra' AND (coa.account_group = 'Revenue' OR coa.code LIKE '4%'))
      THEN (jel.credit - jel.debit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
      ELSE 0 END), 0)::numeric AS total_revenue,
    COALESCE(SUM(CASE 
      WHEN coa.account_type = 'expense'
      THEN (jel.debit - jel.credit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
      ELSE 0 END), 0)::numeric AS total_expenses,
    (
      COALESCE(SUM(CASE 
        WHEN coa.account_type = 'revenue' OR (coa.account_type = 'contra' AND (coa.account_group = 'Revenue' OR coa.code LIKE '4%'))
        THEN (jel.credit - jel.debit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
        ELSE 0 END), 0)
      - COALESCE(SUM(CASE 
        WHEN coa.account_type = 'expense'
        THEN (jel.debit - jel.credit) * public.get_journal_reporting_multiplier(je.id, p_usd_rate)
        ELSE 0 END), 0)
    )::numeric AS net_income
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  JOIN public.chart_of_accounts coa ON coa.id = jel.account_id
  WHERE je.is_posted = true
    AND NOT COALESCE(je.is_reversed, false)
    AND je.entry_date BETWEEN p_start_date AND p_end_date;
$function$;

CREATE OR REPLACE FUNCTION public.get_pnl_summary(p_start_date date, p_end_date date)
 RETURNS TABLE(total_revenue numeric, total_expenses numeric, net_income numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT * FROM public.get_pnl_summary(p_start_date, p_end_date, public.get_reporting_usd_rate());
$function$;

-- Record migration in schema_migrations
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261102040000', 'pnl_summary_include_contra_revenue')
ON CONFLICT (version) DO NOTHING;

