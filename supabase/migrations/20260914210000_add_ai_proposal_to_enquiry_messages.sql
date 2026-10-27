-- ============================================================================
-- Migration: 20260914210000_add_ai_proposal_to_enquiry_messages.sql
-- Description: Phase 7.6A - Add ai_proposal storage to enquiry_conversation_messages
-- 
-- Stores structured Enquiry Brain interpretations separately from authoritative
-- business state. Unaccepted AI proposals never mutate enquiry_requests.
-- ============================================================================

BEGIN;

ALTER TABLE public.enquiry_conversation_messages
  ADD COLUMN IF NOT EXISTS ai_proposal JSONB DEFAULT NULL;

-- Optional index for finding pending or unreviewed proposals
CREATE INDEX IF NOT EXISTS idx_enq_msg_ai_proposal_status
  ON public.enquiry_conversation_messages((ai_proposal->>'status'))
  WHERE ai_proposal IS NOT NULL;

COMMIT;
