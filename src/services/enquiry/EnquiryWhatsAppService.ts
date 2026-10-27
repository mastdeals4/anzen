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
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        error: err.message || 'WhatsApp adapter service unreachable on port 3100',
      };
    }
  }

  /**
   * Initiates OpenWA session connection / starts QR generation.
   */
  static async connectSession(): Promise<WhatsAppConnectionStatusResult> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/session/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        return {
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        error: err.message || 'Failed to connect WhatsApp session',
      };
    }
  }

  /**
   * Disconnects / logs out active WhatsApp session.
   */
  static async disconnectSession(): Promise<WhatsAppConnectionStatusResult> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/session/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        return {
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        error: err.message || 'Failed to disconnect WhatsApp session',
      };
    }
  }

  /**
   * Requests a fresh QR code for session authentication.
   */
  static async refreshQr(): Promise<WhatsAppConnectionStatusResult> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/session/refresh-qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        return {
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        error: err.message || 'Failed to refresh QR code',
      };
    }
  }

  /**
   * Pairs the business WhatsApp session (confirms scan or sets verified business phone).
   */
  static async pairSession(phone?: string): Promise<WhatsAppConnectionStatusResult> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/session/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        return {
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        error: err.message || 'Failed to pair session',
      };
    }
  }

  /**
   * Injects an inbound test message to verify end-to-end ingestion into ERP.
   */
  static async injectTestInbound(payload: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    try {
      const adapterUrl = import.meta.env.VITE_WHATSAPP_ADAPTER_URL || 'http://localhost:3100';
      const res = await fetch(`${adapterUrl}/api/test/inject-inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Failed to trigger test inbound message',
      };
    }
  }
}
