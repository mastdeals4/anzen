-- ============================================================================
-- Migration: 20260914220000_enquiry_brain_review_gate_hardening.sql
-- Description: Phase 7.6B Hardening: Atomic Stale-Proposal Protection &
--              Database-Level Proposal Review Concurrency Idempotency
--
-- Objects:
--   1. Re-defined RPC transition_enquiry_request_atomic (with p_expected_values)
--   2. RPC accept_enquiry_brain_proposal_atomic (transactional lock + idempotency + stale check)
--   3. RPC edit_enquiry_brain_proposal_atomic (human-corrected values + original preservation)
--   4. RPC dismiss_enquiry_brain_proposal_atomic (zero mutation on business state)
--
-- Security:
--   - Strict actor enforcement (browser callers forced to actor_type='user', actor_id=auth.uid())
--   - Active admin/sales users only
--   - Revoke from public/anon, grant to authenticated and service_role
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Enhanced transition_enquiry_request_atomic with inside-transaction stale check
-- ============================================================================

-- Drop existing signature to ensure clean signature replacement
DROP FUNCTION IF EXISTS public.transition_enquiry_request_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, JSONB, UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.transition_enquiry_request_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, UUID, TEXT, TEXT, JSONB, JSONB, UUID, TEXT, UUID, JSONB);

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
  p_actor_id UUID DEFAULT NULL,
  p_expected_values JSONB DEFAULT NULL
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

  -- Stale proposal / concurrency check inside the transaction
  IF p_expected_values IS NOT NULL AND p_expected_values <> '{}'::jsonb THEN
    IF p_expected_values ? 'customer_requirement' THEN
      IF trim(COALESCE(v_req.customer_requirement, '')) <> trim(COALESCE(p_expected_values->>'customer_requirement', '')) THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: customer_requirement has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'customer_requirement', v_req.customer_requirement
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF p_expected_values ? 'status' THEN
      IF v_req.status <> (p_expected_values->>'status') THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: status has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'status', v_req.status
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF p_expected_values ? 'waiting_for' THEN
      IF v_req.waiting_for <> (p_expected_values->>'waiting_for') THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: waiting_for has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'waiting_for', v_req.waiting_for
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    IF p_expected_values ? 'assigned_team' THEN
      IF COALESCE(v_req.assigned_team, '') <> COALESCE(p_expected_values->>'assigned_team', '') THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: assigned_team has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'assigned_team', v_req.assigned_team
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
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
-- 2. Atomic Proposal Acceptance RPC (Locking + Concurrency + Stale Protection)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.accept_enquiry_brain_proposal_atomic(
  p_message_id UUID,
  p_inquiry_id UUID,
  p_expected_values JSONB DEFAULT NULL,
  p_actor_type TEXT DEFAULT 'user',
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
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

  v_msg public.enquiry_conversation_messages%ROWTYPE;
  v_proposal JSONB;
  v_proposal_status TEXT;
  v_update JSONB;
  v_req_id UUID;
  v_req public.enquiry_requests%ROWTYPE;
  v_field TEXT;
  v_event_type TEXT;
  v_new_req_val TEXT;
  v_new_status_val TEXT;
  v_new_waiting_val TEXT;
  v_new_next_action TEXT;
  v_new_team TEXT;

  v_new_req_item JSONB;
  v_created_req_id UUID;
  v_req_code TEXT;
  v_new_category TEXT;
  v_new_title TEXT;
  v_new_requirement_text TEXT;
  v_new_params JSONB;
  v_new_waiting TEXT;

  v_updated_req_ids UUID[] := '{}';
  v_created_req_ids UUID[] := '{}';
BEGIN
  v_caller_role := auth.role();
  v_caller_auth_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE id = v_caller_auth_uid AND is_active = true;

    IF v_user_role IS NULL OR v_user_role NOT IN ('admin', 'sales') THEN
      RAISE EXCEPTION 'Unauthorized: only active admin or sales users can approve AI proposals';
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

  -- 1. Row lock the message record to serialize concurrent approvals
  SELECT * INTO v_msg
  FROM public.enquiry_conversation_messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical message not found: %', p_message_id;
  END IF;

  v_proposal := v_msg.ai_proposal;
  IF v_proposal IS NULL THEN
    RAISE EXCEPTION 'Message % does not contain an AI proposal', p_message_id;
  END IF;

  -- 2. Concurrency / Idempotency check: strictly only 'suggested' can be accepted
  v_proposal_status := v_proposal->>'status';
  IF v_proposal_status IS NULL OR v_proposal_status <> 'suggested' THEN
    RAISE EXCEPTION 'PROPOSAL_ALREADY_PROCESSED: AI proposal has already been processed (current status: %)', COALESCE(v_proposal_status, 'none')
      USING ERRCODE = 'P0002';
  END IF;

  -- 3. Process proposed updates with inside-transaction stale checking
  IF v_proposal ? 'proposed_updates' AND jsonb_typeof(v_proposal->'proposed_updates') = 'array' THEN
    FOR v_update IN SELECT * FROM jsonb_array_elements(v_proposal->'proposed_updates')
    LOOP
      v_req_id := (v_update->>'request_id')::UUID;
      IF v_req_id IS NULL THEN
        RAISE EXCEPTION 'Missing request_id in proposed update';
      END IF;

      -- Lock target enquiry_requests record
      SELECT * INTO v_req
      FROM public.enquiry_requests
      WHERE id = v_req_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Target request % no longer exists', v_req_id;
      END IF;

      v_field := v_update->>'field';

      -- Check stale condition against live row
      IF v_update ? 'old_value' AND v_update->'old_value' IS NOT NULL AND v_update->>'old_value' <> 'null' THEN
        IF v_field = 'customer_requirement' THEN
          IF trim(COALESCE(v_req.customer_requirement, '')) <> trim(COALESCE(v_update->>'old_value', '')) THEN
            RAISE EXCEPTION 'STALE_PROPOSAL: customer_requirement has changed since AI proposal was created (expected: "%", current: "%")',
              v_update->>'old_value', v_req.customer_requirement
              USING ERRCODE = 'P0001';
          END IF;
        ELSIF v_field = 'status' THEN
          IF v_req.status <> (v_update->>'old_value') THEN
            RAISE EXCEPTION 'STALE_PROPOSAL: status has changed since AI proposal was created (expected: "%", current: "%")',
              v_update->>'old_value', v_req.status
              USING ERRCODE = 'P0001';
          END IF;
        ELSIF v_field = 'waiting_for' THEN
          IF v_req.waiting_for <> (v_update->>'old_value') THEN
            RAISE EXCEPTION 'STALE_PROPOSAL: waiting_for has changed since AI proposal was created (expected: "%", current: "%")',
              v_update->>'old_value', v_req.waiting_for
              USING ERRCODE = 'P0001';
          END IF;
        ELSIF v_field = 'assigned_team' THEN
          IF COALESCE(v_req.assigned_team, '') <> COALESCE(v_update->>'old_value', '') THEN
            RAISE EXCEPTION 'STALE_PROPOSAL: assigned_team has changed since AI proposal was created (expected: "%", current: "%")',
              v_update->>'old_value', v_req.assigned_team
              USING ERRCODE = 'P0001';
          END IF;
        END IF;
      END IF;

      -- Check caller expected values if provided for this request
      IF p_expected_values IS NOT NULL THEN
        IF p_expected_values ? 'customer_requirement' AND trim(COALESCE(v_req.customer_requirement, '')) <> trim(COALESCE(p_expected_values->>'customer_requirement', '')) THEN
          RAISE EXCEPTION 'STALE_PROPOSAL: customer_requirement has changed since AI proposal was created (expected: "%", current: "%")',
            p_expected_values->>'customer_requirement', v_req.customer_requirement
            USING ERRCODE = 'P0001';
        END IF;
        IF p_expected_values ? 'status' AND v_req.status <> (p_expected_values->>'status') THEN
          RAISE EXCEPTION 'STALE_PROPOSAL: status has changed since AI proposal was created (expected: "%", current: "%")',
            p_expected_values->>'status', v_req.status
            USING ERRCODE = 'P0001';
        END IF;
        IF p_expected_values ? 'waiting_for' AND v_req.waiting_for <> (p_expected_values->>'waiting_for') THEN
          RAISE EXCEPTION 'STALE_PROPOSAL: waiting_for has changed since AI proposal was created (expected: "%", current: "%")',
            p_expected_values->>'waiting_for', v_req.waiting_for
            USING ERRCODE = 'P0001';
        END IF;
      END IF;

      -- Determine event type
      v_event_type := CASE
        WHEN v_proposal->>'intent' = 'customer_decision' THEN 'customer_decision'
        WHEN v_proposal->>'intent' = 'requirement_change' OR v_field = 'customer_requirement' THEN 'requirement_changed'
        WHEN v_proposal->>'intent' = 'supplier_response' THEN 'supplier_response'
        ELSE 'status_changed'
      END;

      -- Compute effective new values
      v_new_req_val := CASE WHEN v_field = 'customer_requirement' THEN v_update->>'new_value' ELSE v_req.customer_requirement END;
      v_new_status_val := CASE WHEN v_field = 'status' THEN v_update->>'new_value' ELSE v_req.status END;
      v_new_waiting_val := CASE
        WHEN v_field = 'waiting_for' THEN v_update->>'new_value'
        WHEN v_proposal->>'suggested_waiting_for' IS NOT NULL THEN v_proposal->>'suggested_waiting_for'
        ELSE v_req.waiting_for
      END;
      v_new_next_action := CASE
        WHEN v_field = 'next_action' THEN v_update->>'new_value'
        WHEN v_proposal->>'suggested_next_action' IS NOT NULL THEN v_proposal->>'suggested_next_action'
        ELSE v_req.next_action
      END;
      v_new_team := CASE
        WHEN v_field = 'assigned_team' THEN v_update->>'new_value'
        WHEN v_proposal->>'suggested_team' IS NOT NULL THEN v_proposal->>'suggested_team'
        ELSE v_req.assigned_team
      END;

      -- Update enquiry_requests
      UPDATE public.enquiry_requests
      SET
        customer_requirement = v_new_req_val,
        status = v_new_status_val,
        waiting_for = v_new_waiting_val,
        next_action = v_new_next_action,
        assigned_team = v_new_team,
        ai_status = 'confirmed',
        confirmed_by = v_effective_actor_id,
        confirmed_at = now(),
        updated_at = now()
      WHERE id = v_req_id;

      -- Insert immutable event
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
        v_req_id,
        v_req.inquiry_id,
        v_event_type,
        'AI Suggestion Accepted: ' || COALESCE(v_proposal->>'summary', ''),
        v_req.status,
        v_new_status_val,
        v_req.waiting_for,
        v_new_waiting_val,
        jsonb_build_object(
          'ai_proposal', v_proposal,
          'decision', 'accepted',
          'approved_field', v_field,
          'old_value', v_update->'old_value',
          'new_value', v_update->'new_value'
        ),
        p_message_id,
        v_effective_actor_type,
        v_effective_actor_id
      );

      -- Link provenance
      INSERT INTO public.enquiry_request_messages (
        request_id,
        message_id,
        relationship
      ) VALUES (
        v_req_id,
        p_message_id,
        'clarified'
      )
      ON CONFLICT (request_id, message_id, relationship) DO NOTHING;

      v_updated_req_ids := array_append(v_updated_req_ids, v_req_id);
    END LOOP;
  END IF;

  -- 4. Process proposed new requests (exactly once, atomic idempotency)
  IF v_proposal ? 'proposed_new_requests' AND jsonb_typeof(v_proposal->'proposed_new_requests') = 'array' THEN
    FOR v_new_req_item IN SELECT * FROM jsonb_array_elements(v_proposal->'proposed_new_requests')
    LOOP
      v_req_code := 'REQ-' || lpad(floor(random() * 10000)::text, 4, '0');
      v_new_category := COALESCE(v_new_req_item->>'category', 'commercial');
      v_new_title := COALESCE(v_new_req_item->>'title', 'New Request');
      v_new_requirement_text := COALESCE(v_new_req_item->>'customer_requirement', '');
      v_new_params := COALESCE(v_new_req_item->'parameters', '{}'::jsonb);
      v_new_waiting := COALESCE(v_new_req_item->>'waiting_for', 'INTERNAL');
      v_new_team := v_new_req_item->>'assigned_team';

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
        v_new_category,
        v_req_code,
        v_new_title,
        v_new_requirement_text,
        v_new_params,
        NULL,
        v_new_team,
        NULL,
        'OPEN',
        v_new_waiting,
        p_message_id,
        'confirmed',
        CASE WHEN v_proposal->>'confidence_tier' = 'HIGH' THEN 0.9 ELSE 0.7 END,
        v_proposal->>'summary'
      )
      RETURNING id INTO v_created_req_id;

      -- Append initial created event
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
        v_created_req_id,
        p_inquiry_id,
        'created',
        'Request created from AI suggestion: ' || v_new_title,
        NULL,
        'OPEN',
        NULL,
        v_new_waiting,
        jsonb_build_object(
          'ai_proposal', v_proposal,
          'decision', 'accepted',
          'initial_requirement', v_new_requirement_text,
          'parameters', v_new_params
        ),
        p_message_id,
        v_effective_actor_type,
        v_effective_actor_id
      );

      -- Link provenance
      INSERT INTO public.enquiry_request_messages (
        request_id,
        message_id,
        relationship
      ) VALUES (
        v_created_req_id,
        p_message_id,
        'originated'
      )
      ON CONFLICT (request_id, message_id, relationship) DO NOTHING;

      v_created_req_ids := array_append(v_created_req_ids, v_created_req_id);
    END LOOP;
  END IF;

  -- 5. Mark proposal as accepted, preserving original proposal snapshot
  UPDATE public.enquiry_conversation_messages
  SET ai_proposal = v_proposal || jsonb_build_object(
    'status', 'accepted',
    'original_proposal', v_proposal,
    'reviewed_by', v_effective_actor_id,
    'reviewed_at', now()
  )
  WHERE id = p_message_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'accepted',
    'updated_request_ids', v_updated_req_ids,
    'created_request_ids', v_created_req_ids
  );
END;
$$;

-- ============================================================================
-- 3. Atomic Proposal Edit RPC (Human Correction + Preservation)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.edit_enquiry_brain_proposal_atomic(
  p_message_id UUID,
  p_inquiry_id UUID,
  p_edited_values JSONB,
  p_expected_values JSONB DEFAULT NULL,
  p_actor_type TEXT DEFAULT 'user',
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
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

  v_msg public.enquiry_conversation_messages%ROWTYPE;
  v_proposal JSONB;
  v_proposal_status TEXT;
  v_target_req_id UUID;
  v_req public.enquiry_requests%ROWTYPE;
BEGIN
  v_caller_role := auth.role();
  v_caller_auth_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE id = v_caller_auth_uid AND is_active = true;

    IF v_user_role IS NULL OR v_user_role NOT IN ('admin', 'sales') THEN
      RAISE EXCEPTION 'Unauthorized: only active admin or sales users can edit AI proposals';
    END IF;

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

  -- Lock message record
  SELECT * INTO v_msg
  FROM public.enquiry_conversation_messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical message not found: %', p_message_id;
  END IF;

  v_proposal := v_msg.ai_proposal;
  IF v_proposal IS NULL THEN
    RAISE EXCEPTION 'Message % does not contain an AI proposal', p_message_id;
  END IF;

  v_proposal_status := v_proposal->>'status';
  IF v_proposal_status IS NULL OR v_proposal_status <> 'suggested' THEN
    RAISE EXCEPTION 'PROPOSAL_ALREADY_PROCESSED: AI proposal has already been processed (current status: %)', COALESCE(v_proposal_status, 'none')
      USING ERRCODE = 'P0002';
  END IF;

  -- If editing an existing request, apply changes under row lock
  IF p_edited_values ? 'target_request_id' AND p_edited_values->>'target_request_id' IS NOT NULL THEN
    v_target_req_id := (p_edited_values->>'target_request_id')::UUID;

    SELECT * INTO v_req
    FROM public.enquiry_requests
    WHERE id = v_target_req_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target request % not found', v_target_req_id;
    END IF;

    -- Stale check if expected values passed
    IF p_expected_values IS NOT NULL THEN
      IF p_expected_values ? 'customer_requirement' AND trim(COALESCE(v_req.customer_requirement, '')) <> trim(COALESCE(p_expected_values->>'customer_requirement', '')) THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: customer_requirement has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'customer_requirement', v_req.customer_requirement
          USING ERRCODE = 'P0001';
      END IF;
      IF p_expected_values ? 'status' AND v_req.status <> (p_expected_values->>'status') THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: status has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'status', v_req.status
          USING ERRCODE = 'P0001';
      END IF;
      IF p_expected_values ? 'waiting_for' AND v_req.waiting_for <> (p_expected_values->>'waiting_for') THEN
        RAISE EXCEPTION 'STALE_PROPOSAL: waiting_for has changed since AI suggestion was created (expected: "%", current: "%")',
          p_expected_values->>'waiting_for', v_req.waiting_for
          USING ERRCODE = 'P0001';
      END IF;
    END IF;

    -- Update request with human-edited values
    UPDATE public.enquiry_requests
    SET
      customer_requirement = COALESCE(p_edited_values->>'customer_requirement', v_req.customer_requirement),
      status = COALESCE(p_edited_values->>'status', v_req.status),
      waiting_for = COALESCE(p_edited_values->>'waiting_for', v_req.waiting_for),
      next_action = CASE WHEN p_edited_values ? 'next_action' THEN p_edited_values->>'next_action' ELSE v_req.next_action END,
      assigned_team = CASE WHEN p_edited_values ? 'assigned_team' THEN p_edited_values->>'assigned_team' ELSE v_req.assigned_team END,
      ai_status = 'edited',
      confirmed_by = v_effective_actor_id,
      confirmed_at = now(),
      updated_at = now()
    WHERE id = v_target_req_id;

    -- Append event
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
      v_target_req_id,
      v_req.inquiry_id,
      'requirement_changed',
      COALESCE(p_edited_values->>'summary', 'Human-Edited AI Suggestion: ' || COALESCE(v_proposal->>'summary', '')),
      v_req.status,
      COALESCE(p_edited_values->>'status', v_req.status),
      v_req.waiting_for,
      COALESCE(p_edited_values->>'waiting_for', v_req.waiting_for),
      jsonb_build_object(
        'ai_proposal', v_proposal,
        'decision', 'edited',
        'edited_values', p_edited_values,
        'original_proposal', v_proposal
      ),
      p_message_id,
      v_effective_actor_type,
      v_effective_actor_id
    );

    -- Provenance
    INSERT INTO public.enquiry_request_messages (
      request_id,
      message_id,
      relationship
    ) VALUES (
      v_target_req_id,
      p_message_id,
      'clarified'
    )
    ON CONFLICT (request_id, message_id, relationship) DO NOTHING;
  END IF;

  -- Mark proposal as edited with original snapshot preserved
  UPDATE public.enquiry_conversation_messages
  SET ai_proposal = v_proposal || jsonb_build_object(
    'status', 'edited',
    'original_proposal', v_proposal,
    'edited_values', p_edited_values,
    'reviewed_by', v_effective_actor_id,
    'reviewed_at', now()
  )
  WHERE id = p_message_id;

  RETURN jsonb_build_object('success', true, 'status', 'edited');
END;
$$;

-- ============================================================================
-- 4. Atomic Proposal Dismiss RPC (Zero Business Mutation)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.dismiss_enquiry_brain_proposal_atomic(
  p_message_id UUID,
  p_actor_type TEXT DEFAULT 'user',
  p_actor_id UUID DEFAULT NULL
)
RETURNS JSONB
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

  v_msg public.enquiry_conversation_messages%ROWTYPE;
  v_proposal JSONB;
  v_proposal_status TEXT;
BEGIN
  v_caller_role := auth.role();
  v_caller_auth_uid := auth.uid();

  IF v_caller_role = 'authenticated' THEN
    SELECT role INTO v_user_role
    FROM public.user_profiles
    WHERE id = v_caller_auth_uid AND is_active = true;

    IF v_user_role IS NULL OR v_user_role NOT IN ('admin', 'sales') THEN
      RAISE EXCEPTION 'Unauthorized: only active admin or sales users can dismiss AI proposals';
    END IF;

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

  -- Lock message record
  SELECT * INTO v_msg
  FROM public.enquiry_conversation_messages
  WHERE id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Canonical message not found: %', p_message_id;
  END IF;

  v_proposal := v_msg.ai_proposal;
  IF v_proposal IS NULL THEN
    RAISE EXCEPTION 'Message % does not contain an AI proposal', p_message_id;
  END IF;

  v_proposal_status := v_proposal->>'status';
  IF v_proposal_status IS NULL OR v_proposal_status <> 'suggested' THEN
    RAISE EXCEPTION 'PROPOSAL_ALREADY_PROCESSED: AI proposal has already been processed (current status: %)', COALESCE(v_proposal_status, 'none')
      USING ERRCODE = 'P0002';
  END IF;

  -- Mark proposal as dismissed with original proposal preserved; zero mutation to enquiry_requests or crm_inquiries
  UPDATE public.enquiry_conversation_messages
  SET ai_proposal = v_proposal || jsonb_build_object(
    'status', 'dismissed',
    'original_proposal', v_proposal,
    'dismissed_by', v_effective_actor_id,
    'dismissed_at', now()
  )
  WHERE id = p_message_id;

  RETURN jsonb_build_object('success', true, 'status', 'dismissed');
END;
$$;

-- ============================================================================
-- 5. RPC Security Grants
-- ============================================================================
REVOKE ALL ON FUNCTION public.transition_enquiry_request_atomic FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_enquiry_brain_proposal_atomic FROM PUBLIC;
REVOKE ALL ON FUNCTION public.edit_enquiry_brain_proposal_atomic FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dismiss_enquiry_brain_proposal_atomic FROM PUBLIC;

REVOKE EXECUTE ON FUNCTION public.transition_enquiry_request_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.accept_enquiry_brain_proposal_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.edit_enquiry_brain_proposal_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION public.dismiss_enquiry_brain_proposal_atomic FROM anon;

GRANT EXECUTE ON FUNCTION public.transition_enquiry_request_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_enquiry_brain_proposal_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.edit_enquiry_brain_proposal_atomic TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dismiss_enquiry_brain_proposal_atomic TO authenticated, service_role;

COMMIT;
