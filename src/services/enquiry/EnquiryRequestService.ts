import { supabase } from '../../lib/supabase';
import {
  AppendEventParams,
  CancelRequestParams,
  ChangeRequirementParams,
  CreateEnquiryRequestParams,
  EnquiryMessage,
  EnquiryRequest,
  EnquiryRequestEvent,
  EnquiryRequestMessageLink,
  LinkMessageParams,
  ReassignOwnerParams,
  RequestMessageRelationship,
  ResolveRequestParams,
  TransitionStateParams,
} from '../../types/enquiry';
import { RequestValidationError } from './enquiryErrors';

export class EnquiryRequestService {
  /**
   * Atomically create an enquiry request and its origin 'created' event.
   */
  static async createRequest(
    params: CreateEnquiryRequestParams
  ): Promise<EnquiryRequest> {
    const {
      inquiry_id,
      category,
      request_code,
      title,
      customer_requirement,
      parameters = {},
      assigned_to = null,
      assigned_team = null,
      due_at = null,
      waiting_for = 'INTERNAL',
      source_message_id = null,
      ai_status = 'manual',
      ai_confidence = null,
      ai_extracted_text = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    if (!inquiry_id) throw new RequestValidationError('inquiry_id', 'Inquiry ID is required');
    if (!category) throw new RequestValidationError('category', 'Category is required');
    if (!request_code) throw new RequestValidationError('request_code', 'Request code is required');
    if (!title || !title.trim()) throw new RequestValidationError('title', 'Title is required');
    if (!customer_requirement || !customer_requirement.trim()) {
      throw new RequestValidationError('customer_requirement', 'Customer requirement is required');
    }

    const { data: newId, error: rpcError } = await supabase.rpc(
      'create_enquiry_request_atomic',
      {
        p_inquiry_id: inquiry_id,
        p_category: category,
        p_request_code: request_code,
        p_title: title.trim(),
        p_customer_requirement: customer_requirement.trim(),
        p_parameters: parameters,
        p_assigned_to: assigned_to,
        p_assigned_team: assigned_team,
        p_due_at: due_at,
        p_waiting_for: waiting_for,
        p_source_message_id: source_message_id,
        p_ai_status: ai_status,
        p_ai_confidence: ai_confidence,
        p_ai_extracted_text: ai_extracted_text,
        p_actor_type: actor.actor_type,
        p_actor_id: actor.actor_id || null,
      }
    );

    if (rpcError) throw rpcError;

    const { data: createdReq, error: fetchError } = await supabase
      .from('enquiry_requests')
      .select('*')
      .eq('id', newId)
      .single();

    if (fetchError) throw fetchError;
    return createdReq as EnquiryRequest;
  }

  /**
   * Atomically evolve a requirement (e.g. 100 mesh -> 660 mesh) with full audit preservation.
   */
  static async changeRequirement(
    params: ChangeRequirementParams
  ): Promise<EnquiryRequest> {
    const {
      request_id,
      new_requirement,
      new_parameters,
      summary,
      reason,
      status,
      waiting_for,
      source_message_id = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    if (!new_requirement || !new_requirement.trim()) {
      throw new RequestValidationError('new_requirement', 'New requirement must not be empty');
    }

    const details: Record<string, unknown> = {};
    if (reason) details.reason = reason;

    const { error: rpcError } = await supabase.rpc(
      'transition_enquiry_request_atomic',
      {
        p_request_id: request_id,
        p_event_type: 'requirement_changed',
        p_summary: summary || `Requirement changed to: ${new_requirement.trim()}`,
        p_new_status: status || null,
        p_new_waiting_for: waiting_for || null,
        p_new_requirement: new_requirement.trim(),
        p_new_parameters: new_parameters || null,
        p_details: details,
        p_source_message_id: source_message_id,
        p_actor_type: actor.actor_type,
        p_actor_id: actor.actor_id || null,
      }
    );

    if (rpcError) throw rpcError;

    const { data: updated, error: fetchError } = await supabase
      .from('enquiry_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchError) throw fetchError;
    return updated as EnquiryRequest;
  }

  /**
   * Atomically transition status, waiting_for, or issue details.
   */
  static async transitionState(
    params: TransitionStateParams
  ): Promise<EnquiryRequest> {
    const {
      request_id,
      event_type,
      summary,
      new_status,
      new_waiting_for,
      new_requirement,
      new_parameters,
      current_issue,
      next_action,
      new_assigned_to,
      new_assigned_team,
      response_text,
      response_value,
      details = {},
      source_message_id = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    // Validation
    if (new_status === 'RESOLVED') {
      if (!response_text && (!response_value || Object.keys(response_value).length === 0)) {
        throw new RequestValidationError('response_text', 'RESOLVED status requires response_text or response_value');
      }
    }

    if (new_status === 'BLOCKED') {
      if (new_waiting_for === 'NONE') {
        throw new RequestValidationError('waiting_for', 'BLOCKED status cannot have waiting_for = NONE');
      }
      if (!current_issue || !current_issue.trim()) {
        throw new RequestValidationError('current_issue', 'BLOCKED status requires current_issue describing the impediment');
      }
    }

    if (new_status === 'CANCELLED') {
      if (!current_issue && !details.cancellation_reason) {
        throw new RequestValidationError('cancellation_reason', 'CANCELLED status requires a cancellation reason');
      }
    }

    const { error: rpcError } = await supabase.rpc(
      'transition_enquiry_request_atomic',
      {
        p_request_id: request_id,
        p_event_type: event_type || 'status_changed',
        p_summary: summary,
        p_new_status: new_status || null,
        p_new_waiting_for: new_waiting_for || null,
        p_new_requirement: new_requirement || null,
        p_new_parameters: new_parameters || null,
        p_current_issue: current_issue || null,
        p_next_action: next_action || null,
        p_new_assigned_to: new_assigned_to || null,
        p_new_assigned_team: new_assigned_team || null,
        p_response_text: response_text || null,
        p_response_value: response_value || null,
        p_details: details,
        p_source_message_id: source_message_id,
        p_actor_type: actor.actor_type,
        p_actor_id: actor.actor_id || null,
      }
    );

    if (rpcError) throw rpcError;

    const { data: updated, error: fetchError } = await supabase
      .from('enquiry_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchError) throw fetchError;
    return updated as EnquiryRequest;
  }

  /**
   * Reassign request owner or team.
   */
  static async reassignOwner(
    params: ReassignOwnerParams
  ): Promise<EnquiryRequest> {
    const {
      request_id,
      assigned_to = null,
      assigned_team = null,
      reason,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    const details: Record<string, unknown> = {};
    if (reason) details.reason = reason;

    const { error: rpcError } = await supabase.rpc(
      'transition_enquiry_request_atomic',
      {
        p_request_id: request_id,
        p_event_type: 'owner_reassigned',
        p_summary: `Owner reassigned: ${assigned_team || 'individual user'}`,
        p_new_assigned_to: assigned_to,
        p_new_assigned_team: assigned_team,
        p_details: details,
        p_actor_type: actor.actor_type,
        p_actor_id: actor.actor_id || null,
      }
    );

    if (rpcError) throw rpcError;

    const { data: updated, error: fetchError } = await supabase
      .from('enquiry_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchError) throw fetchError;
    return updated as EnquiryRequest;
  }

  /**
   * Resolve request with answer or document proof.
   */
  static async resolveRequest(
    params: ResolveRequestParams
  ): Promise<EnquiryRequest> {
    const {
      request_id,
      response_text,
      response_value = {},
      source_message_id = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    if (!response_text && (!response_value || Object.keys(response_value).length === 0)) {
      throw new RequestValidationError('response_text', 'Resolution requires response_text or response_value');
    }

    return this.transitionState({
      request_id,
      event_type: 'resolved',
      summary: `Request resolved: ${response_text.slice(0, 100)}`,
      new_status: 'RESOLVED',
      new_waiting_for: 'NONE',
      response_text,
      response_value,
      source_message_id,
      actor,
    });
  }

  /**
   * Cancel request with cancellation reason.
   */
  static async cancelRequest(
    params: CancelRequestParams
  ): Promise<EnquiryRequest> {
    const {
      request_id,
      cancellation_reason,
      source_message_id = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    if (!cancellation_reason || !cancellation_reason.trim()) {
      throw new RequestValidationError('cancellation_reason', 'Cancellation reason is required');
    }

    return this.transitionState({
      request_id,
      event_type: 'cancelled',
      summary: `Request cancelled: ${cancellation_reason.trim()}`,
      new_status: 'CANCELLED',
      new_waiting_for: 'NONE',
      current_issue: cancellation_reason.trim(),
      details: { cancellation_reason: cancellation_reason.trim() },
      source_message_id,
      actor,
    });
  }

  /**
   * Append a standalone audit event (e.g. supplier feedback, customer note) without modifying state.
   */
  static async appendEvent(
    params: AppendEventParams
  ): Promise<EnquiryRequestEvent> {
    const {
      request_id,
      event_type,
      summary,
      details = {},
      source_message_id = null,
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    const { data: req, error: fetchReqError } = await supabase
      .from('enquiry_requests')
      .select('inquiry_id, status, waiting_for')
      .eq('id', request_id)
      .single();

    if (fetchReqError) throw fetchReqError;

    const payload = {
      request_id,
      inquiry_id: req.inquiry_id,
      event_type,
      summary,
      old_status: req.status,
      new_status: req.status,
      old_waiting_for: req.waiting_for,
      new_waiting_for: req.waiting_for,
      details,
      source_message_id,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id || null,
    };

    const { data: createdEvent, error: insertError } = await supabase
      .from('enquiry_request_events')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) throw insertError;
    return createdEvent as EnquiryRequestEvent;
  }

  /**
   * Link message provenance to request.
   */
  static async linkMessage(
    params: LinkMessageParams
  ): Promise<EnquiryRequestMessageLink> {
    const { request_id, message_id, relationship } = params;

    const payload = {
      request_id,
      message_id,
      relationship,
    };

    const { data: link, error } = await supabase
      .from('enquiry_request_messages')
      .upsert(payload, { onConflict: 'request_id,message_id,relationship' })
      .select('*')
      .single();

    if (error) throw error;
    return link as EnquiryRequestMessageLink;
  }

  /**
   * Get all requests for a specific enquiry.
   */
  static async getRequestsByInquiry(inquiry_id: string): Promise<EnquiryRequest[]> {
    const { data, error } = await supabase
      .from('enquiry_requests')
      .select('*')
      .eq('inquiry_id', inquiry_id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data || []) as EnquiryRequest[];
  }

  /**
   * Get full timeline for a request (request, events, linked messages, documents).
   */
  static async getRequestTimeline(request_id: string): Promise<{
    request: EnquiryRequest;
    events: EnquiryRequestEvent[];
    linked_messages: Array<{ message: EnquiryMessage; relationship: RequestMessageRelationship }>;
    linked_documents: Array<{ id: string; display_file_name: string; document_type: string; storage_path: string }>;
  }> {
    const [reqRes, eventsRes, msgLinksRes, docsRes] = await Promise.all([
      supabase.from('enquiry_requests').select('*').eq('id', request_id).single(),
      supabase.from('enquiry_request_events').select('*').eq('request_id', request_id).order('created_at', { ascending: true }),
      supabase.from('enquiry_request_messages').select('*, enquiry_conversation_messages(*)').eq('request_id', request_id),
      supabase.from('crm_product_documents').select('id, display_file_name, document_type, storage_path').eq('enquiry_request_id', request_id),
    ]);

    if (reqRes.error) throw reqRes.error;
    if (eventsRes.error) throw eventsRes.error;
    if (msgLinksRes.error) throw msgLinksRes.error;
    if (docsRes.error) throw docsRes.error;

    const linkedMessages = (msgLinksRes.data || []).map((row: any) => ({
      message: row.enquiry_conversation_messages as EnquiryMessage,
      relationship: row.relationship as RequestMessageRelationship,
    }));

    return {
      request: reqRes.data as EnquiryRequest,
      events: (eventsRes.data || []) as EnquiryRequestEvent[],
      linked_messages: linkedMessages,
      linked_documents: docsRes.data || [],
    };
  }
}
