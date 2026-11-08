// src/services/enquiry/EnquiryWhatsAppService.ts
//
// Client service for human-initiated WhatsApp communication in Anzen ERP.
// Deeply integrated with official Meta WhatsApp Cloud API and isolated adapters.
// Strictly enforces human review gate — AI never invokes outbound sending directly.
// Never fabricates mock message IDs as genuine deliveries.

import { supabase } from '../../lib/supabase';
import { WhatsAppTransportService } from '../whatsapp/whatsappTransportService';
import { WhatsAppDeliveryState } from '../whatsapp/types';

export interface SendWhatsAppMessageParams {
  conversationId: string;
  text?: string;
  documentUrl?: string;
  filename?: string;
  imageUrl?: string;
  caption?: string;
  draftMessageId?: string | null;
  inquiryId?: string | null;
}

export interface SendWhatsAppMessageResult {
  success: boolean;
  messageId?: string;
  externalMessageId?: string;
  status: WhatsAppDeliveryState;
  isSimulation: boolean;
  linkedInquiryId?: string | null;
  error?: string;
}

export interface WhatsAppConnectionStatusResult {
  status: 'connected' | 'disconnected' | 'unpaired' | 'error' | 'configured' | 'unconfigured';
  session: string;
  provider: 'meta_cloud' | 'openwa_adapter' | 'simulation';
  businessPhone?: string | null;
  businessJid?: string | null;
  identityVerifiedAt?: string | null;
  identitySource?: string | null;
  lastSeen?: string;
  qrCode?: string | null;
  error?: string;
  protected?: boolean;
  isSimulation?: boolean;
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
      // 1. Resolve canonical conversation and destination phone
      const { data: conv, error: convErr } = await supabase
        .from('enquiry_conversations')
        .select('id, participant_identifiers, external_thread_id, channel, customer_id')
        .eq('id', params.conversationId)
        .maybeSingle();

      if (convErr || !conv) {
        return {
          success: false,
          status: 'failed',
          isSimulation: false,
          error: `Canonical conversation ${params.conversationId} not found`,
        };
      }

      let recipientPhone = '';
      if (conv.participant_identifiers?.length) {
        recipientPhone = conv.participant_identifiers[0];
      } else if (conv.external_thread_id) {
        recipientPhone = conv.external_thread_id
          .split(':')[0]
          .replace('@c.us', '')
          .replace('@lid', '');
      }

      if (!recipientPhone) {
        return {
          success: false,
          status: 'failed',
          isSimulation: false,
          error: 'Could not resolve destination phone number from conversation participants',
        };
      }

      // 2. Dispatch via Transport Provider (Meta Cloud API / OpenWA / Simulation)
      const sendResult = await WhatsAppTransportService.sendMessage({
        to: recipientPhone,
        text: params.text,
        documentUrl: params.documentUrl,
        filename: params.filename,
        imageUrl: params.imageUrl,
        caption: params.caption,
      });

      if (!sendResult.success) {
        return {
          success: false,
          status: 'failed',
          isSimulation: sendResult.isSimulation,
          error: sendResult.error || 'WhatsApp provider rejected message dispatch',
        };
      }

      // 3. Provider confirmed acceptance: record canonical message with genuine message ID
      const { data: userAuth } = await supabase.auth.getUser();
      const attachments = [];
      if (params.documentUrl) {
        attachments.push({
          filename: params.filename || 'Document.pdf',
          url: params.documentUrl,
          content_type: 'application/pdf',
        });
      }
      if (params.imageUrl) {
        attachments.push({
          filename: params.filename || 'Image.jpg',
          url: params.imageUrl,
          content_type: 'image/jpeg',
        });
      }

      const { data: insertedMsg, error: insErr } = await supabase
        .from('enquiry_conversation_messages')
        .insert({
          conversation_id: params.conversationId,
          channel: 'whatsapp',
          direction: 'outbound',
          external_message_id: sendResult.externalMessageId,
          sender_address: '+6285888600999',
          sender_name: 'SAPJ Sales',
          recipient_addresses: [recipientPhone],
          subject: params.filename ? `WhatsApp Attachment: ${params.filename}` : 'WhatsApp Outbound Reply',
          body_text: params.text || (params.filename ? `[Sent Document: ${params.filename}]` : ''),
          attachments: attachments.length > 0 ? attachments : null,
          raw_payload: sendResult.rawResponse || null,
          received_or_sent_at: new Date().toISOString(),
          actor_type: 'user',
          actor_id: userAuth?.user?.id || null,
        })
        .select('id')
        .maybeSingle();

      if (insErr) {
        console.error('[EnquiryWhatsAppService] Error recording outbound message:', insErr);
      }

      // Update conversation last_message_at
      await supabase
        .from('enquiry_conversations')
        .update({
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.conversationId);

      // Link inquiry if specified
      if (params.inquiryId) {
        try {
          await supabase.from('enquiry_conversation_links').insert({
            conversation_id: params.conversationId,
            inquiry_id: params.inquiryId,
            link_type: 'primary',
            is_active: true,
            created_by: userAuth?.user?.id || null,
          });
        } catch {
          // ignore duplicate link errors
        }
      }

      return {
        success: true,
        messageId: insertedMsg?.id || sendResult.externalMessageId,
        externalMessageId: sendResult.externalMessageId,
        status: sendResult.status,
        isSimulation: sendResult.isSimulation,
        linkedInquiryId: params.inquiryId || null,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'failed',
        isSimulation: false,
        error: err.message || 'Unexpected network error dispatching WhatsApp reply',
      };
    }
  }

  private static getBaseUrl(): string {
    return import.meta.env.VITE_WHATSAPP_PROXY_URL || '/api/whatsapp';
  }

  private static getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }

  /**
   * Fetches WhatsApp transport connection and pairing status across Meta Cloud API, OpenWA, or Simulation.
   */
  static async getConnectionStatus(): Promise<WhatsAppConnectionStatusResult> {
    const config = WhatsAppTransportService.getConfig();
    const activeProvider = config.providerType;

    if (activeProvider === 'meta_cloud') {
      const health = await WhatsAppTransportService.checkHealth();
      return {
        status: health.status as any,
        session: 'meta-cloud-api-production',
        provider: 'meta_cloud',
        businessPhone: health.businessPhone || null,
        identitySource: 'Meta Business Manager / Graph API v21.0',
        error: health.status === 'error' || health.status === 'unconfigured' ? health.details : undefined,
        isSimulation: false,
      };
    }

    if (activeProvider === 'simulation') {
      const health = await WhatsAppTransportService.checkHealth();
      return {
        status: 'configured',
        session: 'simulation-harness',
        provider: 'simulation',
        businessPhone: health.businessPhone,
        identitySource: 'Local Simulation Harness',
        isSimulation: true,
      };
    }

    // Default: OpenWA Local Adapter proxy
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/status`, {
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          status: 'error',
          session: 'sapj-business-whatsapp',
          provider: 'openwa_adapter',
          error: `HTTP ${res.status}: ${res.statusText}`,
          isSimulation: false,
        };
      }
      const data = await res.json();
      return {
        ...data,
        provider: 'openwa_adapter',
        isSimulation: false,
      };
    } catch (err: any) {
      return {
        status: 'disconnected',
        session: 'sapj-business-whatsapp',
        provider: 'openwa_adapter',
        error: err.message || 'WhatsApp adapter service unreachable via proxy',
        isSimulation: false,
      };
    }
  }

  /**
   * Initiates OpenWA session connection / starts QR generation.
   */
  static async connectSession(): Promise<WhatsAppConnectionStatusResult> {
    try {
      const res = await fetch(`${this.getBaseUrl()}/api/session/connect`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          provider: 'openwa_adapter',
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        provider: 'openwa_adapter',
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
      const res = await fetch(`${this.getBaseUrl()}/api/session/disconnect`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          provider: 'openwa_adapter',
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        provider: 'openwa_adapter',
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
      const res = await fetch(`${this.getBaseUrl()}/api/session/refresh-qr`, {
        method: 'POST',
        headers: this.getHeaders(),
      });
      if (!res.ok) {
        return {
          provider: 'openwa_adapter',
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        provider: 'openwa_adapter',
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
      const res = await fetch(`${this.getBaseUrl()}/api/session/pair`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ phone }),
      });
      if (!res.ok) {
        return {
          provider: 'openwa_adapter',
          status: 'error',
          session: 'sapj-business-whatsapp',
          error: `HTTP ${res.status}: ${res.statusText}`,
        };
      }
      return await res.json();
    } catch (err: any) {
      return {
        provider: 'openwa_adapter',
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
      const res = await fetch(`${this.getBaseUrl()}/api/test/inject-inbound`, {
        method: 'POST',
        headers: this.getHeaders(),
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
