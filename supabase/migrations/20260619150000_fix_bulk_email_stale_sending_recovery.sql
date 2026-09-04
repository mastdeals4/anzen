/*
  # Fix bulk email: stale 'sending' recipient recovery + immediate unlock

  ## Problems fixed
  1. claim_bulk_email_recipients reset stale 'sending' rows only after 10 minutes.
     The campaign lock expires after 120 seconds, leaving an 8-minute window where
     stuck recipients block the next batch without being recoverable.
     Reduced to 5 minutes (still safely > lock duration, avoids resetting a
     recipient that's genuinely in-flight).

  2. Any rows currently stuck in 'sending' (from a previous timed-out batch) are
     immediately reset to 'pending' so they are picked up on the next worker run.

  3. Any campaigns whose worker_lock_until has expired but next_run_at was never
     updated (because the worker timed out before reaching the update) are set to
     next_run_at = now() so pg_cron / self-scheduling picks them up immediately.
*/

-- ===========================================================================
-- 1. Immediate recovery: reset stuck 'sending' recipients to 'pending'
-- ===========================================================================
UPDATE public.bulk_email_recipients
SET
  status        = 'pending',
  error_code    = 'STALE_SENDING_REQUEUED',
  error_message = 'Recipient was stuck in sending state (worker timed out) and was requeued.',
  completed_at  = now()
WHERE status = 'sending'
  AND sent_at IS NULL
  AND started_at < now() - interval '5 minutes';

-- ===========================================================================
-- 2. Immediate recovery: unlock campaigns whose lock expired mid-batch
--    and ensure next_run_at is in the past so they are picked up next run
-- ===========================================================================
UPDATE public.bulk_email_campaigns
SET
  worker_lock_until = NULL,
  worker_lock_id    = NULL,
  next_run_at       = now()
WHERE status = 'in_progress'
  AND worker_lock_until IS NOT NULL
  AND worker_lock_until < now()
  AND EXISTS (
    SELECT 1 FROM public.bulk_email_recipients
    WHERE campaign_id = bulk_email_campaigns.id
      AND status IN ('pending', 'sending')
  );

-- ===========================================================================
-- 3. Update claim_bulk_email_recipients: reduce stale timeout 10 min → 5 min
-- ===========================================================================
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
      status        = 'pending',
      error_code    = 'STALE_SENDING_REQUEUED',
      error_message = 'Recipient was stuck in sending state and was requeued.',
      completed_at  = now()
    WHERE campaign_id = p_campaign_id
      AND status = 'sending'
      AND started_at < now() - interval '5 minutes'
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
    status         = 'sending',
    attempt_number = r.attempt_number + 1,
    started_at     = now(),
    completed_at   = NULL,
    http_status    = NULL,
    edge_execution_id = p_execution_id,
    provider_response = NULL,
    error_code     = NULL,
    error_message  = NULL
  FROM picked
  WHERE r.id = picked.id
  RETURNING r.*;
END;
$$;
