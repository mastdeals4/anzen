-- ============================================================================
-- SAPJ GMAIL AI AGENT — BACKGROUND CRON SCHEDULE (08:00, 13:00, 18:00 WIB)
-- ============================================================================
--
-- Automatically checks connected Gmail 3 times daily in Asia/Jakarta (WIB = UTC+7):
--   08:00 WIB = 01:00 UTC (0 1 * * *)
--   13:00 WIB = 06:00 UTC (0 6 * * *)
--   18:00 WIB = 11:00 UTC (0 11 * * *)
--
-- Calls the unified sapj-gmail-agent edge function via pg_net / pg_cron.
-- Both scheduled crons and the manual [ CHECK NOW ] button invoke the exact
-- same sapj-gmail-agent edge function.

CREATE OR REPLACE FUNCTION public.invoke_sapj_gmail_agent()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_url text;
  v_agent_secret text := 'sapj-internal-cron-trigger';
  v_vault_secret text;
BEGIN
  -- 1. Try reading base url from app_settings
  SELECT bulk_email_worker_url INTO v_url FROM public.app_settings LIMIT 1;

  IF v_url IS NOT NULL AND v_url <> '' THEN
    v_url := regexp_replace(v_url, '/functions/v1/.*$', '/functions/v1/sapj-gmail-agent');
  ELSE
    -- Default to live project edge runtime
    v_url := 'https://dkrtsqienlhpouohmfki.supabase.co/functions/v1/sapj-gmail-agent';
  END IF;

  -- 2. Read optional secret override from Supabase Vault if present
  BEGIN
    SELECT decrypted_secret INTO v_vault_secret
    FROM vault.decrypted_secrets
    WHERE name = 'sapj_agent_secret'
    LIMIT 1;
    IF v_vault_secret IS NOT NULL AND v_vault_secret <> '' THEN
      v_agent_secret := v_vault_secret;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- vault schema or secret unreadable, continue with standard internal secret
  END;

  -- 2. Dispatch HTTP POST to the agent edge function via pg_net
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Agent-Secret', v_agent_secret
      ),
      body := jsonb_build_object(
        'source', 'pg_cron',
        'scheduled', true
      ),
      timeout_milliseconds := 60000
    );
  ELSE
    RAISE LOG 'invoke_sapj_gmail_agent: pg_net extension not enabled, skipping HTTP dispatch';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.invoke_sapj_gmail_agent() IS
  'Triggered by pg_cron 3x daily (08:00, 13:00, 18:00 WIB) to run the SAPJ Gmail AI background agent.';

-- Register pg_cron jobs if extensions exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Unschedule any previous versions safely
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sapj-gmail-agent-0800') THEN
      PERFORM cron.unschedule('sapj-gmail-agent-0800');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sapj-gmail-agent-1300') THEN
      PERFORM cron.unschedule('sapj-gmail-agent-1300');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sapj-gmail-agent-1800') THEN
      PERFORM cron.unschedule('sapj-gmail-agent-1800');
    END IF;

    -- 08:00 WIB (01:00 UTC)
    PERFORM cron.schedule(
      'sapj-gmail-agent-0800',
      '0 1 * * *',
      'SELECT public.invoke_sapj_gmail_agent();'
    );

    -- 13:00 WIB (06:00 UTC)
    PERFORM cron.schedule(
      'sapj-gmail-agent-1300',
      '0 6 * * *',
      'SELECT public.invoke_sapj_gmail_agent();'
    );

    -- 18:00 WIB (11:00 UTC)
    PERFORM cron.schedule(
      'sapj-gmail-agent-1800',
      '0 11 * * *',
      'SELECT public.invoke_sapj_gmail_agent();'
    );

    RAISE LOG 'sapj-gmail-agent cron schedules configured: 08:00, 13:00, 18:00 WIB (01:00, 06:00, 11:00 UTC)';
  ELSE
    RAISE LOG 'pg_cron extension not installed; cron jobs can be enabled once pg_cron is activated.';
  END IF;
END $$;
