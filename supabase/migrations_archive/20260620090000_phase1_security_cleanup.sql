/*
  PHASE 1 — Security Advisor Cleanup (safe-only changes)
  =======================================================

  Targets three classes of Supabase security advisor warnings without
  changing any business logic, application behaviour, or access patterns.

  WHAT THIS DOES
  --------------
  A. Fix SECURITY DEFINER views (vw_input_ppn_report, vw_monthly_tax_summary,
     vw_pph22_advance_tax_report) → convert to security_invoker = true.

     Root cause: Migration 20260209143036 already set security_invoker = true
     on the first two views, but migration 20260619120000 later ran
     CREATE OR REPLACE VIEW on both, which SILENTLY RESETS security_invoker
     back to default (false) in PostgreSQL. vw_pph22_advance_tax_report was
     created in that same migration with no invoker setting.

  B. Fix petty_cash_resolved_tx_id function_search_path_mutable.
     The function has no SET search_path — an attacker who can change the
     search_path at session level could theoretically shadow builtins.
     Fix: add SET search_path = ''. The function is IMMUTABLE and used in a
     unique index expression; CREATE OR REPLACE is safe (no signature change).

  C. Revoke anon / PUBLIC EXECUTE from bulk email SECURITY DEFINER functions.
     Migration 20260618120000 created claim_bulk_email_campaign,
     claim_bulk_email_recipients, refresh_bulk_email_campaign_counts, and
     invoke_bulk_email_worker with SECURITY DEFINER but with zero REVOKE/GRANT
     statements — leaving the default PUBLIC EXECUTE grant in place.

  D. Enable RLS on import_data_type_backup_20260604.
     The table is a manual DB backup (not referenced by any migration or
     application code). RLS is disabled, which means any authenticated user
     can SELECT from it via the REST API. Enabling RLS with no policies = deny
     all access. The table is NOT dropped — an explicit human decision is
     required for that.

  WHAT THIS DOES NOT CHANGE
  -------------------------
  - No columns, tables, or views added or removed.
  - No data modified.
  - No application RPC signatures changed.
  - No business logic touched.
  - Bulk email worker continues to work: the edge function calls Supabase via
    service_role (which bypasses all RLS and grant checks).
  - delete_batch_safe already has REVOKE/GRANT from migration 20260619210000 —
    no change needed.
  - finance posting functions, Kunal pricing logic, Anvi sourcing: untouched.
*/

-- ===========================================================================
-- PART A: Fix SECURITY DEFINER views → security_invoker = true
-- ===========================================================================
-- ALTER VIEW ... SET (security_invoker = true) does not rewrite the view body
-- or change any column. It only changes how the view evaluates row-level
-- security — with security_invoker = true, the calling user's own RLS
-- policies apply (correct / safer behaviour).

ALTER VIEW public.vw_input_ppn_report    SET (security_invoker = true);
ALTER VIEW public.vw_monthly_tax_summary SET (security_invoker = true);

-- vw_pph22_advance_tax_report was created in 20260619120000 with no invoker
-- setting — this is its first security_invoker application.
ALTER VIEW public.vw_pph22_advance_tax_report SET (security_invoker = true);


-- ===========================================================================
-- PART B: Fix petty_cash_resolved_tx_id — add SET search_path = ''
-- ===========================================================================
-- SAFETY NOTE: This function is referenced in a partial unique index expression
-- (uniq_petty_cash_resolved_tx_id on journal_entries). PostgreSQL allows
-- CREATE OR REPLACE as long as the signature (args, return type, volatility)
-- is unchanged. We are only adding SET search_path = ''. The function body
-- contains no unqualified table names so SET search_path = '' is harmless.
CREATE OR REPLACE FUNCTION public.petty_cash_resolved_tx_id(
  p_reference_id     uuid,
  p_reference_number text
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    p_reference_id,
    CASE
      WHEN p_reference_number ~ '^PC-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN SUBSTRING(p_reference_number FROM 4)::uuid
      ELSE NULL::uuid
    END
  )
$$;


-- ===========================================================================
-- PART C: Revoke anon / PUBLIC from bulk email SECURITY DEFINER functions
-- ===========================================================================
-- Migration 20260618120000 created these with no REVOKE/GRANT, leaving the
-- PostgreSQL default PUBLIC EXECUTE grant in place.
--
-- claim_bulk_email_campaign — worker-only (edge function uses service_role,
--   which bypasses grants entirely). Keeping authenticated EXECUTE for safety
--   in case future admin tooling calls it.
REVOKE ALL ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bulk_email_campaign(uuid, text, integer, uuid)
  TO authenticated;

-- claim_bulk_email_recipients — worker-only (same reasoning).
-- The function was recreated in 20260619150000 with the same signature.
REVOKE ALL ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bulk_email_recipients(uuid, integer, text)
  TO authenticated;

-- refresh_bulk_email_campaign_counts — called directly from DeliveryLog.tsx
--   via supabase.rpc('refresh_bulk_email_campaign_counts', ...).
--   authenticated EXECUTE is required.
REVOKE ALL ON FUNCTION public.refresh_bulk_email_campaign_counts(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_bulk_email_campaign_counts(uuid)
  TO authenticated;

-- invoke_bulk_email_worker — triggered only by pg_cron (runs as postgres
--   superuser, which bypasses all privilege checks). No application code or
--   frontend calls this function. Revoke PUBLIC; do NOT grant to authenticated.
REVOKE ALL ON FUNCTION public.invoke_bulk_email_worker()
  FROM PUBLIC;
-- Intentionally NO GRANT — cron/postgres calls it without needing a grant.


-- ===========================================================================
-- PART D: Enable RLS on backup table (deny all access via zero-policy RLS)
-- ===========================================================================
-- The table was created manually outside any migration. It is a backup snapshot
-- and is not referenced by any application code. Enabling RLS with no policies
-- causes the Postgres REST API to return 0 rows for any role — effectively
-- blocking access without dropping the table.
--
-- To restore access (e.g. for a manual data recovery operation), a superuser
-- can temporarily do: ALTER TABLE ... DISABLE ROW LEVEL SECURITY;
-- To permanently remove the table after review: DROP TABLE ... (needs approval).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'import_data_type_backup_20260604'
  ) THEN
    EXECUTE 'ALTER TABLE public.import_data_type_backup_20260604 ENABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'RLS enabled on import_data_type_backup_20260604 — no policies = deny all REST access';
  ELSE
    RAISE NOTICE 'import_data_type_backup_20260604 not found — already cleaned up or renamed; skipping';
  END IF;
END $$;


-- ===========================================================================
-- Summary notice
-- ===========================================================================
DO $$
BEGIN
  RAISE NOTICE '============================================================';
  RAISE NOTICE 'Phase 1 security cleanup applied:';
  RAISE NOTICE '  A. vw_input_ppn_report         → security_invoker = true';
  RAISE NOTICE '  A. vw_monthly_tax_summary       → security_invoker = true';
  RAISE NOTICE '  A. vw_pph22_advance_tax_report  → security_invoker = true';
  RAISE NOTICE '  B. petty_cash_resolved_tx_id    → SET search_path = ''''';
  RAISE NOTICE '  C. claim_bulk_email_campaign    → REVOKE PUBLIC, GRANT authenticated';
  RAISE NOTICE '  C. claim_bulk_email_recipients  → REVOKE PUBLIC, GRANT authenticated';
  RAISE NOTICE '  C. refresh_bulk_email_campaign_counts → REVOKE PUBLIC, GRANT authenticated';
  RAISE NOTICE '  C. invoke_bulk_email_worker     → REVOKE PUBLIC (cron only)';
  RAISE NOTICE '  D. import_data_type_backup_20260604 → RLS enabled (deny all)';
  RAISE NOTICE '============================================================';
END $$;
