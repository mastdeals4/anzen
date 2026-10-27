-- Migration: 20260922190000_bank_reconciliation_status_model_alignment.sql
-- Description: Clean up legacy contradictory bank reconciliation status combinations
-- Aligns existing matched rows to have matching_status = 'confirmed' per bsl_sync_reconciliation_status rules.

BEGIN;

-- 1. Align legacy reconciled bank statement lines where reconciliation_status is 'matched'
-- but matching_status was still 'suggested' or 'none'.
UPDATE public.bank_statement_lines
SET matching_status = 'confirmed'
WHERE reconciliation_status = 'matched'
  AND matching_status <> 'confirmed';

-- 2. Confirm permissions on auto_match_smart
REVOKE ALL ON FUNCTION public.auto_match_smart() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_match_smart() FROM anon;
GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO authenticated;
GRANT EXECUTE ON FUNCTION public.auto_match_smart() TO service_role;

COMMIT;
