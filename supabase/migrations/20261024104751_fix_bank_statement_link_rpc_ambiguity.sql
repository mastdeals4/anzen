-- Hotfix: remove the legacy 4-argument wrapper that makes PostgREST RPC resolution
-- ambiguous with the 5-argument overload whose final two parameters have defaults.
-- The 5-argument function remains callable with 4 named RPC parameters because its
-- p_allocation_amount parameter has a default.
DROP FUNCTION IF EXISTS public.link_bank_statement_line(uuid, text, uuid, text);

-- Force PostgREST to refresh its RPC signature cache after the overload is removed.
NOTIFY pgrst, 'reload schema';
