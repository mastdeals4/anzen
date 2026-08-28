/*
  # email_inquiry_links — connect Gmail messages/threads to CRM inquiries
  #                       by link type (customer_inquiry / source_reply /
  #                       customer_quote)

  Existing coverage:
    * crm_email_inbox.message_id / .thread_id      — inbound Gmail metadata
    * crm_email_inbox.converted_to_inquiry          — link to first inquiry
    * email_thread_map                              — links Gmail thread → price_request_id
    * crm_email_activities.inquiry_id               — sent activity log

  Missing: a per-inquiry per-link-type record. One Gmail thread can map to
  many CRM inquiries (multi-product .1/.2/.3) and the SAME thread may carry
  the original customer inquiry, the supplier source reply, and the
  outbound customer quote. We need a row per link.

  Idempotent. Additive only. No destructive changes.
*/

CREATE TABLE IF NOT EXISTS email_inquiry_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id    text,
  gmail_thread_id     text,
  inquiry_id          uuid NOT NULL REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  link_type           text NOT NULL,
  source_reply_parser_run_at  timestamptz,
  parser_confidence   numeric,                      -- 0..1, from AI parser if applicable
  created_by          uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_inquiry_links_type_chk') THEN
    EXECUTE 'ALTER TABLE email_inquiry_links DROP CONSTRAINT email_inquiry_links_type_chk';
  END IF;
  EXECUTE $X$
    ALTER TABLE email_inquiry_links
      ADD CONSTRAINT email_inquiry_links_type_chk
      CHECK (link_type IN ('customer_inquiry','source_reply','customer_quote','reminder','generic'))
  $X$;
END $$;

CREATE INDEX IF NOT EXISTS idx_eil_inquiry  ON email_inquiry_links(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_eil_thread   ON email_inquiry_links(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eil_message  ON email_inquiry_links(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eil_type     ON email_inquiry_links(link_type);

ALTER TABLE email_inquiry_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "eil_read"   ON email_inquiry_links;
DROP POLICY IF EXISTS "eil_insert" ON email_inquiry_links;
DROP POLICY IF EXISTS "eil_update" ON email_inquiry_links;
DROP POLICY IF EXISTS "eil_delete" ON email_inquiry_links;

-- Read: admin/manager always; sales only when they can access the linked
-- inquiry. We check the linked crm_inquiries row's ownership (created_by /
-- sales_member_id assignment is on the inquiry row itself, not here).
CREATE POLICY "eil_read" ON email_inquiry_links
  FOR SELECT TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['admin','manager'])
    OR (
      current_user_has_pricing_role(ARRAY['sales'])
      AND EXISTS (
        SELECT 1 FROM crm_inquiries ci
         WHERE ci.id = email_inquiry_links.inquiry_id
      )
    )
  );

-- Write: admin/manager only — sales never writes link rows directly. The
-- Source Reply parser and Customer Quote flow both run as admin/manager.
CREATE POLICY "eil_insert" ON email_inquiry_links
  FOR INSERT TO authenticated
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "eil_update" ON email_inquiry_links
  FOR UPDATE TO authenticated
  USING      (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "eil_delete" ON email_inquiry_links
  FOR DELETE TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));
