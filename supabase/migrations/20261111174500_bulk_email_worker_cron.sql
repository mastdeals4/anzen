-- ============================================================================
-- BULK EMAIL CAMPAIGN WORKER CRON (Every 5 seconds)
-- ============================================================================
--
-- Checks every 5 seconds for in-progress bulk email campaigns with pending
-- recipients due for delivery. Enforces minimum 10-second pacing in worker.
-- Dispatches via net.http_post to process-bulk-email-campaign edge function.

CREATE OR REPLACE FUNCTION public.invoke_bulk_email_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_due_count integer;
  v_settings record;
BEGIN
  -- 1. Check if there are any in_progress campaigns due for processing
  SELECT count(*) INTO v_due_count
  FROM public.bulk_email_campaigns
  WHERE status = 'in_progress'
    AND (next_run_at IS NULL OR next_run_at <= now())
    AND (worker_lock_until IS NULL OR worker_lock_until < now());

  IF v_due_count = 0 THEN
    RETURN;
  END IF;

  -- 2. Read worker URL and secret from app_settings
  SELECT bulk_email_worker_url, bulk_email_worker_secret
  INTO v_settings
  FROM public.app_settings
  LIMIT 1;

  IF v_settings.bulk_email_worker_url IS NULL OR v_settings.bulk_email_worker_secret IS NULL THEN
    RAISE LOG 'bulk email worker cron skipped: worker URL/secret not configured';
    RETURN;
  END IF;

  -- 3. Post to process-bulk-email-campaign via pg_net
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM net.http_post(
      url := v_settings.bulk_email_worker_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Bulk-Email-Worker-Secret', v_settings.bulk_email_worker_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000
    );
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.invoke_bulk_email_worker() IS
  'Triggered by pg_cron every 5 seconds to process persistent bulk email campaign queues.';

-- Register pg_cron job
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-bulk-email-worker') THEN
      PERFORM cron.unschedule('process-bulk-email-worker');
    END IF;

    PERFORM cron.schedule(
      'process-bulk-email-worker',
      '5 seconds',
      'SELECT public.invoke_bulk_email_worker();'
    );
  END IF;
END $$;
