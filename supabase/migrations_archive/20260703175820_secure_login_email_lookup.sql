-- Security fix: stop exposing the entire user_profiles table to the anon role.
-- The pre-auth username->email lookup is replaced by a scoped SECURITY DEFINER RPC
-- that returns ONLY the single matching row's email + is_active flag.

CREATE OR REPLACE FUNCTION public.lookup_login_email(p_username text)
RETURNS TABLE (email text, is_active boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT up.email, up.is_active
  FROM public.user_profiles up
  WHERE lower(up.username) = lower(trim(p_username))
  LIMIT 1;
$$;

-- Lock down execute: only the pre-auth (anon) and logged-in (authenticated) roles.
REVOKE ALL ON FUNCTION public.lookup_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated;

-- Remove the policy that made every row of user_profiles world-readable to anon.
DROP POLICY IF EXISTS "Allow anon username lookup for login" ON public.user_profiles;
