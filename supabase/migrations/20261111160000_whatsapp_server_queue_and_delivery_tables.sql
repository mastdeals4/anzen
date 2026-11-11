-- Migration: WhatsApp Server-Side Queue, Campaign Execution & Delivery Reporting
-- Migration ID: 20261111160000_whatsapp_server_queue_and_delivery_tables.sql

-- 1. Ensure crm_contact_phones has genuine permission evidence columns
ALTER TABLE public.crm_contact_phones 
  ADD COLUMN IF NOT EXISTS opt_in_source TEXT,
  ADD COLUMN IF NOT EXISTS opt_in_timestamp TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opt_in_evidence TEXT,
  ADD COLUMN IF NOT EXISTS permitted_categories TEXT[] DEFAULT ARRAY['customer_service', 'price_alerts'];

-- 2. Create whatsapp_campaigns table
CREATE TABLE IF NOT EXISTS public.whatsapp_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  template_id UUID,
  message_template TEXT NOT NULL,
  attachment_url TEXT,
  attachment_filename TEXT,
  attachment_type TEXT DEFAULT 'DOCUMENT', -- 'DOCUMENT', 'IMAGE'
  status TEXT NOT NULL DEFAULT 'draft', -- 'draft', 'queued', 'in_progress', 'paused', 'cancelled', 'completed', 'partial', 'failed'
  total_recipients INT DEFAULT 0,
  sent_count INT DEFAULT 0,
  delivered_count INT DEFAULT 0,
  read_count INT DEFAULT 0,
  failed_count INT DEFAULT 0,
  processing_delay_seconds INT DEFAULT 20,
  next_run_at TIMESTAMPTZ,
  worker_lock_id TEXT,
  worker_lock_until TIMESTAMPTZ,
  worker_started_at TIMESTAMPTZ,
  worker_finished_at TIMESTAMPTZ,
  last_worker_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 3. Create whatsapp_campaign_recipients table
CREATE TABLE IF NOT EXISTS public.whatsapp_campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.whatsapp_campaigns(id) ON DELETE CASCADE,
  contact_id UUID,
  company_name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'
  personalized_caption TEXT,
  message_id TEXT, -- external Meta Cloud / WhatsApp message ID (wamid.HBg...)
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  provider_response JSONB,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT uq_wa_campaign_recipient UNIQUE (campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_wa_camp_rec_camp_id ON public.whatsapp_campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_wa_camp_rec_status ON public.whatsapp_campaign_recipients(status);
CREATE INDEX IF NOT EXISTS idx_wa_camp_rec_msg_id ON public.whatsapp_campaign_recipients(message_id);

-- 4. RPC for refreshing campaign counters
CREATE OR REPLACE FUNCTION public.refresh_whatsapp_campaign_counts(p_campaign_id UUID)
RETURNS TABLE(
  total_count BIGINT,
  pending_count BIGINT,
  sending_count BIGINT,
  sent_count BIGINT,
  delivered_count BIGINT,
  read_count BIGINT,
  failed_count BIGINT
) AS $$
DECLARE
  v_total BIGINT;
  v_pending BIGINT;
  v_sending BIGINT;
  v_sent BIGINT;
  v_delivered BIGINT;
  v_read BIGINT;
  v_failed BIGINT;
BEGIN
  SELECT 
    COUNT(*),
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'sending'),
    COUNT(*) FILTER (WHERE status = 'sent'),
    COUNT(*) FILTER (WHERE status = 'delivered'),
    COUNT(*) FILTER (WHERE status = 'read'),
    COUNT(*) FILTER (WHERE status = 'failed')
  INTO 
    v_total, v_pending, v_sending, v_sent, v_delivered, v_read, v_failed
  FROM public.whatsapp_campaign_recipients
  WHERE campaign_id = p_campaign_id;

  UPDATE public.whatsapp_campaigns
  SET 
    total_recipients = v_total,
    sent_count = v_sent + v_delivered + v_read,
    delivered_count = v_delivered + v_read,
    read_count = v_read,
    failed_count = v_failed,
    updated_at = now()
  WHERE id = p_campaign_id;

  RETURN QUERY SELECT v_total, v_pending, v_sending, v_sent, v_delivered, v_read, v_failed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Enable RLS
ALTER TABLE public.whatsapp_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_campaign_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow authenticated read whatsapp_campaigns" ON public.whatsapp_campaigns;
CREATE POLICY "Allow authenticated read whatsapp_campaigns" ON public.whatsapp_campaigns
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated write whatsapp_campaigns" ON public.whatsapp_campaigns;
CREATE POLICY "Allow authenticated write whatsapp_campaigns" ON public.whatsapp_campaigns
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow authenticated read whatsapp_campaign_recipients" ON public.whatsapp_campaign_recipients;
CREATE POLICY "Allow authenticated read whatsapp_campaign_recipients" ON public.whatsapp_campaign_recipients
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow authenticated write whatsapp_campaign_recipients" ON public.whatsapp_campaign_recipients;
CREATE POLICY "Allow authenticated write whatsapp_campaign_recipients" ON public.whatsapp_campaign_recipients
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

