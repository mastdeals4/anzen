import { supabase } from '../../lib/supabase';
import {
  EnquiryConversation,
  EnquiryConversationLink,
  EnquiryMessage,
  GetOrCreateConversationParams,
  IngestMessageParams,
  LinkConversationParams,
} from '../../types/enquiry';
import { PrimaryConversationConflictError } from './enquiryErrors';

export class EnquiryConversationService {
  /**
   * Concurrency-safe conversation resolver by channel and external_thread_id.
   */
  static async getOrCreateConversation(
    params: GetOrCreateConversationParams
  ): Promise<EnquiryConversation> {
    const {
      channel,
      external_thread_id,
      title,
      customer_id = null,
      crm_contact_id = null,
      participant_identifiers = [],
      metadata = {},
    } = params;

    // If external_thread_id is provided, try looking it up first
    if (external_thread_id) {
      const { data: existing, error: findError } = await supabase
        .from('enquiry_conversations')
        .select('*')
        .eq('channel', channel)
        .eq('external_thread_id', external_thread_id)
        .maybeSingle();

      if (findError) throw findError;
      if (existing) return existing as EnquiryConversation;
    }

    // Insert new conversation
    const payload = {
      channel,
      external_thread_id: external_thread_id || null,
      title,
      customer_id,
      crm_contact_id,
      participant_identifiers,
      metadata,
      status: 'active',
      last_message_at: new Date().toISOString(),
    };

    const { data: created, error: insertError } = await supabase
      .from('enquiry_conversations')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) {
      // Concurrency collision on unique index: uq_enq_conv_channel_external_thread (23505)
      if (insertError.code === '23505' && external_thread_id) {
        const { data: winner, error: winnerError } = await supabase
          .from('enquiry_conversations')
          .select('*')
          .eq('channel', channel)
          .eq('external_thread_id', external_thread_id)
          .single();

        if (winnerError) throw winnerError;
        return winner as EnquiryConversation;
      }
      throw insertError;
    }

    return created as EnquiryConversation;
  }

  /**
   * Concurrency-safe idempotent message ingestion using (channel, external_message_id).
   */
  static async ingestMessage(
    params: IngestMessageParams
  ): Promise<{ message: EnquiryMessage; is_duplicate: boolean }> {
    const {
      conversation_id,
      channel,
      direction,
      external_message_id = null,
      sender_address,
      sender_name = null,
      recipient_addresses = [],
      subject = null,
      body_text = null,
      body_html = null,
      attachments = [],
      raw_payload = null,
      received_or_sent_at = new Date().toISOString(),
      actor = { actor_type: 'user', actor_id: null },
    } = params;

    // If external_message_id is provided, check if already present
    if (external_message_id) {
      const { data: existing, error: checkError } = await supabase
        .from('enquiry_conversation_messages')
        .select('*')
        .eq('channel', channel)
        .eq('external_message_id', external_message_id)
        .maybeSingle();

      if (checkError) throw checkError;
      if (existing) {
        return { message: existing as EnquiryMessage, is_duplicate: true };
      }
    }

    const payload = {
      conversation_id,
      channel,
      direction,
      external_message_id: external_message_id || null,
      sender_address,
      sender_name,
      recipient_addresses,
      subject,
      body_text,
      body_html,
      attachments,
      raw_payload,
      received_or_sent_at,
      actor_type: actor.actor_type,
      actor_id: actor.actor_id || null,
      ai_processed: false,
      ai_summary: null,
    };

    const { data: inserted, error: insertError } = await supabase
      .from('enquiry_conversation_messages')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) {
      // Catch race condition collision on unique index: uq_enq_msg_channel_external_id (23505)
      if (insertError.code === '23505' && external_message_id) {
        const { data: collisionWinner, error: fetchWinnerError } = await supabase
          .from('enquiry_conversation_messages')
          .select('*')
          .eq('channel', channel)
          .eq('external_message_id', external_message_id)
          .single();

        if (fetchWinnerError) throw fetchWinnerError;
        return { message: collisionWinner as EnquiryMessage, is_duplicate: true };
      }
      throw insertError;
    }

    // Touch conversation last_message_at
    await supabase
      .from('enquiry_conversations')
      .update({ last_message_at: received_or_sent_at })
      .eq('id', conversation_id);

    return { message: inserted as EnquiryMessage, is_duplicate: false };
  }

  /**
   * Link a conversation to an inquiry with single-active-primary guard.
   */
  static async linkConversation(
    params: LinkConversationParams
  ): Promise<EnquiryConversationLink> {
    const {
      conversation_id,
      inquiry_id,
      link_type = 'related',
      actor_id = null,
    } = params;

    if (link_type === 'primary') {
      const { data: existingPrimary, error: checkError } = await supabase
        .from('enquiry_conversation_links')
        .select('*')
        .eq('inquiry_id', inquiry_id)
        .eq('link_type', 'primary')
        .eq('is_active', true)
        .maybeSingle();

      if (checkError) throw checkError;

      if (existingPrimary && existingPrimary.conversation_id !== conversation_id) {
        throw new PrimaryConversationConflictError(inquiry_id, existingPrimary.conversation_id);
      }
    }

    const payload = {
      conversation_id,
      inquiry_id,
      link_type,
      is_active: true,
      created_by: actor_id,
    };

    const { data: link, error: insertError } = await supabase
      .from('enquiry_conversation_links')
      .upsert(payload, { onConflict: 'conversation_id,inquiry_id' })
      .select('*')
      .single();

    if (insertError) throw insertError;
    return link as EnquiryConversationLink;
  }

  /**
   * Deactivate a conversation link (e.g. historical unlinking).
   */
  static async deactivateLink(linkId: string): Promise<void> {
    const { error } = await supabase
      .from('enquiry_conversation_links')
      .update({ is_active: false })
      .eq('id', linkId);

    if (error) throw error;
  }

  /**
   * Get full conversation thread with messages and linked inquiries.
   */
  static async getConversationThread(conversation_id: string): Promise<{
    conversation: EnquiryConversation;
    messages: EnquiryMessage[];
    links: EnquiryConversationLink[];
  }> {
    const [convRes, msgsRes, linksRes] = await Promise.all([
      supabase.from('enquiry_conversations').select('*').eq('id', conversation_id).single(),
      supabase.from('enquiry_conversation_messages').select('*').eq('conversation_id', conversation_id).order('received_or_sent_at', { ascending: true }),
      supabase.from('enquiry_conversation_links').select('*').eq('conversation_id', conversation_id),
    ]);

    if (convRes.error) throw convRes.error;
    if (msgsRes.error) throw msgsRes.error;
    if (linksRes.error) throw linksRes.error;

    return {
      conversation: convRes.data as EnquiryConversation,
      messages: (msgsRes.data || []) as EnquiryMessage[],
      links: (linksRes.data || []) as EnquiryConversationLink[],
    };
  }
}
