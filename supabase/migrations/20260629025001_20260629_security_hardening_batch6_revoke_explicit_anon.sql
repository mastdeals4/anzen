-- ============================================================
-- Security Hardening Batch 6 – Revoke explicit anon grants
-- on non-SECURITY DEFINER functions.
-- These have anon=X/postgres (explicit anon grant) rather
-- than =X/postgres (PUBLIC grant), so Part C missed them.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = false
      AND has_function_privilege('anon', p.oid, 'execute') = true
  LOOP
    BEGIN
      -- Skip the intentional anon login lookup
      IF r.proname NOT IN ('get_user_by_username', 'lookup_user_by_username', 'check_username_exists') THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon', r.proname, r.args);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname, r.args);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not revoke from anon for %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;

-- Also clean up any remaining SECURITY DEFINER functions that still have anon
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND has_function_privilege('anon', p.oid, 'execute') = true
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM anon', r.proname, r.args);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not revoke for %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;
