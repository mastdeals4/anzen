-- ============================================================================
-- Migration: 20260914160000_enquiry_service_atomic_rpc.sql
-- Description: Phase 5 Enquiry Service Atomic RPCs and Immutability Protection
--
-- Objects:
--   1. Trigger fn_protect_enquiry_message_content & trg_protect_enquiry_message_content
--   2. Tightened RLS on enquiry_request_messages (remove sales DELETE/UPDATE)
--   3. RPC create_enquiry_request_atomic
--   4. RPC transition_enquiry_request_atomic
--
-- Security:
--   - Strict actor enforcement (browser callers forced to actor_type='user', actor_id=auth.uid())
--   - Role checks: active admin/sales users only, auditor_ca blocked from write
--   - Explicit EXECUTE grants (REVOKE FROM PUBLIC, GRANT TO authenticated, service_role)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Message Communication Content Immutability Protection
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_protect_enquiry_message_content()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM OLD.channel
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

DROP TRIGGER IF EXISTS trg_protect_enquiry_message_content ON public.enquiry_conversation_messages;
CREATE TRIGGER trg_protect_enquiry_message_content
  BEFORE UPDATE ON public.enquiry_conversation_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_protect_enquiry_message_content();

-- ============================================================================
-- 2. Tighten Provenance Policies on enquiry_request_messages
-- ============================================================================
-- Drop existing update and delete policies
DROP POLICY IF EXISTS "enquiry_request_messages_update" ON public.enquiry_request_messages;
DROP POLICY IF EXISTS "enquiry_request_messages_delete" ON public.enquiry_request_messages;

-- Provenance is strictly append-only (SELECT + INSERT) for normal sales users.
-- DELETE is restricted solely to admin. UPDATE is removed completely.
CREATE POLICY "enquiry_request_messages_delete"
  ON public.enquiry_request_messages FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND is_active = true AND role = 'admin'
  ));

-- ============================================================================
-- 3. Atomic Request Creation RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_enquiry_request_atomic(
  p_inquiry_id UUID,
  p_category TEXT,
  p_request_code TEXT,
  p_title TEXT,
  p_customer_requirement TEXT,
  p_parameters JSONB DEFAULT '{}'::jsonb,
  p_assigned_to UUID DEFAULT NULL,
  p_assigned_team TEXT DEFAULT NULL,
  p_due_at TIMESTAMPTZ DEFAULT NULL,
  p_waiting_for TEXT DEFAULT 'INTERNAL',
  p_source_message_id UUID DEFAULT NULL,
  p_ai_status TEXT DEFAULT 'manual',
  p_ai_confidence NUMERIC DEFAULT NULL,
  p_ai_extracted_text TEXT DEFAULT NULL,
  p_actor_type TEXT DEFAULT 'user',
  p_actor_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role TEXT;
  v_caller_auth_uid UUID;
  v_effective_actor_type TEXT;
  v_effective_actor_id UUID;
  v_new_req_id UUID;
  v_user_role TEXT;
BEGIN
  v_caller_role := auth.role();
  v_caller_auth_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE id = v_caller_auth_uid AND is_active = true;

    IF v_user_role IS NULL OR v_user_role NOT IN ('admin', 'sales') THEN
      RAISE EXCEPTION 'Unauthorized: only active admin or sales users can create enquiry requests';
    END IF;

    -- Anti-spoofing guards
    IF p_actor_type IS NOT NULL AND p_actor_type <> 'user' THEN
      RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate AI or system';
    END IF;

    IF p_actor_id IS NOT NULL AND p_actor_id <> v_caller_auth_uid THEN
      RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate other users';
    END IF;

    v_effective_actor_type := 'user';
    v_effective_actor_id := v_caller_auth_uid;

  ELSIF v_caller_role = 'service_role' THEN
    IF p_actor_type NOT IN ('user', 'system', 'ai') THEN
      RAISE EXCEPTION 'Invalid actor_type: must be user, system, or ai';
    END IF;
    v_effective_actor_type := p_actor_type;
    v_effective_actor_id := p_actor_id;

  ELSE
    RAISE EXCEPTION 'Unauthorized: unauthenticated access rejected';
  END IF;

  -- Validate inquiry exists
  IF NOT EXISTS (SELECT 1 FROM public.crm_inquiries WHERE id = p_inquiry_id) THEN
    RAISE EXCEPTION 'Inquiry not found: %', p_inquiry_id;
  END IF;

  -- Insert into enquiry_requests
  INSERT INTO public.enquiry_requests (
    inquiry_id,
    category,
    request_code,
    title,
    customer_requirement,
    parameters,
    assigned_to,
    assigned_team,
    due_at,
    status,
    waiting_for,
    source_message_id,
    ai_status,
    ai_confidence,
    ai_extracted_text
  ) VALUES (
    p_inquiry_id,
    p_category,
    p_request_code,
    p_title,
    p_customer_requirement,
    COALESCE(p_parameters, '{}'::jsonb),
    p_assigned_to,
    p_assigned_team,
    p_due_at,
    'OPEN',
    COALESCE(p_waiting_for, 'INTERNAL'),
    p_source_message_id,
    COALESCE(p_ai_status, 'manual'),
    p_ai_confidence,
    p_ai_extracted_text
  )
  RETURNING id INTO v_new_req_id;

  -- Insert initial 'created' event
  INSERT INTO public.enquiry_request_events (
    request_id,
    inquiry_id,
    event_type,
    summary,
    old_status,
    new_status,
    old_waiting_for,
    new_waiting_for,
    details,
    source_message_id,
    actor_type,
    actor_id
  ) VALUES (
    v_new_req_id,
    p_inquiry_id,
    'created',
    'Request created: ' || p_title,
    NULL,
    'OPEN',
    NULL,
    COALESCE(p_waiting_for, 'INTERNAL'),
    jsonb_build_object(
      'initial_requirement', p_customer_requirement,
      'parameters', COALESCE(p_parameters, '{}'::jsonb)
    ),
    p_source_message_id,
    v_effective_actor_type,
    v_effective_actor_id
  );

  -- Insert provenance if source message provided
  IF p_source_message_id IS NOT NULL THEN
    INSERT INTO public.enquiry_request_messages (
      request_id,
      message_id,
      relationship
    ) VALUES (
      v_new_req_id,
      p_source_message_id,
      'originated'
    )
    ON CONFLICT (request_id, message_id, relationship) DO NOTHING;
  END IF;

  RETURN v_new_req_id;
END;
$$;

-- ============================================================================
-- 4. Atomic Request State Transition RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.transition_enquiry_request_atomic(
  p_request_id UUID,
  p_event_type TEXT,
  p_summary TEXT,
  p_new_status TEXT DEFAULT NULL,
  p_new_waiting_for TEXT DEFAULT NULL,
  p_new_requirement TEXT DEFAULT NULL,
  p_new_parameters JSONB DEFAULT NULL,
  p_current_issue TEXT DEFAULT NULL,
  p_next_action TEXT DEFAULT NULL,
  p_new_assigned_to UUID DEFAULT NULL,
  p_new_assigned_team TEXT DEFAULT NULL,
  p_response_text TEXT DEFAULT NULL,
  p_response_value JSONB DEFAULT NULL,
  p_details JSONB DEFAULT '{}'::jsonb,
  p_source_message_id UUID DEFAULT NULL,
  p_actor_type TEXT DEFAULT 'user',
  p_actor_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_role TEXT;
  v_caller_auth_uid UUID;
  v_effective_actor_type TEXT;
  v_effective_actor_id UUID;
  v_user_role TEXT;

  v_req public.enquiry_requests%ROWTYPE;
  v_effective_status TEXT;
  v_effective_waiting_for TEXT;
  v_effective_requirement TEXT;
  v_effective_parameters JSONB;
  v_effective_assigned_to UUID;
  v_effective_assigned_team TEXT;
  v_effective_current_issue TEXT;
  v_effective_next_action TEXT;
  v_effective_response_text TEXT;
  v_effective_response_value JSONB;
  v_resolved_at TIMESTAMPTZ;
  v_resolved_by UUID;
  v_event_details JSONB;
BEGIN
  v_caller_role := auth.role();
  v_caller_auth_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE id = v_caller_auth_uid AND is_active = true;

    IF v_user_role IS NULL OR v_user_role NOT IN ('admin', 'sales') THEN
      RAISE EXCEPTION 'Unauthorized: only active admin or sales users can update enquiry requests';
    END IF;

    -- Anti-spoofing guards
    IF p_actor_type IS NOT NULL AND p_actor_type <> 'user' THEN
      RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate AI or system';
    END IF;

    IF p_actor_id IS NOT NULL AND p_actor_id <> v_caller_auth_uid THEN
      RAISE EXCEPTION 'Unauthorized: authenticated users cannot impersonate other users';
    END IF;

    v_effective_actor_type := 'user';
    v_effective_actor_id := v_caller_auth_uid;

  ELSIF v_caller_role = 'service_role' THEN
    IF p_actor_type NOT IN ('user', 'system', 'ai') THEN
      RAISE EXCEPTION 'Invalid actor_type: must be user, system, or ai';
    END IF;
    v_effective_actor_type := p_actor_type;
    v_effective_actor_id := p_actor_id;

  ELSE
    RAISE EXCEPTION 'Unauthorized: unauthenticated access rejected';
  END IF;

  -- Validate event_type check constraint
  IF p_event_type NOT IN (
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
  ) THEN
    RAISE EXCEPTION 'Invalid event_type: %', p_event_type;
  END IF;

  -- Row lock target enquiry_requests record
  SELECT * INTO v_req
  FROM public.enquiry_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Enquiry request not found: %', p_request_id;
  END IF;

  -- Resolve effective state values
  v_effective_status := COALESCE(p_new_status, v_req.status);
  v_effective_waiting_for := COALESCE(p_new_waiting_for, v_req.waiting_for);
  v_effective_requirement := COALESCE(p_new_requirement, v_req.customer_requirement);
  v_effective_parameters := COALESCE(p_new_parameters, v_req.parameters);
  v_effective_assigned_to := CASE WHEN p_new_assigned_to IS NOT NULL THEN p_new_assigned_to ELSE v_req.assigned_to END;
  v_effective_assigned_team := CASE WHEN p_new_assigned_team IS NOT NULL THEN p_new_assigned_team ELSE v_req.assigned_team END;
  v_effective_current_issue := CASE WHEN p_current_issue IS NOT NULL THEN p_current_issue ELSE v_req.current_issue END;
  v_effective_next_action := CASE WHEN p_next_action IS NOT NULL THEN p_next_action ELSE v_req.next_action END;
  v_effective_response_text := CASE WHEN p_response_text IS NOT NULL THEN p_response_text ELSE v_req.response_text END;
  v_effective_response_value := CASE WHEN p_response_value IS NOT NULL THEN p_response_value ELSE v_req.response_value END;
  v_resolved_at := v_req.resolved_at;
  v_resolved_by := v_req.resolved_by;

  -- State-specific validations
  IF v_effective_status = 'RESOLVED' THEN
    IF (v_effective_response_text IS NULL OR trim(v_effective_response_text) = '')
       AND (v_effective_response_value IS NULL OR v_effective_response_value = '{}'::jsonb) THEN
      RAISE EXCEPTION 'RESOLVED requests require response_text or response_value';
    END IF;
    v_effective_waiting_for := 'NONE';
    v_resolved_at := now();
    v_resolved_by := v_effective_actor_id;
  END IF;

  IF v_effective_status = 'BLOCKED' THEN
    IF v_effective_waiting_for = 'NONE' THEN
      RAISE EXCEPTION 'BLOCKED requests must specify waiting_for dependency (INTERNAL, INDIA, MANUFACTURER, CUSTOMER)';
    END IF;
    IF v_effective_current_issue IS NULL OR trim(v_effective_current_issue) = '' THEN
      RAISE EXCEPTION 'BLOCKED requests must have a current_issue describing the impediment';
    END IF;
  END IF;

  IF v_effective_status = 'CANCELLED' THEN
    IF (v_effective_current_issue IS NULL OR trim(v_effective_current_issue) = '')
       AND (p_details->>'cancellation_reason' IS NULL OR trim(p_details->>'cancellation_reason') = '') THEN
      RAISE EXCEPTION 'CANCELLED requests must have a cancellation reason in current_issue or details.cancellation_reason';
    END IF;
  END IF;

  IF v_effective_status = 'NOT_POSSIBLE' THEN
    IF (v_effective_current_issue IS NULL OR trim(v_effective_current_issue) = '')
       AND (p_details->>'reason' IS NULL OR trim(p_details->>'reason') = '') THEN
      RAISE EXCEPTION 'NOT_POSSIBLE requests must have an explanation in current_issue or details.reason';
    END IF;
  END IF;

  -- Build details diff
  v_event_details := COALESCE(p_details, '{}'::jsonb);
  IF p_new_requirement IS NOT NULL AND p_new_requirement <> v_req.customer_requirement THEN
    v_event_details := v_event_details || jsonb_build_object(
      'requirement_diff', jsonb_build_object('old', v_req.customer_requirement, 'new', p_new_requirement)
    );
  END IF;

  -- Apply updates to enquiry_requests
  UPDATE public.enquiry_requests
  SET
    status = v_effective_status,
    waiting_for = v_effective_waiting_for,
    customer_requirement = v_effective_requirement,
    parameters = v_effective_parameters,
    assigned_to = v_effective_assigned_to,
    assigned_team = v_effective_assigned_team,
    current_issue = v_effective_current_issue,
    next_action = v_effective_next_action,
    response_text = v_effective_response_text,
    response_value = v_effective_response_value,
    resolved_at = v_resolved_at,
    resolved_by = v_resolved_by,
    updated_at = now()
  WHERE id = p_request_id;

  -- Append event to enquiry_request_events
  INSERT INTO public.enquiry_request_events (
    request_id,
    inquiry_id,
    event_type,
    summary,
    old_status,
    new_status,
    old_waiting_for,
    new_waiting_for,
    details,
    source_message_id,
    actor_type,
    actor_id
  ) VALUES (
    p_request_id,
    v_req.inquiry_id,
    p_event_type,
    p_summary,
    v_req.status,
    v_effective_status,
    v_req.waiting_for,
    v_effective_waiting_for,
    v_event_details,
    p_source_message_id,
    v_effective_actor_type,
    v_effective_actor_id
  );

  -- Link provenance if source message provided
  IF p_source_message_id IS NOT NULL THEN
    INSERT INTO public.enquiry_request_messages (
      request_id,
      message_id,
      relationship
    ) VALUES (
      p_request_id,
      p_source_message_id,
      CASE
        WHEN v_effective_status = 'RESOLVED' THEN 'resolved'
        WHEN v_effective_status = 'BLOCKED' THEN 'blocked'
        ELSE 'clarified'
      END
    )
    ON CONFLICT (request_id, message_id, relationship) DO NOTHING;
  END IF;

END;
$$;

-- ============================================================================
-- 5. RPC Security Grants (Explicit Permissions)
-- ============================================================================
REVOKE ALL ON FUNCTION public.create_enquiry_request_atomic FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_enquiry_request_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_enquiry_request_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.transition_enquiry_request_atomic FROM anon;

GRANT EXECUTE ON FUNCTION public.create_enquiry_request_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.transition_enquiry_request_atomic TO authenticated, service_role;

COMMIT;
