ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS bulk_email_batch_size integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS bulk_email_batch_delay_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS bulk_email_worker_url text,
  ADD COLUMN IF NOT EXISTS bulk_email_worker_secret text;

ALTER TABLE public.bulk_email_campaigns
  ADD COLUMN IF NOT EXISTS email_body text,
  ADD COLUMN IF NOT EXISTS sender_name text,
  ADD COLUMN IF NOT EXISTS attachments_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS processing_batch_size integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS processing_delay_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS next_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_lock_until timestamptz,
  ADD COLUMN IF NOT EXISTS worker_lock_id text,
  ADD COLUMN IF NOT EXISTS worker_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS worker_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_worker_error text;

ALTER TABLE public.bulk_email_recipients
  ADD COLUMN IF NOT EXISTS send_order integer,
  ADD COLUMN IF NOT EXISTS attempt_number integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS edge_execution_id text,
  ADD COLUMN IF NOT EXISTS provider_response jsonb,
  ADD COLUMN IF NOT EXISTS error_code text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bulk_email_recipients_status_check_v2'
  ) THEN
    ALTER TABLE public.bulk_email_recipients
      DROP CONSTRAINT IF EXISTS bulk_email_recipients_status_check;

    ALTER TABLE public.bulk_email_recipients
      ADD CONSTRAINT bulk_email_recipients_status_check_v2
      CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
  END IF;
END $$;

WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY campaign_id ORDER BY created_at, id)::integer AS rn
  FROM public.bulk_email_recipients
  WHERE send_order IS NULL
)
UPDATE public.bulk_email_recipients r
SET send_order = ordered.rn
FROM ordered
WHERE r.id = ordered.id;

CREATE INDEX IF NOT EXISTS idx_bulk_email_campaigns_worker_due
  ON public.bulk_email_campaigns (status, next_run_at)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_bulk_email_recipients_worker_claim
  ON public.bulk_email_recipients (campaign_id, status, send_order)
  WHERE status IN ('pending', 'sending');

CREATE OR REPLACE FUNCTION public.claim_bulk_email_campaign(
  p_campaign_id uuid,
  p_execution_id text,
  p_lock_seconds integer DEFAULT 120,
  p_owner_id uuid DEFAULT NULL
)
RETURNS public.bulk_email_campaigns
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign public.bulk_email_campaigns;
BEGIN
  UPDATE public.bulk_email_campaigns
  SET
    worker_lock_until = now() + make_interval(secs => GREATEST(30, p_lock_seconds)),
    worker_lock_id = p_execution_id,
    worker_started_at = now(),
    last_worker_error = NULL
  WHERE id = p_campaign_id
    AND status = 'in_progress'
    AND (next_run_at IS NULL OR next_run_at <= now())
    AND (worker_lock_until IS NULL OR worker_lock_until < now())
    AND (p_owner_id IS NULL OR created_by = p_owner_id)
  RETURNING * INTO v_campaign;

  RETURN v_campaign;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_bulk_email_recipients(
  p_campaign_id uuid,
  p_limit integer,
  p_execution_id text
)
RETURNS SETOF public.bulk_email_recipients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH stale AS (
    UPDATE public.bulk_email_recipients
    SET
      status = 'pending',
      error_code = 'STALE_SENDING_REQUEUED',
      error_message = 'Recipient was stuck in sending state and was requeued.',
      completed_at = now()
    WHERE campaign_id = p_campaign_id
      AND status = 'sending'
      AND started_at < now() - interval '10 minutes'
      AND sent_at IS NULL
    RETURNING id
  ),
  picked AS (
    SELECT r.id
    FROM public.bulk_email_recipients r
    WHERE r.campaign_id = p_campaign_id
      AND r.status = 'pending'
    ORDER BY r.send_order NULLS LAST, r.created_at, r.id
    LIMIT GREATEST(1, p_limit)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.bulk_email_recipients r
  SET
    status = 'sending',
    attempt_number = r.attempt_number + 1,
    started_at = now(),
    completed_at = NULL,
    http_status = NULL,
    edge_execution_id = p_execution_id,
    provider_response = NULL,
    error_code = NULL,
    error_message = NULL
  FROM picked
  WHERE r.id = picked.id
  RETURNING r.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_bulk_email_campaign_counts(p_campaign_id uuid)
RETURNS TABLE(sent_count integer, failed_count integer, pending_count integer, sending_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH counts AS (
    SELECT
      count(*) FILTER (WHERE status = 'sent')::integer AS sent_count,
      count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
      count(*) FILTER (WHERE status = 'pending')::integer AS pending_count,
      count(*) FILTER (WHERE status = 'sending')::integer AS sending_count
    FROM public.bulk_email_recipients
    WHERE campaign_id = p_campaign_id
  )
  UPDATE public.bulk_email_campaigns c
  SET
    sent_count = counts.sent_count,
    failed_count = counts.failed_count
  FROM counts
  WHERE c.id = p_campaign_id
  RETURNING counts.sent_count, counts.failed_count, counts.pending_count, counts.sending_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_bulk_email_worker()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_settings record;
BEGIN
  SELECT bulk_email_worker_url, bulk_email_worker_secret
  INTO v_settings
  FROM public.app_settings
  LIMIT 1;

  IF v_settings.bulk_email_worker_url IS NULL OR v_settings.bulk_email_worker_secret IS NULL THEN
    RAISE LOG 'bulk email worker cron skipped: worker URL/secret not configured';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_settings.bulk_email_worker_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Bulk-Email-Worker-Secret', v_settings.bulk_email_worker_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    PERFORM cron.unschedule('bulk-email-worker');
    PERFORM cron.schedule(
      'bulk-email-worker',
      '* * * * *',
      'SELECT public.invoke_bulk_email_worker();'
    );
  ELSE
    RAISE LOG 'bulk email worker cron not installed: enable pg_cron and pg_net, then schedule SELECT public.invoke_bulk_email_worker();';
  END IF;
END $$;
