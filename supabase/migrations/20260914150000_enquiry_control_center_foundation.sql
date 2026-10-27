-- ============================================================================
-- Migration: 20260914150000_enquiry_control_center_foundation.sql
-- Description: Phase 4 Enquiry Control Center Database Foundation
-- 
-- Exactly SIX new tables:
--   1. public.enquiry_conversations
--   2. public.enquiry_conversation_links
--   3. public.enquiry_conversation_messages
--   4. public.enquiry_requests
--   5. public.enquiry_request_events
--   6. public.enquiry_request_messages
--
-- Exactly ONE existing table modification:
--   public.crm_product_documents (adds nullable enquiry_request_id FK + index)
--
-- Zero changes to crm_inquiries, crm_inquiry_items, tasks, or pricing tables.
-- Zero business logic, triggers, or backfill.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. enquiry_conversations
-- ============================================================================
CREATE TABLE public.enquiry_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  crm_contact_id UUID REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'internal')),
  external_thread_id TEXT,
  title TEXT NOT NULL,
  participant_identifiers TEXT[] NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'spam')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Channel-scoped conversation identity uniqueness
CREATE UNIQUE INDEX uq_enq_conv_channel_external_thread
  ON public.enquiry_conversations(channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

-- Operational indexes
CREATE INDEX idx_enq_conv_customer_id ON public.enquiry_conversations(customer_id);
CREATE INDEX idx_enq_conv_last_message ON public.enquiry_conversations(last_message_at DESC);

-- ============================================================================
-- 2. enquiry_conversation_links
-- ============================================================================
CREATE TABLE public.enquiry_conversation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.enquiry_conversations(id) ON DELETE CASCADE,
  inquiry_id UUID NOT NULL REFERENCES public.crm_inquiries(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'related' CHECK (link_type IN ('primary', 'related', 'reference')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation_inquiry UNIQUE (conversation_id, inquiry_id)
);

-- Single active primary conversation per enquiry
CREATE UNIQUE INDEX uq_enquiry_single_active_primary_conv
  ON public.enquiry_conversation_links(inquiry_id)
  WHERE link_type = 'primary' AND is_active = true;

-- Operational indexes
CREATE INDEX idx_enq_conv_links_inq_id ON public.enquiry_conversation_links(inquiry_id);
CREATE INDEX idx_enq_conv_links_conv_id ON public.enquiry_conversation_links(conversation_id);

-- ============================================================================
-- 3. enquiry_conversation_messages
-- ============================================================================
CREATE TABLE public.enquiry_conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.enquiry_conversations(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp', 'internal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  external_message_id TEXT,
  sender_address TEXT NOT NULL,
  sender_name TEXT,
  recipient_addresses TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB,
  received_or_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'ai')),
  actor_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ai_processed BOOLEAN NOT NULL DEFAULT false,
  ai_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Message-level idempotency uniqueness
CREATE UNIQUE INDEX uq_enq_msg_channel_external_id
  ON public.enquiry_conversation_messages(channel, external_message_id)
  WHERE external_message_id IS NOT NULL;

-- Operational index
CREATE INDEX idx_enq_msg_conv_received ON public.enquiry_conversation_messages(conversation_id, received_or_sent_at DESC);

-- ============================================================================
-- 4. enquiry_requests
-- ============================================================================
CREATE TABLE public.enquiry_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id UUID NOT NULL REFERENCES public.crm_inquiries(id) ON DELETE RESTRICT,
  inquiry_item_id UUID REFERENCES public.crm_inquiry_items(id) ON DELETE SET NULL,
  product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
  product_name_raw TEXT,
  
  category TEXT NOT NULL CHECK (category IN (
    'commercial',
    'technical',
    'document',
    'sample',
    'logistics',
    'custom'
  )),
  request_code TEXT NOT NULL,
  title TEXT NOT NULL,
  customer_requirement TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,

  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN',
    'IN_PROGRESS',
    'BLOCKED',
    'RESOLVED',
    'NOT_POSSIBLE',
    'NOT_REQUIRED',
    'CANCELLED'
  )),
  waiting_for TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (waiting_for IN (
    'INTERNAL',
    'INDIA',
    'MANUFACTURER',
    'CUSTOMER',
    'NONE'
  )),
  current_issue TEXT,
  next_action TEXT,

  assigned_to UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  assigned_team TEXT CHECK (assigned_team IN (
    'sales', 'pricing_india', 'regulatory', 'warehouse', 'sourcing', 'management'
  )),

  due_at TIMESTAMPTZ,
  reminder_level INT NOT NULL DEFAULT 0 CHECK (reminder_level BETWEEN 0 AND 4),
  last_reminded_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,

  source_message_id UUID REFERENCES public.enquiry_conversation_messages(id) ON DELETE SET NULL,
  ai_status TEXT NOT NULL DEFAULT 'manual' CHECK (ai_status IN ('manual', 'suggested', 'confirmed', 'rejected', 'edited')),
  ai_confidence NUMERIC(4,3),
  ai_extracted_text TEXT,
  confirmed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,

  response_text TEXT,
  response_value JSONB,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operational indexes
CREATE INDEX idx_enq_req_inquiry_id ON public.enquiry_requests(inquiry_id);
CREATE INDEX idx_enq_req_item_id ON public.enquiry_requests(inquiry_item_id) WHERE inquiry_item_id IS NOT NULL;
CREATE INDEX idx_enq_req_product_id ON public.enquiry_requests(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_enq_req_status_waiting ON public.enquiry_requests(status, waiting_for);
CREATE INDEX idx_enq_req_assigned ON public.enquiry_requests(assigned_to, assigned_team) WHERE status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED');
CREATE INDEX idx_enq_req_due_at ON public.enquiry_requests(due_at) WHERE status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED');
CREATE INDEX idx_enq_req_ai_status ON public.enquiry_requests(ai_status) WHERE ai_status = 'suggested';
CREATE INDEX idx_enq_req_source_msg ON public.enquiry_requests(source_message_id) WHERE source_message_id IS NOT NULL;

-- ============================================================================
-- 5. enquiry_request_events
-- ============================================================================
CREATE TABLE public.enquiry_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.enquiry_requests(id) ON DELETE CASCADE,
  inquiry_id UUID NOT NULL REFERENCES public.crm_inquiries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created',
    'requirement_changed',
    'supplier_response',
    'customer_decision',
    'status_changed',
    'waiting_for_changed',
    'owner_reassigned',
    'escalated',
    'resolved',
    'cancelled'
  )),
  summary TEXT NOT NULL,
  old_status TEXT,
  new_status TEXT,
  old_waiting_for TEXT,
  new_waiting_for TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_message_id UUID REFERENCES public.enquiry_conversation_messages(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'ai')),
  actor_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operational indexes
CREATE INDEX idx_enq_req_events_req_created ON public.enquiry_request_events(request_id, created_at DESC);
CREATE INDEX idx_enq_req_events_inq_created ON public.enquiry_request_events(inquiry_id, created_at DESC);

-- ============================================================================
-- 6. enquiry_request_messages
-- ============================================================================
CREATE TABLE public.enquiry_request_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.enquiry_requests(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.enquiry_conversation_messages(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN (
    'originated',
    'clarified',
    'blocked',
    'resolved',
    'referenced'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_request_message UNIQUE (request_id, message_id, relationship)
);

CREATE INDEX idx_enq_req_msg_lookup ON public.enquiry_request_messages(request_id, message_id);

-- ============================================================================
-- 7. Modify Existing Table: crm_product_documents
-- ============================================================================
ALTER TABLE public.crm_product_documents
  ADD COLUMN IF NOT EXISTS enquiry_request_id UUID REFERENCES public.enquiry_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_prod_docs_req_id
  ON public.crm_product_documents(enquiry_request_id)
  WHERE enquiry_request_id IS NOT NULL;

-- ============================================================================
-- 8. Updated_At Triggers (Using Existing ERP Helper)
-- ============================================================================
CREATE TRIGGER trg_enquiry_conversations_updated_at
  BEFORE UPDATE ON public.enquiry_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER trg_enquiry_requests_updated_at
  BEFORE UPDATE ON public.enquiry_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================================
-- 9. Row Level Security (RLS)
-- ============================================================================
ALTER TABLE public.enquiry_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_conversation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_request_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enquiry_request_messages ENABLE ROW LEVEL SECURITY;

-- enquiry_conversations
CREATE POLICY "enquiry_conversations_select"
  ON public.enquiry_conversations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_conversations_insert"
  ON public.enquiry_conversations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversations_update"
  ON public.enquiry_conversations FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversations_delete"
  ON public.enquiry_conversations FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin'));

-- enquiry_conversation_links
CREATE POLICY "enquiry_conversation_links_select"
  ON public.enquiry_conversation_links FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_conversation_links_insert"
  ON public.enquiry_conversation_links FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversation_links_update"
  ON public.enquiry_conversation_links FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversation_links_delete"
  ON public.enquiry_conversation_links FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

-- enquiry_conversation_messages
CREATE POLICY "enquiry_conversation_messages_select"
  ON public.enquiry_conversation_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_conversation_messages_insert"
  ON public.enquiry_conversation_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversation_messages_update"
  ON public.enquiry_conversation_messages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_conversation_messages_delete"
  ON public.enquiry_conversation_messages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin'));

-- enquiry_requests
CREATE POLICY "enquiry_requests_select"
  ON public.enquiry_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_requests_insert"
  ON public.enquiry_requests FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_requests_update"
  ON public.enquiry_requests FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_requests_delete"
  ON public.enquiry_requests FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role = 'admin'));

-- enquiry_request_events (APPEND-ONLY: ZERO UPDATE AND ZERO DELETE POLICIES)
CREATE POLICY "enquiry_request_events_select"
  ON public.enquiry_request_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_request_events_insert"
  ON public.enquiry_request_events FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

-- enquiry_request_messages
CREATE POLICY "enquiry_request_messages_select"
  ON public.enquiry_request_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true));

CREATE POLICY "enquiry_request_messages_insert"
  ON public.enquiry_request_messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_request_messages_update"
  ON public.enquiry_request_messages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

CREATE POLICY "enquiry_request_messages_delete"
  ON public.enquiry_request_messages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales')));

NOTIFY pgrst, 'reload schema';

COMMIT;
