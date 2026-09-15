import { supabase } from '../../lib/supabase';
import { AiProposal } from '../../types/enquiry';

export interface AnalyzeMessageResult {
  success: boolean;
  cached?: boolean;
  message_id?: string;
  status?: 'pending' | 'processing' | 'suggested' | 'no_action' | 'failed' | 'accepted' | 'edited' | 'dismissed';
  ai_proposal?: AiProposal;
  error?: string;
  retryable?: boolean;
}

export interface ProposalFreshnessResult {
  fresh: boolean;
  conflictReason?: string;
}

export class EnquiryBrainService {
  /**
   * Triggers or retrieves the Enquiry Brain analysis for a canonical message.
   * Calls the edge function `enquiry-brain-analyze`.
   * This is an INTERPRETATION call only; it NEVER mutates enquiry_requests or crm_inquiries.
   */
  static async analyzeMessage(
    messageId: string,
    options: { forceReanalyze?: boolean } = {}
  ): Promise<AnalyzeMessageResult> {
    try {
      const { data, error } = await supabase.functions.invoke('enquiry-brain-analyze', {
        body: {
          message_id: messageId,
          force_reanalyze: !!options.forceReanalyze,
        },
      });

      if (error) {
        return {
          success: false,
          error: error.message || 'Failed to invoke enquiry-brain-analyze',
          retryable: true,
        };
      }

      return data as AnalyzeMessageResult;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Unexpected error analyzing message',
        retryable: true,
      };
    }
  }

  /**
   * Fetches the current AI proposal directly from the canonical message record.
   */
  static async getProposal(messageId: string): Promise<AiProposal | null> {
    const { data, error } = await supabase
      .from('enquiry_conversation_messages')
      .select('ai_proposal')
      .eq('id', messageId)
      .maybeSingle();

    if (error || !data) return null;
    return (data.ai_proposal as AiProposal) || null;
  }

  /**
   * Validates whether a proposal is still fresh against current database state.
   * Prevents overwriting newer human changes.
   */
  static async validateProposalFreshness(proposal: AiProposal): Promise<ProposalFreshnessResult> {
    if (!proposal.proposed_updates || proposal.proposed_updates.length === 0) {
      return { fresh: true };
    }

    const requestIds = [...new Set(proposal.proposed_updates.map((u) => u.request_id))];
    const { data: currentReqs, error } = await supabase
      .from('enquiry_requests')
      .select('id, customer_requirement, status, waiting_for, current_issue, next_action, assigned_team')
      .in('id', requestIds);

    if (error) {
      return { fresh: false, conflictReason: `Database error checking request state: ${error.message}` };
    }

    const reqMap = new Map<string, any>((currentReqs || []).map((r) => [r.id, r]));

    for (const update of proposal.proposed_updates) {
      const current = reqMap.get(update.request_id);
      if (!current) {
        return {
          fresh: false,
          conflictReason: `Target request (${update.request_id}) no longer exists. Fresh review required.`,
        };
      }

      // If update specifies an old_value, verify it still matches current state
      if (update.old_value !== undefined && update.old_value !== null) {
        if (update.field === 'customer_requirement') {
          const currentText = String(current.customer_requirement || '').trim();
          const expectedOld = String(update.old_value).trim();
          if (currentText !== expectedOld) {
            return {
              fresh: false,
              conflictReason: `Request changed since this AI suggestion was created. Please review again. (Requirement: "${expectedOld}" → "${currentText}")`,
            };
          }
        } else if (update.field === 'status') {
          if (current.status !== update.old_value) {
            return {
              fresh: false,
              conflictReason: `Request changed since this AI suggestion was created. Please review again. (Status: ${update.old_value} → ${current.status})`,
            };
          }
        } else if (update.field === 'waiting_for') {
          if (current.waiting_for !== update.old_value) {
            return {
              fresh: false,
              conflictReason: `Request changed since this AI suggestion was created. Please review again. (Waiting: ${update.old_value} → ${current.waiting_for})`,
            };
          }
        }
      }
    }

    return { fresh: true };
  }

  /**
   * Accepts an AI proposal: validates freshness atomically inside database transaction,
   * applies updates and/or new requests via accept_enquiry_brain_proposal_atomic,
   * logs immutable audit events with actor_type='user', and updates proposal status to 'accepted'.
   * Never creates internal tasks.
   */
  static async acceptProposal(
    messageId: string,
    proposal: AiProposal,
    inquiryId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;
      if (!user) throw new Error('Unauthenticated: you must be logged in to approve an AI proposal');

      // Pre-flight freshness check for instant UI response
      const freshness = await this.validateProposalFreshness(proposal);
      if (!freshness.fresh) {
        return { success: false, error: freshness.conflictReason || 'Proposal is stale and cannot be accepted' };
      }

      // Build expected values map for inside-transaction atomic verification
      const expectedValues: Record<string, unknown> = {};
      for (const u of proposal.proposed_updates || []) {
        if (u.old_value !== undefined && u.old_value !== null) {
          expectedValues[u.field] = u.old_value;
        }
      }

      // Execute atomic transaction with FOR UPDATE row locks
      const { data, error: rpcErr } = await supabase.rpc('accept_enquiry_brain_proposal_atomic', {
        p_message_id: messageId,
        p_inquiry_id: inquiryId,
        p_expected_values: Object.keys(expectedValues).length > 0 ? expectedValues : null,
        p_actor_type: 'user',
        p_actor_id: user.id,
      });

      if (rpcErr) {
        if (rpcErr.message?.includes('STALE_PROPOSAL') || (rpcErr as any).code === 'P0001') {
          return {
            success: false,
            error: 'Request changed since this AI suggestion was created. Please review again.',
          };
        }
        if (rpcErr.message?.includes('PROPOSAL_ALREADY_PROCESSED') || (rpcErr as any).code === 'P0002') {
          return {
            success: false,
            error: 'AI proposal has already been processed.',
          };
        }
        throw rpcErr;
      }

      return { success: true };
    } catch (err: any) {
      if (err.message?.includes('STALE_PROPOSAL') || err.code === 'P0001') {
        return {
          success: false,
          error: 'Request changed since this AI suggestion was created. Please review again.',
        };
      }
      if (err.message?.includes('PROPOSAL_ALREADY_PROCESSED') || err.code === 'P0002') {
        return {
          success: false,
          error: 'AI proposal has already been processed.',
        };
      }
      return { success: false, error: err.message || 'Failed to accept AI proposal' };
    }
  }

  /**
   * Applies an edited AI proposal with human-corrected values via atomic RPC.
   * Logs that the proposal was edited by the user and preserves the original AI proposal.
   */
  static async editProposal(
    messageId: string,
    originalProposal: AiProposal,
    editedValues: {
      target_request_id?: string;
      customer_requirement?: string;
      status?: string;
      waiting_for?: string;
      next_action?: string;
      assigned_team?: string;
      summary?: string;
    },
    inquiryId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;
      if (!user) throw new Error('Unauthenticated: you must be logged in to edit an AI proposal');

      // Pre-flight check if target request exists
      if (editedValues.target_request_id) {
        const { data: targetReq } = await supabase
          .from('enquiry_requests')
          .select('id, status, customer_requirement, waiting_for')
          .eq('id', editedValues.target_request_id)
          .maybeSingle();

        if (!targetReq) {
          return { success: false, error: 'Target request no longer exists.' };
        }
      }

      // Build expected values from original proposal if editing an existing request
      const expectedValues: Record<string, unknown> = {};
      if (editedValues.target_request_id) {
        for (const u of originalProposal.proposed_updates || []) {
          if (u.request_id === editedValues.target_request_id && u.old_value !== undefined && u.old_value !== null) {
            expectedValues[u.field] = u.old_value;
          }
        }
      }

      // Execute atomic edit with FOR UPDATE row locks
      const { data, error: rpcErr } = await supabase.rpc('edit_enquiry_brain_proposal_atomic', {
        p_message_id: messageId,
        p_inquiry_id: inquiryId,
        p_edited_values: editedValues,
        p_expected_values: Object.keys(expectedValues).length > 0 ? expectedValues : null,
        p_actor_type: 'user',
        p_actor_id: user.id,
      });

      if (rpcErr) {
        if (rpcErr.message?.includes('STALE_PROPOSAL') || (rpcErr as any).code === 'P0001') {
          return {
            success: false,
            error: 'Request changed since this AI suggestion was created. Please review again.',
          };
        }
        if (rpcErr.message?.includes('PROPOSAL_ALREADY_PROCESSED') || (rpcErr as any).code === 'P0002') {
          return {
            success: false,
            error: 'AI proposal has already been processed.',
          };
        }
        throw rpcErr;
      }

      return { success: true };
    } catch (err: any) {
      if (err.message?.includes('STALE_PROPOSAL') || err.code === 'P0001') {
        return {
          success: false,
          error: 'Request changed since this AI suggestion was created. Please review again.',
        };
      }
      if (err.message?.includes('PROPOSAL_ALREADY_PROCESSED') || err.code === 'P0002') {
        return {
          success: false,
          error: 'AI proposal has already been processed.',
        };
      }
      return { success: false, error: err.message || 'Failed to apply edited AI proposal' };
    }
  }

  /**
   * Dismisses an AI proposal atomically: preserves the original proposal, marks status='dismissed',
   * and modifies ZERO business state.
   */
  static async dismissProposal(
    messageId: string,
    proposal: AiProposal
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const authResp = await supabase.auth.getUser();
      const user = authResp.data.user;

      const { data, error: rpcErr } = await supabase.rpc('dismiss_enquiry_brain_proposal_atomic', {
        p_message_id: messageId,
        p_actor_type: 'user',
        p_actor_id: user?.id || null,
      });

      if (rpcErr) {
        if (rpcErr.message?.includes('PROPOSAL_ALREADY_PROCESSED') || (rpcErr as any).code === 'P0002') {
          return {
            success: false,
            error: 'AI proposal has already been processed.',
          };
        }
        throw rpcErr;
      }

      return { success: true };
    } catch (err: any) {
      if (err.message?.includes('PROPOSAL_ALREADY_PROCESSED') || err.code === 'P0002') {
        return {
          success: false,
          error: 'AI proposal has already been processed.',
        };
      }
      return { success: false, error: err.message || 'Failed to dismiss AI proposal' };
    }
  }

  /**
   * Fetches messages that are currently in pending, processing, or failed analysis states.
   */
  static async getPendingAnalyses(inquiryId?: string): Promise<Array<{
    message_id: string;
    conversation_id: string;
    status: string;
    retry_count?: number;
    error?: string;
    created_at: string;
  }>> {
    let query = supabase
      .from('enquiry_conversation_messages')
      .select('id, conversation_id, ai_proposal, ai_processed, created_at')
      .eq('direction', 'inbound')
      .eq('ai_processed', false)
      .order('created_at', { ascending: false });

    if (inquiryId) {
      const { data: links } = await supabase
        .from('enquiry_conversation_links')
        .select('conversation_id')
        .eq('inquiry_id', inquiryId)
        .eq('is_active', true);

      const convIds = (links || []).map((l: { conversation_id: string }) => l.conversation_id);
      if (convIds.length === 0) return [];
      query = query.in('conversation_id', convIds);
    }

    const { data, error } = await query;
    if (error || !data) return [];

    return data.map((row: any) => ({
      message_id: row.id,
      conversation_id: row.conversation_id,
      status: row.ai_proposal?.status || 'pending',
      retry_count: row.ai_proposal?.retry_count || 0,
      error: row.ai_proposal?.error,
      created_at: row.created_at,
    }));
  }

  /**
   * Retries an analysis for a message that previously failed or is pending.
   * Forces re-analysis if it failed before.
   */
  static async retryFailedAnalysis(messageId: string): Promise<AnalyzeMessageResult> {
    return this.analyzeMessage(messageId, { forceReanalyze: true });
  }
}
