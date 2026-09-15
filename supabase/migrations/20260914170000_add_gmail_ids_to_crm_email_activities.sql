-- Migration: 20260914170000_add_gmail_ids_to_crm_email_activities.sql
-- Add nullable gmail_message_id and gmail_thread_id to public.crm_email_activities
-- with partial unique index and transparent deduplication protection.

ALTER TABLE public.crm_email_activities 
  ADD COLUMN IF NOT EXISTS gmail_message_id text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_email_activities_gmail_msg_id 
  ON public.crm_email_activities(gmail_message_id) 
  WHERE gmail_message_id IS NOT NULL;

-- Deduplication function: prevents duplicate activity records if a caller subsequently
-- attempts to insert the same outbound email that send-bulk-email already recorded.
CREATE OR REPLACE FUNCTION public.fn_crm_email_activities_dedup()
RETURNS TRIGGER AS $$
DECLARE
  v_existing_id UUID;
BEGIN
  -- If the incoming record already has gmail_message_id, let normal unique index handle it
  IF NEW.gmail_message_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- If incoming record has NO gmail_message_id, check if a matching record with gmail_message_id
  -- was already created for this send (same inquiry, subject, creator, within 2-minute window)
  SELECT id INTO v_existing_id
  FROM public.crm_email_activities
  WHERE gmail_message_id IS NOT NULL
    AND created_by IS NOT DISTINCT FROM NEW.created_by
    AND subject = NEW.subject
    AND inquiry_id IS NOT DISTINCT FROM NEW.inquiry_id
    AND sent_date >= (COALESCE(NEW.sent_date, now()) - INTERVAL '2 minutes')
    AND sent_date <= (COALESCE(NEW.sent_date, now()) + INTERVAL '2 minutes')
  ORDER BY sent_date DESC
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Update existing activity with any supplementary fields and suppress duplicate insert
    UPDATE public.crm_email_activities
    SET
      contact_id = COALESCE(crm_email_activities.contact_id, NEW.contact_id),
      template_id = COALESCE(crm_email_activities.template_id, NEW.template_id),
      attachment_urls = COALESCE(crm_email_activities.attachment_urls, NEW.attachment_urls)
    WHERE id = v_existing_id;

    RETURN NULL; -- Suppresses the duplicate insert
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_email_activities_dedup ON public.crm_email_activities;
CREATE TRIGGER trg_crm_email_activities_dedup
  BEFORE INSERT ON public.crm_email_activities
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_crm_email_activities_dedup();
