/*
  # Kunal AI Email Review Queue

  Purpose:
    Persistent memory for the AI India Price Review mailbox inside Kunal Pricing.
    Tracks which Gmail messages have already been scanned/classified so the
    auto-mailbox can skip them on next page open. Stores the AI classifier /
    extractor result as a pending review until Kunal explicitly confirms
    Save India Price / Save Document / No Action.

  Why a new table:
    Existing candidates checked first and rejected:
      - email_inquiry_links     -> link_type CHECK constraint is locked to
                                   {customer_inquiry, source_reply, customer_quote,
                                    reminder, generic}; cannot represent the AI
                                   review states this feature needs.
      - email_thread_map        -> FK to price_requests; Anvi pricing world.
      - crm_email_inbox         -> CRM-owned (is_inquiry, converted_to_inquiry);
                                   the user explicitly said do NOT touch CRM.
      - sourcing_parser_results -> FK to price_requests / price_request_items;
                                   Anvi sourcing world.

  Does NOT modify any other table or CHECK constraint.
*/

CREATE TABLE IF NOT EXISTS public.kunal_ai_email_reviews (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id    text NOT NULL UNIQUE,
  gmail_thread_id     text,
  from_email          text,
  subject             text,
  email_date          timestamptz,
  ai_type             text,
  ai_status           text,
  product_name        text,
  offered_make        text,
  source_price        numeric,
  source_currency     text,
  matched_inquiry_id  uuid REFERENCES public.crm_inquiries(id) ON DELETE SET NULL,
  confidence          numeric,
  summary             text,
  suggested_action    text,
  has_attachments     boolean DEFAULT false,
  action_status       text NOT NULL DEFAULT 'pending_review',
  raw_result          jsonb,
  scanned_by          uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  scanned_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kunal_ai_email_reviews_action_status_chk
    CHECK (action_status IN ('pending_review', 'price_saved', 'document_saved', 'no_action', 'needs_manual_link'))
);

CREATE INDEX IF NOT EXISTS idx_kunal_ai_reviews_message ON public.kunal_ai_email_reviews(gmail_message_id);
CREATE INDEX IF NOT EXISTS idx_kunal_ai_reviews_status  ON public.kunal_ai_email_reviews(action_status);
CREATE INDEX IF NOT EXISTS idx_kunal_ai_reviews_date    ON public.kunal_ai_email_reviews(email_date DESC);
CREATE INDEX IF NOT EXISTS idx_kunal_ai_reviews_inquiry ON public.kunal_ai_email_reviews(matched_inquiry_id) WHERE matched_inquiry_id IS NOT NULL;

ALTER TABLE public.kunal_ai_email_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kunal_ai_reviews_select ON public.kunal_ai_email_reviews;
CREATE POLICY kunal_ai_reviews_select ON public.kunal_ai_email_reviews
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('admin', 'manager')
        AND COALESCE(up.is_active, true) = true
    )
  );

DROP POLICY IF EXISTS kunal_ai_reviews_insert ON public.kunal_ai_email_reviews;
CREATE POLICY kunal_ai_reviews_insert ON public.kunal_ai_email_reviews
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('admin', 'manager')
        AND COALESCE(up.is_active, true) = true
    )
  );

DROP POLICY IF EXISTS kunal_ai_reviews_update ON public.kunal_ai_email_reviews;
CREATE POLICY kunal_ai_reviews_update ON public.kunal_ai_email_reviews
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('admin', 'manager')
        AND COALESCE(up.is_active, true) = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = auth.uid()
        AND up.role IN ('admin', 'manager')
        AND COALESCE(up.is_active, true) = true
    )
  );

-- Touch updated_at on every UPDATE
CREATE OR REPLACE FUNCTION public.set_kunal_ai_reviews_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kunal_ai_reviews_updated_at ON public.kunal_ai_email_reviews;
CREATE TRIGGER trg_kunal_ai_reviews_updated_at
  BEFORE UPDATE ON public.kunal_ai_email_reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.set_kunal_ai_reviews_updated_at();
