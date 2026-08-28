/*
  # CRM Master Sheet + Kunal Pricing Worksheet — backing schema

  This migration adds the minimal columns/tables needed to:
    1. Track inquiry-level pricing workflow status directly on crm_inquiries
       (instead of duplicating into price_requests). crm_inquiries remains
       the master sheet.
    2. Allow Kunal to record one or many India/China offered options per
       inquiry (alternate makes, NA, docs pending) and pick one final.
    3. Power compact dashboard counts (Anvi / Kunal) without recomputing.

  Idempotent and additive only:
    * No column drops.
    * No data rewrites.
    * No existing policies touched.

  Existing fields preserved:
    crm_inquiries already has price_ready, pipeline_status, priority,
    purchase_price, offered_price, mail_subject, aceerp_no, specification,
    coa_required, sample_required, etc. We use those — and only add what
    is genuinely missing.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Status fields on crm_inquiries (compact, app-managed)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  source_status text NOT NULL DEFAULT 'not_sent';      -- not_sent | sent | waiting_reply | partial_received | received | unavailable
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  document_status text NOT NULL DEFAULT 'not_required'; -- not_required | pending | partial | received
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  kunal_price_status text NOT NULL DEFAULT 'pending';   -- pending | entered
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  quote_status text NOT NULL DEFAULT 'not_sent';        -- not_sent | sent | follow_up_due | won | lost
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  reminder_count integer NOT NULL DEFAULT 0;
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  last_sourcing_sent_at timestamptz;
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  last_reminder_sent_at timestamptz;
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  quote_sent_at timestamptz;
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS
  source_type text;  -- india | china | local | unknown — preferred sourcing route

-- Soft text CHECK constraints — drop any old version then add anew (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_inquiries_source_status_chk') THEN
    EXECUTE 'ALTER TABLE crm_inquiries DROP CONSTRAINT crm_inquiries_source_status_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE crm_inquiries
      ADD CONSTRAINT crm_inquiries_source_status_chk
      CHECK (source_status IN ('not_sent','sent','waiting_reply','partial_received','received','unavailable'))
  $X$;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_inquiries_document_status_chk') THEN
    EXECUTE 'ALTER TABLE crm_inquiries DROP CONSTRAINT crm_inquiries_document_status_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE crm_inquiries
      ADD CONSTRAINT crm_inquiries_document_status_chk
      CHECK (document_status IN ('not_required','pending','partial','received'))
  $X$;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_inquiries_kunal_price_status_chk') THEN
    EXECUTE 'ALTER TABLE crm_inquiries DROP CONSTRAINT crm_inquiries_kunal_price_status_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE crm_inquiries
      ADD CONSTRAINT crm_inquiries_kunal_price_status_chk
      CHECK (kunal_price_status IN ('pending','entered'))
  $X$;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_inquiries_quote_status_chk') THEN
    EXECUTE 'ALTER TABLE crm_inquiries DROP CONSTRAINT crm_inquiries_quote_status_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE crm_inquiries
      ADD CONSTRAINT crm_inquiries_quote_status_chk
      CHECK (quote_status IN ('not_sent','sent','follow_up_due','won','lost'))
  $X$;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_inquiries_source_status   ON crm_inquiries(source_status);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_kunal_price     ON crm_inquiries(kunal_price_status);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_quote_status    ON crm_inquiries(quote_status);
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_price_ready     ON crm_inquiries(price_ready);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. crm_inquiry_pricing_options — one row per India/China offered option
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crm_inquiry_pricing_options (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id               uuid NOT NULL REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  source_type              text NOT NULL DEFAULT 'india',     -- india | china | local
  offered_make             text,                              -- the brand/manufacturer offered
  source_price             numeric,
  source_currency          text NOT NULL DEFAULT 'USD',
  availability             text NOT NULL DEFAULT 'available', -- available | na | partial
  document_status          text NOT NULL DEFAULT 'pending',   -- not_required | pending | partial | received
  remark                   text,
  is_selected              boolean NOT NULL DEFAULT false,    -- Kunal picks one final option
  confidence               numeric,                           -- 0..1 if parsed
  parser_result_id         uuid REFERENCES sourcing_parser_results(id) ON DELETE SET NULL,
  created_by               uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_options_inquiry ON crm_inquiry_pricing_options(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_pricing_options_selected ON crm_inquiry_pricing_options(inquiry_id, is_selected) WHERE is_selected = true;

ALTER TABLE crm_inquiry_pricing_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pricing_options_read"   ON crm_inquiry_pricing_options;
DROP POLICY IF EXISTS "pricing_options_insert" ON crm_inquiry_pricing_options;
DROP POLICY IF EXISTS "pricing_options_update" ON crm_inquiry_pricing_options;
DROP POLICY IF EXISTS "pricing_options_delete" ON crm_inquiry_pricing_options;

-- Read: admin/manager/sales (sales sees options for context, but their UI
-- only exposes prices on rows they own — the table itself stays readable
-- so the CRM master can render badges).
CREATE POLICY "pricing_options_read" ON crm_inquiry_pricing_options
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager','sales']));

-- Insert/update/delete: admin/manager only (Kunal workbench writes).
CREATE POLICY "pricing_options_insert" ON crm_inquiry_pricing_options
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_options_update" ON crm_inquiry_pricing_options
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "pricing_options_delete" ON crm_inquiry_pricing_options
  FOR DELETE TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));

-- updated_at trigger
DROP TRIGGER IF EXISTS trg_pricing_options_updated_at ON crm_inquiry_pricing_options;
CREATE TRIGGER trg_pricing_options_updated_at
  BEFORE UPDATE ON crm_inquiry_pricing_options
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. pricing_ledger — add inquiry linkage so Kunal worksheet writes per-inquiry
--    rows directly without going through price_request_items.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE SET NULL;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS aceerp_no text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS preferred_make text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS offered_make text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS purchase_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS selling_price numeric;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS kunal_remark text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS import_data_reference text;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS final_selected_option_id uuid REFERENCES crm_inquiry_pricing_options(id) ON DELETE SET NULL;
ALTER TABLE pricing_ledger ADD COLUMN IF NOT EXISTS quoted_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pricing_ledger_inquiry ON pricing_ledger(inquiry_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Backfill: derive source_status from existing pipeline_status / price_ready
--    so the new field is meaningful for already-existing inquiries.
--    Read-only inference — never overwrites a non-default value.
-- ────────────────────────────────────────────────────────────────────────────
UPDATE crm_inquiries
   SET source_status = 'received'
 WHERE source_status = 'not_sent'
   AND price_ready = true;

UPDATE crm_inquiries
   SET kunal_price_status = 'entered'
 WHERE kunal_price_status = 'pending'
   AND purchase_price IS NOT NULL
   AND offered_price  IS NOT NULL;

-- quote_status inference from existing pipeline_status, if used
UPDATE crm_inquiries
   SET quote_status = 'sent'
 WHERE quote_status = 'not_sent'
   AND price_sent_at IS NOT NULL;

UPDATE crm_inquiries
   SET quote_status = 'won'
 WHERE quote_status IN ('not_sent','sent')
   AND pipeline_status = 'won';

UPDATE crm_inquiries
   SET quote_status = 'lost'
 WHERE quote_status IN ('not_sent','sent')
   AND pipeline_status = 'lost';
