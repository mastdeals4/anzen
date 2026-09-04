-- Add audit fields to track which inquiries have been sent to the India team.
-- These are purely informational — no workflow status changes.

ALTER TABLE crm_inquiries
  ADD COLUMN IF NOT EXISTS sent_to_india      boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sent_to_india_at   timestamptz,
  ADD COLUMN IF NOT EXISTS sent_to_india_by   uuid REFERENCES user_profiles(id);

CREATE INDEX IF NOT EXISTS idx_crm_inquiries_sent_to_india ON crm_inquiries (sent_to_india)
  WHERE sent_to_india = true;
