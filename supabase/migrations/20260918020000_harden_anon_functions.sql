-- ============================================================================
-- AUDIT AND HARDEN REMAINING ANON SECURITY DEFINER FUNCTIONS
-- Migration: 20260918020000_harden_anon_functions.sql
-- ============================================================================

-- 1. is_setup_mode
-- Harden search_path, keep for authenticated/service_role, REVOKE from anon.
-- Unauthenticated users have no legitimate need to inspect database setup mode state.
CREATE OR REPLACE FUNCTION public.is_setup_mode()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT setup_mode FROM public.app_settings LIMIT 1), false);
$$;

REVOKE ALL ON FUNCTION public.is_setup_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_setup_mode() TO authenticated, service_role;


-- 2. lookup_login_email
-- Hardened: sanitized input, STABLE attribute, search_path = public, pg_temp.
-- Genuinely required by unauthenticated (anon) callers to support username-based login
-- before passing resolved credentials to supabase.auth.signInWithPassword.
CREATE OR REPLACE FUNCTION public.lookup_login_email(p_username text)
RETURNS TABLE(email text, is_active boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_clean_username text := lower(trim(COALESCE(p_username, '')));
BEGIN
  -- Fast return on empty input to avoid table scan
  IF v_clean_username = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT up.email, up.is_active
  FROM public.user_profiles up
  WHERE lower(trim(up.username)) = v_clean_username
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_login_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_login_email(text) TO anon, authenticated, service_role;
