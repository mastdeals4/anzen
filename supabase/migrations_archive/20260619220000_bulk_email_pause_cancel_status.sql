/*
  Extend bulk_email_campaigns and bulk_email_recipients status enums
  to support pause/cancel/resume workflow.

  ## What this adds
  1. bulk_email_campaigns.status CHECK — add 'paused' and 'cancelled'
  2. bulk_email_recipients.status CHECK — add 'cancelled'

  ## What this does NOT change
  - No schema columns added or removed
  - No existing data modified
  - No other tables touched
  - No permissions changed

  ## UI workflow enabled by this migration
  Pause:   status → 'paused', clear worker_lock_until / worker_lock_id
  Resume:  failed + sending recipients → 'pending', status → 'in_progress', next_run_at = NOW()
  Cancel:  status → 'cancelled', pending recipients → 'cancelled'
*/

-- ===========================================================================
-- 1. bulk_email_campaigns.status — add 'paused' and 'cancelled'
-- ===========================================================================
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT constraint_name INTO v_constraint
  FROM information_schema.table_constraints
  WHERE table_schema    = 'public'
    AND table_name      = 'bulk_email_campaigns'
    AND constraint_type = 'CHECK'
    AND constraint_name LIKE '%status%'
  LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bulk_email_campaigns DROP CONSTRAINT %I', v_constraint);
    RAISE NOTICE '[bulk_email_campaigns] Dropped old status CHECK: %', v_constraint;
  END IF;
END $$;

ALTER TABLE public.bulk_email_campaigns
  ADD CONSTRAINT bulk_email_campaigns_status_check
  CHECK (status IN ('in_progress', 'completed', 'partial', 'failed', 'paused', 'cancelled'));

-- ===========================================================================
-- 2. bulk_email_recipients.status — add 'cancelled'
-- ===========================================================================
DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT constraint_name INTO v_constraint
  FROM information_schema.table_constraints
  WHERE table_schema    = 'public'
    AND table_name      = 'bulk_email_recipients'
    AND constraint_type = 'CHECK'
    AND constraint_name LIKE '%status%'
  LIMIT 1;

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bulk_email_recipients DROP CONSTRAINT %I', v_constraint);
    RAISE NOTICE '[bulk_email_recipients] Dropped old status CHECK: %', v_constraint;
  END IF;
END $$;

ALTER TABLE public.bulk_email_recipients
  ADD CONSTRAINT bulk_email_recipients_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled'));
