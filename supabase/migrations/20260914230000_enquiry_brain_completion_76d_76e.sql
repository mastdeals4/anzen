-- ============================================================================
-- Migration: 20260914230000_enquiry_brain_completion_76d_76e.sql
-- Description: Phase 7.6D (AI Reply Drafter) and Phase 7.6E (Document Intelligence)
--
-- 1. Adds ai_reply_draft to public.enquiry_conversation_messages
-- 2. Adds ai_extraction to public.crm_product_documents
-- 3. Updates fn_protect_enquiry_message_content to permit ai_reply_draft updates
-- 4. Creates atomic document review RPCs:
--    - accept_document_extraction_atomic
--    - edit_document_extraction_atomic
--    - dismiss_document_extraction_atomic
-- ============================================================================

-- 1. Add ai_reply_draft column to enquiry_conversation_messages
ALTER TABLE public.enquiry_conversation_messages
ADD COLUMN IF NOT EXISTS ai_reply_draft JSONB DEFAULT NULL;

-- 2. Add ai_extraction column to crm_product_documents
ALTER TABLE public.crm_product_documents
ADD COLUMN IF NOT EXISTS ai_extraction JSONB DEFAULT NULL;

-- 3. Update message content immutability trigger to permit ai_reply_draft
CREATE OR REPLACE FUNCTION public.fn_protect_enquiry_message_content()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Content fields must be immutable. Only ai_processed, ai_summary, ai_proposal, and ai_reply_draft may change.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.external_message_id IS DISTINCT FROM OLD.external_message_id
     OR NEW.sender_address IS DISTINCT FROM OLD.sender_address
     OR NEW.recipient_addresses IS DISTINCT FROM OLD.recipient_addresses
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.body_text IS DISTINCT FROM OLD.body_text
     OR NEW.body_html IS DISTINCT FROM OLD.body_html
     OR NEW.attachments IS DISTINCT FROM OLD.attachments
     OR NEW.received_or_sent_at IS DISTINCT FROM OLD.received_or_sent_at
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
  THEN
    RAISE EXCEPTION 'Communication content in enquiry_conversation_messages is immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Atomic Document Review RPC: Accept
CREATE OR REPLACE FUNCTION public.accept_document_extraction_atomic(
  p_document_id UUID,
  p_actor_id UUID,
  p_apply_to_request_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  -- If request linking is requested, associate document with the request if not already linked
  IF p_apply_to_request_id IS NOT NULL THEN
    UPDATE public.crm_product_documents
    SET enquiry_request_id = p_apply_to_request_id
    WHERE id = p_document_id AND enquiry_request_id IS NULL;
  END IF;

  -- Update extraction status to accepted, recording human reviewer and timestamp
  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        v_extraction,
        '{status}',
        '"accepted"'::jsonb
      ),
      '{reviewed_by}',
      to_jsonb(p_actor_id::text)
    ),
    '{reviewed_at}',
    to_jsonb(v_now::text)
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'accepted',
    'reviewed_at', v_now
  );
END;
$$;

-- 5. Atomic Document Review RPC: Edit
CREATE OR REPLACE FUNCTION public.edit_document_extraction_atomic(
  p_document_id UUID,
  p_actor_id UUID,
  p_edited_values JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_original JSONB;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  -- Preserve original extraction if not already preserved
  v_original := COALESCE(v_extraction->'original_extraction', v_extraction);

  -- Update with human edits
  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            v_extraction,
            '{status}',
            '"edited"'::jsonb
          ),
          '{reviewed_by}',
          to_jsonb(p_actor_id::text)
        ),
        '{reviewed_at}',
        to_jsonb(v_now::text)
      ),
      '{edited_values}',
      p_edited_values
    ),
    '{original_extraction}',
    v_original
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'edited',
    'reviewed_at', v_now
  );
END;
$$;

-- 6. Atomic Document Review RPC: Dismiss
CREATE OR REPLACE FUNCTION public.dismiss_document_extraction_atomic(
  p_document_id UUID,
  p_actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doc public.crm_product_documents%ROWTYPE;
  v_extraction JSONB;
  v_status TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  -- Lock the document row
  SELECT * INTO v_doc
  FROM public.crm_product_documents
  WHERE id = p_document_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DOCUMENT_NOT_FOUND: Document % not found', p_document_id;
  END IF;

  v_extraction := v_doc.ai_extraction;
  IF v_extraction IS NULL THEN
    RAISE EXCEPTION 'NO_EXTRACTION: No AI extraction exists for document %', p_document_id;
  END IF;

  v_status := v_extraction->>'status';
  IF v_status IN ('accepted', 'dismissed') THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_PROCESSED: Extraction for document % has already been reviewed (status: %)', p_document_id, v_status;
  END IF;

  UPDATE public.crm_product_documents
  SET ai_extraction = jsonb_set(
    jsonb_set(
      jsonb_set(
        v_extraction,
        '{status}',
        '"dismissed"'::jsonb
      ),
      '{dismissed_by}',
      to_jsonb(p_actor_id::text)
    ),
    '{dismissed_at}',
    to_jsonb(v_now::text)
  )
  WHERE id = p_document_id;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'status', 'dismissed',
    'dismissed_at', v_now
  );
END;
$$;

-- Grants
GRANT EXECUTE ON FUNCTION public.accept_document_extraction_atomic(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.edit_document_extraction_atomic(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_document_extraction_atomic(UUID, UUID) TO authenticated;
