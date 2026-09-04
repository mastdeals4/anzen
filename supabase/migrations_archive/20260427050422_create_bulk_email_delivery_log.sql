/*
  # Bulk Email Delivery Log

  ## Summary
  Creates persistent storage for bulk email campaigns so failed/partial deliveries
  are not lost when the user closes the modal.

  ## New Tables

  ### bulk_email_campaigns
  One row per "Send" action. Tracks the overall campaign metadata.
  - id, subject, total_recipients, sent_count, failed_count
  - status: 'in_progress' | 'completed' | 'partial' | 'failed'
  - started_at, completed_at
  - created_by (user who triggered the send)

  ### bulk_email_recipients
  One row per recipient per campaign. Tracks individual delivery outcomes.
  - campaign_id (FK to bulk_email_campaigns)
  - contact_id (FK to crm_contacts)
  - company_name, email
  - status: 'pending' | 'sent' | 'failed'
  - error_message (populated when status = 'failed')
  - sent_at

  ## Security
  - RLS enabled on both tables
  - Authenticated users can read/insert their own campaigns
*/

CREATE TABLE IF NOT EXISTS bulk_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL,
  total_recipients integer NOT NULL DEFAULT 0,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'partial', 'failed')),
  has_attachments boolean NOT NULL DEFAULT false,
  template_id uuid REFERENCES crm_email_templates(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bulk_email_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES bulk_email_campaigns(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES crm_contacts(id) ON DELETE SET NULL,
  company_name text NOT NULL DEFAULT '',
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_email_campaigns_created_by ON bulk_email_campaigns(created_by);
CREATE INDEX IF NOT EXISTS idx_bulk_email_campaigns_started_at ON bulk_email_campaigns(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_email_recipients_campaign_id ON bulk_email_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_bulk_email_recipients_status ON bulk_email_recipients(campaign_id, status);

ALTER TABLE bulk_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_email_recipients ENABLE ROW LEVEL SECURITY;

-- Campaigns: authenticated users can see all campaigns (shared visibility for team)
CREATE POLICY "Authenticated users can view campaigns"
  ON bulk_email_campaigns FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert campaigns"
  ON bulk_email_campaigns FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Campaign owner can update campaign"
  ON bulk_email_campaigns FOR UPDATE
  TO authenticated
  USING (auth.uid() = created_by)
  WITH CHECK (auth.uid() = created_by);

-- Recipients: authenticated users can see all recipient rows
CREATE POLICY "Authenticated users can view recipients"
  ON bulk_email_recipients FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert recipients"
  ON bulk_email_recipients FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bulk_email_campaigns
      WHERE id = campaign_id AND created_by = auth.uid()
    )
  );

CREATE POLICY "Authenticated users can update recipients"
  ON bulk_email_recipients FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM bulk_email_campaigns
      WHERE id = campaign_id AND created_by = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM bulk_email_campaigns
      WHERE id = campaign_id AND created_by = auth.uid()
    )
  );
