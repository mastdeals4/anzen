/*
  # Revoke direct PUBLIC / anon EXECUTE on pricing helpers

  Focused follow-up to 20260522120000_pre_bolt_security_hardening.sql.
  Some helper functions were still callable by `anon` per the advisor.

  Rules:
    - REVOKE EXECUTE from PUBLIC and anon for every function below.
    - Keep `authenticated` EXECUTE only where actually needed:
        * current_user_has_pricing_role — used in RLS USING/WITH CHECK clauses,
          must remain callable by authenticated.
        * upsert_notification — called from the frontend
          (src/utils/notifications.ts via supabase.rpc), must remain callable
          by authenticated.
        * Everything else is trigger-only and is fully revoked from
          authenticated as well.

  Safe to re-run. Each step is guarded by a pg_proc existence check so the
  migration is a no-op if a signature does not exist on this project.
*/

DO $$
DECLARE
  sig  text;
  keep text;
  i    int;
BEGIN
  FOR i IN 1..7 LOOP
    sig := (ARRAY[
      'current_user_has_pricing_role(text[])',
      'enforce_final_quote_write_restriction()',
      'generate_pr_number()',
      'generate_price_request_number()',
      'recompute_price_request_counts(uuid)',
      'trg_sync_price_request_counts()',
      'upsert_notification(uuid,text,text,text,text,text)'
    ])[i];
    keep := (ARRAY['yes','no','no','no','no','no','yes'])[i];

    -- Only act if a function with this exact signature exists in public.
    IF EXISTS (
      SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.oid::regprocedure::text = 'public.' || sig
    ) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', sig);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon',   sig);

      IF keep = 'yes' THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', sig);
      ELSE
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', sig);
      END IF;
    END IF;
  END LOOP;
END $$;
