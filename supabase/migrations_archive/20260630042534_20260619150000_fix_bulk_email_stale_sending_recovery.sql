UPDATE public.bulk_email_recipients
SET
  status        = 'pending',
  error_code    = 'STALE_SENDING_REQUEUED',
  error_message = 'Recipient was stuck in sending state (worker timed out) and was requeued.',
  completed_at  = now()
WHERE status = 'sending'
  AND sent_at IS NULL
  AND started_at < now() - interval '5 minutes';

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
