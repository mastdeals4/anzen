import { EnquiryActor } from './conversation.types';

export type EnquiryRequestCategory =
  | 'commercial'
  | 'technical'
  | 'document'
  | 'sample'
  | 'logistics'
  | 'custom';

export type EnquiryRequestStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'RESOLVED'
  | 'NOT_POSSIBLE'
  | 'NOT_REQUIRED'
  | 'CANCELLED';

export type EnquiryWaitingFor =
  | 'INTERNAL'
  | 'INDIA'
  | 'MANUFACTURER'
  | 'CUSTOMER'
  | 'NONE';

export type EnquiryAssignedTeam =
  | 'sales'
  | 'pricing_india'
  | 'regulatory'
  | 'warehouse'
  | 'sourcing'
  | 'management';

export type EnquiryAiStatus =
  | 'manual'
  | 'suggested'
  | 'confirmed'
  | 'rejected'
  | 'edited';

export interface EnquiryRequest {
  id: string;
  inquiry_id: string;
  inquiry_item_id: string | null;
  product_id: string | null;
  product_name_raw: string | null;
  category: EnquiryRequestCategory;
  request_code: string;
  title: string;
  customer_requirement: string;
  parameters: Record<string, unknown>;
  status: EnquiryRequestStatus;
  waiting_for: EnquiryWaitingFor;
  current_issue: string | null;
  next_action: string | null;
  assigned_to: string | null;
  assigned_team: EnquiryAssignedTeam | null;
  due_at: string | null;
  reminder_level: number;
  last_reminded_at: string | null;
  escalated_at: string | null;
  source_message_id: string | null;
  ai_status: EnquiryAiStatus;
  ai_confidence: number | null;
  ai_extracted_text: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  response_text: string | null;
  response_value: Record<string, unknown> | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateEnquiryRequestParams {
  inquiry_id: string;
  inquiry_item_id?: string | null;
  product_id?: string | null;
  product_name_raw?: string | null;
  category: EnquiryRequestCategory;
  request_code: string;
  title: string;
  customer_requirement: string;
  parameters?: Record<string, unknown>;
  assigned_to?: string | null;
  assigned_team?: EnquiryAssignedTeam | null;
  due_at?: string | null;
  waiting_for?: EnquiryWaitingFor;
  source_message_id?: string | null;
  ai_status?: EnquiryAiStatus;
  ai_confidence?: number | null;
  ai_extracted_text?: string | null;
  actor?: EnquiryActor;
}

export interface ChangeRequirementParams {
  request_id: string;
  new_requirement: string;
  new_parameters?: Record<string, unknown>;
  summary: string;
  reason?: string;
  status?: EnquiryRequestStatus;
  waiting_for?: EnquiryWaitingFor;
  source_message_id?: string | null;
  actor?: EnquiryActor;
}

export interface TransitionStateParams {
  request_id: string;
  event_type: string;
  summary: string;
  new_status?: EnquiryRequestStatus;
  new_waiting_for?: EnquiryWaitingFor;
  new_requirement?: string;
  new_parameters?: Record<string, unknown>;
  current_issue?: string | null;
  next_action?: string | null;
  new_assigned_to?: string | null;
  new_assigned_team?: EnquiryAssignedTeam | null;
  response_text?: string | null;
  response_value?: Record<string, unknown> | null;
  details?: Record<string, unknown>;
  source_message_id?: string | null;
  actor?: EnquiryActor;
}

export interface ReassignOwnerParams {
  request_id: string;
  assigned_to?: string | null;
  assigned_team?: EnquiryAssignedTeam | null;
  reason?: string;
  actor?: EnquiryActor;
}

export interface ResolveRequestParams {
  request_id: string;
  response_text: string;
  response_value?: Record<string, unknown>;
  source_message_id?: string | null;
  actor?: EnquiryActor;
}

export interface CancelRequestParams {
  request_id: string;
  cancellation_reason: string;
  source_message_id?: string | null;
  actor?: EnquiryActor;
}
