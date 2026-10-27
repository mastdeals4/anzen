-- Unschedule the bulk email worker pg_cron job since bulk_email_worker_secret is not configured.
-- This removes the unnecessary 1-minute wakeups and repeated log messages.
-- The underlying function public.invoke_bulk_email_worker() remains available for when the worker is configured.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE command ILIKE '%invoke_bulk_email_worker%';
  END IF;
END $$;
