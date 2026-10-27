export type EnquiryChannel = 'email' | 'whatsapp' | 'internal';
export type ConversationStatus = 'active' | 'archived' | 'spam';
export type ConversationLinkType = 'primary' | 'related' | 'reference';
export type MessageDirection = 'inbound' | 'outbound' | 'internal';
export type EnquiryActorType = 'user' | 'system' | 'ai';

export interface EnquiryActor {
  actor_type: EnquiryActorType;
  actor_id?: string | null;
}

export interface EnquiryConversation {
  id: string;
  customer_id: string | null;
  crm_contact_id: string | null;
  channel: EnquiryChannel;
  external_thread_id: string | null;
  title: string;
  participant_identifiers: string[];
  last_message_at: string;
  status: ConversationStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface EnquiryConversationLink {
  id: string;
  conversation_id: string;
  inquiry_id: string;
  link_type: ConversationLinkType;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

export interface MessageAttachment {
  filename: string;
  content_type?: string;
  size_bytes?: number;
  url?: string;
}

export interface EnquiryMessage {
  id: string;
  conversation_id: string;
  channel: EnquiryChannel;
  direction: MessageDirection;
  external_message_id: string | null;
  sender_address: string;
  sender_name: string | null;
  recipient_addresses: string[];
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  attachments: MessageAttachment[];
  raw_payload: Record<string, unknown> | null;
  received_or_sent_at: string;
  actor_type: EnquiryActorType;
  actor_id: string | null;
  ai_processed: boolean;
  ai_summary: string | null;
  ai_proposal?: AiProposal | null;
  ai_reply_draft?: AiReplyDraft | null;
  created_at: string;
}

export type ReplyDraftType = 'customer_reply' | 'india_internal' | 'supplier_followup';
export type ReplyDraftStatus = 'draft' | 'edited' | 'discarded' | 'sent';

export interface AiReplyDraft {
  draft_id: string;
  trigger_message_id: string;
  inquiry_id: string;
  request_id?: string | null;
  draft_type: ReplyDraftType;
  recipient_address?: string;
  subject: string;
  body: string;
  model: string;
  generated_at: string;
  is_edited: boolean;
  status: ReplyDraftStatus;
  sent_at?: string | null;
  sent_message_id?: string | null;
}

export interface ExtractedParameter {
  parameter: string;
  extracted_value: string;
  unit?: string | null;
  specification_limit?: string | null;
  test_method?: string | null;
  evidence: string;
  page?: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface DocumentAiExtraction {
  status: 'pending' | 'processing' | 'suggested' | 'no_action' | 'failed' | 'accepted' | 'edited' | 'dismissed';
  document_type: 'COA' | 'MSDS' | 'SPEC' | 'OTHER' | string;
  confidence_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  needs_verification: boolean;
  product_name?: string | null;
  batch_number?: string | null;
  manufacturer?: string | null;
  manufacturing_date?: string | null;
  expiry_date?: string | null;
  document_number?: string | null;
  hazard_classification?: string | null;
  summary?: string;
  parameters: ExtractedParameter[];
  original_extraction?: Record<string, unknown> | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  dismissed_by?: string | null;
  dismissed_at?: string | null;
  edited_values?: Record<string, unknown> | null;
  extracted_at: string;
  model: string;
  retry_count?: number;
  retryable?: boolean;
  error?: string | null;
}

export interface GroundingCitation {
  text: string;
  reason: string;
}

export interface ProposedUpdate {
  request_id: string;
  field: 'customer_requirement' | 'parameters' | 'status' | 'waiting_for' | 'current_issue' | 'next_action' | 'assigned_team';
  old_value: unknown;
  new_value: unknown;
  reason: string;
}

export interface ProposedNewRequest {
  category: 'commercial' | 'technical' | 'document' | 'sample' | 'logistics' | 'custom';
  title: string;
  customer_requirement: string;
  parameters: Record<string, unknown>;
  waiting_for: 'INTERNAL' | 'INDIA' | 'MANUFACTURER' | 'CUSTOMER' | 'NONE';
  assigned_team?: 'sales' | 'pricing_india' | 'regulatory' | 'warehouse' | 'sourcing' | 'management';
  reason: string;
}

export interface AiProposal {
  status: 'pending' | 'processing' | 'suggested' | 'no_action' | 'failed' | 'accepted' | 'edited' | 'dismissed';
  intent: 'new_request' | 'clarification' | 'requirement_change' | 'supplier_response' | 'customer_decision' | 'no_action';
  confidence_tier: 'HIGH' | 'MEDIUM' | 'LOW';
  needs_verification: boolean;
  summary: string;
  grounding: GroundingCitation[];
  proposed_updates: ProposedUpdate[];
  proposed_new_requests: ProposedNewRequest[];
  suggested_next_action: string | null;
  suggested_waiting_for: 'INTERNAL' | 'INDIA' | 'MANUFACTURER' | 'CUSTOMER' | 'NONE' | null;
  suggested_team: string | null;
  analyzed_at: string;
  model: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  dismissed_by?: string | null;
  dismissed_at?: string | null;
  edited_values?: Record<string, unknown>;
  original_proposal?: Record<string, unknown> | null;
  error?: string;
  retry_count?: number;
  retryable?: boolean;
  started_at?: string;
  attempted_at?: string;
}

export interface IngestMessageParams {
  conversation_id: string;
  channel: EnquiryChannel;
  direction: MessageDirection;
  external_message_id?: string | null;
  sender_address: string;
  sender_name?: string | null;
  recipient_addresses?: string[];
  subject?: string | null;
  body_text?: string | null;
  body_html?: string | null;
  attachments?: MessageAttachment[];
  raw_payload?: Record<string, unknown>;
  received_or_sent_at?: string;
  actor?: EnquiryActor;
}

export interface GetOrCreateConversationParams {
  channel: EnquiryChannel;
  external_thread_id?: string | null;
  title: string;
  customer_id?: string | null;
  crm_contact_id?: string | null;
  participant_identifiers?: string[];
  metadata?: Record<string, unknown>;
}

export interface LinkConversationParams {
  conversation_id: string;
  inquiry_id: string;
  link_type?: ConversationLinkType;
  actor_id?: string | null;
}
