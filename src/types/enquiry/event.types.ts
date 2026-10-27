import { EnquiryActor, EnquiryActorType } from './conversation.types';
import { EnquiryRequestStatus, EnquiryWaitingFor } from './request.types';

export type EnquiryRequestEventType =
  | 'created'
  | 'requirement_changed'
  | 'supplier_response'
  | 'customer_decision'
  | 'status_changed'
  | 'waiting_for_changed'
  | 'owner_reassigned'
  | 'escalated'
  | 'resolved'
  | 'cancelled';

export interface EnquiryRequestEvent {
  id: string;
  request_id: string;
  inquiry_id: string;
  event_type: EnquiryRequestEventType;
  summary: string;
  old_status: EnquiryRequestStatus | null;
  new_status: EnquiryRequestStatus | null;
  old_waiting_for: EnquiryWaitingFor | null;
  new_waiting_for: EnquiryWaitingFor | null;
  details: Record<string, unknown>;
  source_message_id: string | null;
  actor_type: EnquiryActorType;
  actor_id: string | null;
  created_at: string;
}

export type RequestMessageRelationship =
  | 'originated'
  | 'clarified'
  | 'blocked'
  | 'resolved'
  | 'referenced';

export interface EnquiryRequestMessageLink {
  id: string;
  request_id: string;
  message_id: string;
  relationship: RequestMessageRelationship;
  created_at: string;
}

export interface AppendEventParams {
  request_id: string;
  event_type: EnquiryRequestEventType;
  summary: string;
  details?: Record<string, unknown>;
  source_message_id?: string | null;
  actor?: EnquiryActor;
}

export interface LinkMessageParams {
  request_id: string;
  message_id: string;
  relationship: RequestMessageRelationship;
}
