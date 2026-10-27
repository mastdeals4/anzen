import { supabase } from '../../lib/supabase';
import { AiReplyDraft, ReplyDraftType } from '../../types/enquiry';

export interface GenerateDraftParams {
  message_id: string;
  inquiry_id: string;
  request_id?: string;
  draft_type?: ReplyDraftType;
  tone?: 'professional' | 'concise' | 'friendly';
}

export interface GenerateDraftResult {
  success: boolean;
  draft?: AiReplyDraft;
  error?: string;
}

export class EnquiryBrainDraftService {
  /**
   * Generates a context-aware AI reply draft for an inbound message.
   * Produces a DRAFT ONLY; never auto-sends.
   */
  static async generateReplyDraft(params: GenerateDraftParams): Promise<GenerateDraftResult> {
    try {
      const { data, error } = await supabase.functions.invoke('enquiry-brain-draft', {
        body: params,
      });

      if (error) {
        return {
          success: false,
          error: error.message || 'Failed to generate reply draft',
        };
      }

      return data as GenerateDraftResult;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Unexpected error generating reply draft',
      };
    }
  }

  /**
   * Retrieves the current AI reply draft for a message.
   */
  static async getDraft(messageId: string): Promise<AiReplyDraft | null> {
    const { data, error } = await supabase
      .from('enquiry_conversation_messages')
      .select('ai_reply_draft')
      .eq('id', messageId)
      .maybeSingle();

    if (error || !data) return null;
    return (data.ai_reply_draft as AiReplyDraft) || null;
  }

  /**
   * Updates draft status (e.g. when human edits, discards, or completes sending via composer).
   */
  static async updateDraftStatus(
    messageId: string,
    status: 'draft' | 'edited' | 'discarded' | 'sent',
    options?: {
      edited_body?: string;
      edited_subject?: string;
      sent_message_id?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const current = await this.getDraft(messageId);
      if (!current) return { success: false, error: 'Draft not found' };

      const updatedDraft: AiReplyDraft = {
        ...current,
        status,
        is_edited: status === 'edited' ? true : current.is_edited,
        body: options?.edited_body !== undefined ? options.edited_body : current.body,
        subject: options?.edited_subject !== undefined ? options.edited_subject : current.subject,
        sent_at: status === 'sent' ? new Date().toISOString() : current.sent_at,
        sent_message_id: options?.sent_message_id || current.sent_message_id,
      };

      const { error } = await supabase
        .from('enquiry_conversation_messages')
        .update({
          ai_reply_draft: updatedDraft,
        })
        .eq('id', messageId);

      if (error) throw error;
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to update draft status' };
    }
  }
}
