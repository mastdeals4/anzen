-- Grant SELECT on remaining finance historical repair and bank allocation tables to anon, authenticated, service_role
BEGIN;

GRANT SELECT ON public.bank_statement_allocations TO anon, authenticated, service_role;
GRANT SELECT ON public.finance_historical_repair_items TO anon, authenticated, service_role;
GRANT SELECT ON public.finance_historical_repair_runs TO anon, authenticated, service_role;
GRANT SELECT ON public.finance_historical_repair_commands TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
