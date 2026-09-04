-- ============================================================
-- Security Hardening Batch 5 – Complete elimination of all
-- remaining security audit warnings.
-- 
-- Part A: Convert trigger SECURITY DEFINER → SECURITY INVOKER
-- Part B: Revoke PUBLIC from all remaining SECURITY DEFINER RPCs
-- Part C: Revoke PUBLIC from non-SECURITY DEFINER trigger functions
-- ============================================================

-- ============================================================
-- PART A: Convert trigger functions from SECURITY DEFINER to
-- SECURITY INVOKER. Triggers always run as the table owner
-- (postgres) regardless of security mode; SECURITY DEFINER
-- on a trigger function only escalates privileges and is
-- never needed.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.prorettype::regtype::text = 'trigger'
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER FUNCTION public.%I(%s) SECURITY INVOKER',
        r.proname, r.args
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not alter %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;

-- ============================================================
-- PART B: Revoke PUBLIC execute from all SECURITY DEFINER
-- RPC functions (non-trigger). Keep authenticated + service_role.
-- This covers all the remaining ~65 functions the linter flags.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = true
      AND p.prorettype::regtype::text != 'trigger'
      -- only where PUBLIC or anon still has execute
      AND (
        has_function_privilege('anon', p.oid, 'execute') = true
        OR p.proacl::text LIKE '%=X%'
      )
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname, r.args);
      EXECUTE format('GRANT  EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not process %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;

-- ============================================================
-- PART C: Revoke PUBLIC execute from non-SECURITY DEFINER
-- functions that anon should not call directly.
-- These are internal trigger helpers and utility functions
-- that have accidentally retained the default PUBLIC grant.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef = false
      AND has_function_privilege('anon', p.oid, 'execute') = true
      AND p.proacl IS NOT NULL
      AND p.proacl::text LIKE '%=X%'
      -- Exclude the username lookup function – anon legitimately needs this for login
      AND p.proname NOT IN ('get_user_by_username', 'lookup_user_by_username')
  LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC', r.proname, r.args);
      EXECUTE format('GRANT  EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', r.proname, r.args);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Could not process %: %', r.proname, SQLERRM;
    END;
  END LOOP;
END $$;

-- ============================================================
-- PART D: Ensure the username-lookup function used by the
-- login screen keeps anon access (intentional).
-- ============================================================

DO $$
BEGIN
  -- Restore anon access if the loop above accidentally stripped it
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_user_by_username'
  ) THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_user_by_username(text) TO anon';
  END IF;
END $$;
