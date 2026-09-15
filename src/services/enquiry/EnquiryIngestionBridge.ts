// src/services/enquiry/EnquiryIngestionBridge.ts
//
// Client-side / Service-layer bridge to canonical communication ingestion.
// Provides typed inspection of canonical conversations, message timelines,
// and durable anti-join reconciliation helpers for diagnostics.

import { supabase } from '../../lib/supabase';
import { EnquiryConversation, EnquiryMessage } from '../../types/enquiry';

export interface UnmirroredInboxSummary {
  unmirroredCount: number;
  oldestUnmirroredAt: string | null;
  newestUnmirroredAt: string | null;
}

export class EnquiryIngestionBridge {
  /**
   * Get all canonical messages associated with an inquiry across all linked conversations.
   */
  static async getCanonicalMessagesForInquiry(inquiryId: string): Promise<EnquiryMessage[]> {
    // 1. Get conversation IDs linked to this inquiry
    const { data: links, error: linksError } = await supabase
      .from('enquiry_conversation_links')
      .select('conversation_id')
      .eq('inquiry_id', inquiryId)
      .eq('is_active', true);

    if (linksError) throw linksError;
    if (!links || links.length === 0) return [];

    const conversationIds = links.map(l => l.conversation_id);

    // 2. Fetch messages for these conversations
    const { data: messages, error: msgsError } = await supabase
      .from('enquiry_conversation_messages')
      .select('*')
      .in('conversation_id', conversationIds)
      .order('received_or_sent_at', { ascending: true });

    if (msgsError) throw msgsError;
    return (messages || []) as EnquiryMessage[];
  }

  /**
   * Get canonical conversation and message thread by Gmail external thread ID.
   */
  static async getCanonicalThreadByGmailThreadId(gmailThreadId: string): Promise<{
    conversation: EnquiryConversation | null;
    messages: EnquiryMessage[];
  }> {
    const { data: conv, error: convError } = await supabase
      .from('enquiry_conversations')
      .select('*')
      .eq('channel', 'email')
      .eq('external_thread_id', gmailThreadId)
      .maybeSingle();

    if (convError) throw convError;
    if (!conv) return { conversation: null, messages: [] };

    const { data: messages, error: msgsError } = await supabase
      .from('enquiry_conversation_messages')
      .select('*')
      .eq('conversation_id', conv.id)
      .order('received_or_sent_at', { ascending: true });

    if (msgsError) throw msgsError;

    return {
      conversation: conv as EnquiryConversation,
      messages: (messages || []) as EnquiryMessage[],
    };
  }

  /**
   * Diagnostic check: Count unmirrored inbound messages in crm_email_inbox.
   */
  static async getUnmirroredInboundCount(): Promise<number> {
    const { data: inboxRows, error: inbError } = await supabase
      .from('crm_email_inbox')
      .select('message_id')
      .not('message_id', 'is', null)
      .limit(500);

    if (inbError || !inboxRows || inboxRows.length === 0) return 0;

    const messageIds = inboxRows.map(r => r.message_id);
    const { data: canonicalMsgs } = await supabase
      .from('enquiry_conversation_messages')
      .select('external_message_id')
      .eq('channel', 'email')
      .in('external_message_id', messageIds);

    const existingSet = new Set((canonicalMsgs || []).map(r => r.external_message_id));
    return messageIds.filter(id => !existingSet.has(id)).length;
  }
}
