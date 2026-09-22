-- Migration: 20260922170000_grant_auto_match_smart_authenticated.sql
-- Description: Grant EXECUTE on auto_match_smart to authenticated users for Bank Reconciliation Auto-Match

BEGIN;

GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO authenticated;

COMMIT;
