// src/services/enquiry/EnquiryWhatsAppService.ts
//
// Client service for human-initiated WhatsApp communication in Anzen ERP.
// Strictly enforces human review gate — AI never invokes outbound sending directly.

import { supabase } from '../../lib/supabase';

export interface SendWhatsAppMessageParams {
  conversationId: string;
  text: string;
  draftMessageId?: string | null;
}

export interface SendWhatsAppMessageResult {
  success: boolean;
  messageId?: string;
  externalMessageId?: string;
  linkedInquiryId?: string | null;
  error?: string;
}

export interface WhatsAppConnectionStatusResult {
  status: 'connected' | 'disconnected' | 'unpaired' | 'error';
  session: string;
  businessPhone?: string | null;
  lastSeen?: string;
  qrCode?: string | null;
  error?: string;
}

export class EnquiryWhatsAppService {
  /**
   * Dispatches an outbound WhatsApp reply to a canonical conversation.
   * Requires explicit human action and authenticated user permissions (admin, manager, sales).
   * Server strictly determines permitted recipient phone from the conversation.
   */
  static async sendWhatsAppMessage(
    params: SendWhatsAppMessageParams
  ): Promise<SendWhatsAppMessageResult> {
    try {
      const { data, error } = await supabase.functions.invoke('enquiry-whatsapp-outbound', {
        body: {
          conversation_id: params.conversationId,
          text: params.text,
          draft_message_id: params.draftMessageId || null,
        },
      });

      if (error) {
        return {
          success: false,
          error: error.message || 'Failed to dispatch WhatsApp reply',
        };
      }

      if (!data?.success) {
        return {
          success: false,
          error: data?.error || 'WhatsApp provider rejected send request',
        };
      }

      return {
        success: true,
        messageId: data.messageId,
        externalMessageId: data.externalMessageId,
        linkedInquiryId: data.linkedInquiryId,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Unexpected network error dispatching WhatsApp reply',
      };
    }
  }

  /**
   * Fetches WhatsApp transport adapter connection and pairing status.
   */
  static async getConnectionStatus(): Promise<WhatsAppConnectionStatusResult> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/status`);
      if (!res.ok) {
        return {
          status: 'error',
          session: 'staging',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'staging',
        error: err.message || 'Adapter unreachable',
      };
    }
  }
}
