/*
  # Pricing Phase 3 — Email Automation Foundation

  1. email_thread_map — maps Gmail thread/message IDs to price_request_id and item IDs
     for future parser-driven sourcing reply ingestion.
  2. sourcing_parser_results — stores parsed email content pending human review before
     any price_request_items are updated.
  3. RLS policies for both tables.
  4. crm_inquiries: add price_ready boolean column (synced by app when final quote entered).

  Safe to re-run. All IF NOT EXISTS / OR REPLACE.
*/

-- ────────────────────────────────────────────────────────────────────────────
-- 1. email_thread_map
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_thread_map (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  price_request_id      uuid REFERENCES price_requests(id) ON DELETE CASCADE,
  item_ids              uuid[],                        -- which price_request_items this thread covers
  gmail_thread_id       text,
  gmail_message_id      text,
  source_type           text,                          -- 'india' | 'china' | null
  direction             text DEFAULT 'outbound',       -- 'outbound' | 'inbound'
  subject               text,
  sent_at               timestamptz,
  reply_received_at     timestamptz,
  created_by            uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_thread_map_pr ON email_thread_map(price_request_id);
CREATE INDEX IF NOT EXISTS idx_email_thread_map_thread ON email_thread_map(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

ALTER TABLE email_thread_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_thread_map_read"   ON email_thread_map;
DROP POLICY IF EXISTS "email_thread_map_insert" ON email_thread_map;
DROP POLICY IF EXISTS "email_thread_map_update" ON email_thread_map;

CREATE POLICY "email_thread_map_read" ON email_thread_map
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

CREATE POLICY "email_thread_map_insert" ON email_thread_map
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

CREATE POLICY "email_thread_map_update" ON email_thread_map
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['admin', 'manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- 2. sourcing_parser_results — pending review queue for AI-parsed replies
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sourcing_parser_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_thread_map_id   uuid REFERENCES email_thread_map(id) ON DELETE CASCADE,
  price_request_id      uuid REFERENCES price_requests(id) ON DELETE CASCADE,
  price_request_item_id uuid REFERENCES price_request_items(id) ON DELETE CASCADE,
  -- Parsed fields (suggestions — not yet applied)
  suggested_source_price    numeric,
  suggested_source_currency text,
  suggested_doc_status      text,
  suggested_remarks         text,
  raw_snippet               text,     -- excerpt from email body used for parsing
  confidence                numeric,  -- 0.0 – 1.0
  -- Review workflow
  review_status   text NOT NULL DEFAULT 'pending_review'
    CHECK (review_status IN ('pending_review', 'accepted', 'rejected')),
  reviewed_by     uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  review_notes    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parser_results_pr    ON sourcing_parser_results(price_request_id);
CREATE INDEX IF NOT EXISTS idx_parser_results_item  ON sourcing_parser_results(price_request_item_id);
CREATE INDEX IF NOT EXISTS idx_parser_results_status ON sourcing_parser_results(review_status);

ALTER TABLE sourcing_parser_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "parser_results_read"   ON sourcing_parser_results;
DROP POLICY IF EXISTS "parser_results_insert" ON sourcing_parser_results;
DROP POLICY IF EXISTS "parser_results_update" ON sourcing_parser_results;

CREATE POLICY "parser_results_read" ON sourcing_parser_results
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin', 'manager', 'sales']));

CREATE POLICY "parser_results_insert" ON sourcing_parser_results
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

CREATE POLICY "parser_results_update" ON sourcing_parser_results
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['admin', 'manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin', 'manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- 3. crm_inquiries: price_ready column
--    True when all items in the linked price_request have final_quote_price set.
--    Synced by the app (PricingDesk) when entering final quote.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE crm_inquiries ADD COLUMN IF NOT EXISTS price_ready boolean NOT NULL DEFAULT false;

-- Allow manager role to update crm_inquiries (needed for price_ready sync from PricingDesk).
-- The existing policy only covers admin + sales; add a separate manager policy.
DROP POLICY IF EXISTS "crm_inquiries_update_manager" ON crm_inquiries;
CREATE POLICY "crm_inquiries_update_manager" ON crm_inquiries
  FOR UPDATE TO authenticated
  USING  (current_user_has_pricing_role(ARRAY['manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['manager']));

-- ────────────────────────────────────────────────────────────────────────────
-- 4. updated_at triggers (idempotent)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_email_thread_map_updated_at ON email_thread_map;
CREATE TRIGGER trg_email_thread_map_updated_at
  BEFORE UPDATE ON email_thread_map
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_sourcing_parser_results_updated_at ON sourcing_parser_results;
CREATE TRIGGER trg_sourcing_parser_results_updated_at
  BEFORE UPDATE ON sourcing_parser_results
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
