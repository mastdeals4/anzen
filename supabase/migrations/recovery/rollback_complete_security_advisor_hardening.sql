-- ============================================================================
-- Recovery Script: Rollback Complete Security Advisor Hardening
-- File: supabase/migrations/recovery/rollback_complete_security_advisor_hardening.sql
-- ============================================================================

BEGIN;

-- Restore grants to authenticated and anon if needed for recovery
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'generate_credit_note_number') THEN
    GRANT EXECUTE ON FUNCTION public.generate_credit_note_number() TO anon, authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'invoke_sapj_gmail_agent') THEN
    GRANT EXECUTE ON FUNCTION public.invoke_sapj_gmail_agent() TO authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
    GRANT USAGE ON SCHEMA net TO PUBLIC, anon, authenticated;
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO PUBLIC, anon, authenticated;
  END IF;
END $$;

COMMIT;
