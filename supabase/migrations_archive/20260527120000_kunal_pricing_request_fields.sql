/*
  # CRM Master — Kunal pricing handoff fields

  Safe/idempotent migration for routing CRM inquiry rows into the Kunal
  Pricing worksheet without creating duplicate price request records.
*/

ALTER TABLE crm_inquiries
  ADD COLUMN IF NOT EXISTS kunal_pricing_requested_at timestamptz;

ALTER TABLE crm_inquiries
  ADD COLUMN IF NOT EXISTS kunal_pricing_requested_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;

ALTER TABLE crm_inquiries
  ADD COLUMN IF NOT EXISTS kunal_pricing_note text;

CREATE INDEX IF NOT EXISTS idx_crm_inquiries_kunal_pricing_requested
  ON crm_inquiries(kunal_pricing_requested_at)
  WHERE kunal_pricing_requested_at IS NOT NULL;
