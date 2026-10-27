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
