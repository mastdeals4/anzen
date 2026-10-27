ALTER TABLE bulk_email_campaigns
  ADD COLUMN IF NOT EXISTS email_body text,
  ADD COLUMN IF NOT EXISTS sender_name text,
  ADD COLUMN IF NOT EXISTS attachments_context jsonb NOT NULL DEFAULT '[]'::jsonb;
