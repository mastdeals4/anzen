-- ============================================================================
-- WHATSAPP CAMPAIGN BACKGROUND WORKER CRON (Every 5 seconds)
-- ============================================================================
--
-- Checks every 5 seconds for in-progress WhatsApp bulk campaigns with pending
-- recipients due for delivery. Enforces minimum 20-second pacing in worker.
-- Dispatches via net.http_post to process-whatsapp-campaign edge function.

CREATE OR REPLACE FUNCTION public.invoke_process_whatsapp_campaign()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_due_count integer;
  v_worker_url text;
  v_worker_secret text := 'sapj_wa_worker_internal_2026';
  v_vault_secret text;
BEGIN
  -- 1. Check if there are any in_progress campaigns due for next recipient dispatch
  SELECT count(*) INTO v_due_count
  FROM public.whatsapp_campaigns
  WHERE status = 'in_progress'
    AND (next_run_at IS NULL OR next_run_at <= now())
    AND (worker_lock_until IS NULL OR worker_lock_until < now());

  IF v_due_count = 0 THEN
    RETURN;
  END IF;

  -- 2. Worker URL (Edge function endpoint)
  v_worker_url := 'https://dkrtsqienlhpouohmfki.supabase.co/functions/v1/process-whatsapp-campaign';

  -- 3. Read optional secret override from Supabase Vault if present
  BEGIN
    SELECT decrypted_secret INTO v_vault_secret
    FROM vault.decrypted_secrets
    WHERE name = 'whatsapp_worker_secret'
    LIMIT 1;
    IF v_vault_secret IS NOT NULL AND v_vault_secret <> '' THEN
      v_worker_secret := v_vault_secret;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- vault schema or secret unreadable, continue with standard internal secret
  END;

  -- 4. Dispatch HTTP POST to process-whatsapp-campaign edge function via pg_net
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM net.http_post(
      url := v_worker_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-WhatsApp-Worker-Secret', v_worker_secret
      ),
      body := jsonb_build_object(
        'source', 'pg_cron',
        'scheduled', true
      ),
      timeout_milliseconds := 25000
    );
  ELSE
    RAISE LOG 'invoke_process_whatsapp_campaign: pg_net extension not enabled, skipping HTTP dispatch';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.invoke_process_whatsapp_campaign() IS
  'Triggered by pg_cron every 5 seconds to process persistent WhatsApp bulk campaign queues.';

-- Register pg_cron job
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-whatsapp-campaign-worker') THEN
      PERFORM cron.unschedule('process-whatsapp-campaign-worker');
    END IF;

    PERFORM cron.schedule(
      'process-whatsapp-campaign-worker',
      '5 seconds',
      'SELECT public.invoke_process_whatsapp_campaign();'
    );

    RAISE LOG 'process-whatsapp-campaign-worker cron scheduled every 5 seconds';
  END IF;
END $$;
