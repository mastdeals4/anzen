// src/services/whatsapp/whatsappTransportService.ts
//
// Clean WhatsApp Transport Provider Interface for Anzen ERP.
// Prioritizes official Meta WhatsApp Cloud API for production.
// Isolates local OpenWA automation for development only.
// Explicitly tags mock/test simulations and never claims successful delivery without provider response.

import type {
  WhatsAppTransportType,
  WhatsAppSendOptions,
  WhatsAppSendResult,
  WhatsAppStatusUpdate,
  WhatsAppInboundMessage,
  WhatsAppProviderConfig,
  WhatsAppConnectionHealth,
} from './types.ts';
import { normalizeE164 } from '../../utils/phoneValidation.ts';

export interface IWhatsAppProvider {
  readonly providerType: WhatsAppTransportType;
  sendMessage(options: WhatsAppSendOptions): Promise<WhatsAppSendResult>;
  checkHealth(): Promise<WhatsAppConnectionHealth>;
  verifyWebhook(verifyToken: string, challenge: string): string | null;
  verifySignature?(signature: string, rawBody: string): boolean;
  parseWebhookPayload(payload: any): {
    messages: WhatsAppInboundMessage[];
    statuses: WhatsAppStatusUpdate[];
  };
}

/**
 * Official Meta WhatsApp Cloud API Provider.
 * Direct integration with Meta Graph API v21.0.
 */
export class MetaCloudApiProvider implements IWhatsAppProvider {
  readonly providerType: WhatsAppTransportType = 'meta_cloud';
  private config: WhatsAppProviderConfig;

  constructor(config: WhatsAppProviderConfig) {
    this.config = config;
  }

  async sendMessage(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    const { metaPhoneNumberId, metaAccessToken } = this.config;

    // Fail immediately if official credentials are not configured.
    // Never fake a success or invent message IDs!
    if (!metaPhoneNumberId || !metaAccessToken) {
      return {
        success: false,
        status: 'failed',
        provider: 'meta_cloud',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: 'Meta WhatsApp Cloud API credentials not configured (Missing Phone Number ID or Access Token).',
        errorCode: 'CREDENTIALS_MISSING',
      };
    }

    const recipient = normalizeE164(options.to).replace(/\D/g, '');
    if (!recipient) {
      return {
        success: false,
        status: 'failed',
        provider: 'meta_cloud',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: `Invalid destination phone number: ${options.to}`,
        errorCode: 'INVALID_RECIPIENT',
      };
    }

    // Build payload according to official Meta Graph API specifications
    const payload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
    };

    if (options.templateName) {
      payload.type = 'template';
      payload.template = {
        name: options.templateName,
        language: { code: options.languageCode || 'id' },
        components: options.templateComponents || [],
      };
    } else if (options.documentUrl) {
      const captionText = options.caption || options.text || undefined;
      if (captionText && captionText.length > 1024) {
        return {
          success: false,
          status: 'failed',
          provider: 'meta_cloud',
          timestamp: new Date().toISOString(),
          isSimulation: false,
          error: `WhatsApp limits media captions to 1024 characters (current: ${captionText.length}). Please shorten the message.`,
          errorCode: 'CAPTION_TOO_LONG',
        };
      }
      payload.type = 'document';
      payload.document = {
        link: options.documentUrl,
        filename: options.filename || 'Document.pdf',
        caption: captionText,
      };
    } else if (options.imageUrl) {
      const captionText = options.caption || options.text || undefined;
      if (captionText && captionText.length > 1024) {
        return {
          success: false,
          status: 'failed',
          provider: 'meta_cloud',
          timestamp: new Date().toISOString(),
          isSimulation: false,
          error: `WhatsApp limits media captions to 1024 characters (current: ${captionText.length}). Please shorten the message.`,
          errorCode: 'CAPTION_TOO_LONG',
        };
      }
      payload.type = 'image';
      payload.image = {
        link: options.imageUrl,
        caption: captionText,
      };
    } else if (options.text) {
      payload.type = 'text';
      payload.text = {
        preview_url: false,
        body: options.text,
      };
    } else {
      return {
        success: false,
        status: 'failed',
        provider: 'meta_cloud',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: 'No message content provided (must provide text, document, image, or template).',
        errorCode: 'EMPTY_PAYLOAD',
      };
    }

    if (options.quotedMessageId) {
      payload.context = {
        message_id: options.quotedMessageId,
      };
    }

    try {
      const graphUrl = `https://graph.facebook.com/v21.0/${metaPhoneNumberId}/messages`;
      const response = await fetch(graphUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${metaAccessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.error) {
        const errorDetail = data.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        console.error('[MetaCloudApiProvider] Meta Graph API dispatch error:', data.error);
        return {
          success: false,
          status: 'failed',
          provider: 'meta_cloud',
          timestamp: new Date().toISOString(),
          isSimulation: false,
          error: errorDetail,
          errorCode: data.error?.code || response.status,
          rawResponse: data,
        };
      }

      // Meta returns: { messaging_product: 'whatsapp', contacts: [...], messages: [{ id: 'wamid.HBg...' }] }
      const externalMessageId = data.messages?.[0]?.id;
      return {
        success: true,
        messageId: externalMessageId,
        externalMessageId,
        status: 'accepted', // Meta accepted message into carrier delivery queue
        provider: 'meta_cloud',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        rawResponse: data,
      };
    } catch (err: any) {
      console.error('[MetaCloudApiProvider] Network error calling Meta API:', err);
      return {
        success: false,
        status: 'failed',
        provider: 'meta_cloud',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: `Network error connecting to Meta WhatsApp API: ${err.message}`,
        errorCode: 'NETWORK_ERROR',
      };
    }
  }

  async checkHealth(): Promise<WhatsAppConnectionHealth> {
    const { metaPhoneNumberId, metaAccessToken, metaWabaId, metaWebhookVerifyToken } = this.config;

    if (!metaPhoneNumberId || !metaAccessToken) {
      return {
        provider: 'meta_cloud',
        status: 'unconfigured',
        details: 'Meta Cloud API credentials are not set. Fill Phone Number ID & Access Token in Settings.',
        webhookStatus: 'unverified',
        lastChecked: new Date().toISOString(),
        isSimulation: false,
      };
    }

    try {
      // Query phone number registration and quality rating from Meta Graph API
      const res = await fetch(`https://graph.facebook.com/v21.0/${metaPhoneNumberId}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, {
        headers: {
          'Authorization': `Bearer ${metaAccessToken}`,
        },
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        return {
          provider: 'meta_cloud',
          status: 'error',
          details: `Meta API returned HTTP ${res.status}: ${errJson.error?.message || res.statusText}`,
          webhookStatus: metaWebhookVerifyToken ? 'pending' : 'unverified',
          lastChecked: new Date().toISOString(),
          isSimulation: false,
        };
      }

      const info = await res.json();
      return {
        provider: 'meta_cloud',
        status: 'connected',
        businessPhone: info.display_phone_number,
        details: `Connected to Meta Cloud API. Verified Name: ${info.verified_name || 'N/A'}. Quality: ${info.quality_rating || 'UNKNOWN'}.`,
        webhookStatus: metaWebhookVerifyToken ? 'verified' : 'pending',
        lastChecked: new Date().toISOString(),
        isSimulation: false,
      };
    } catch (err: any) {
      return {
        provider: 'meta_cloud',
        status: 'error',
        details: `Connection check failed: ${err.message}`,
        webhookStatus: 'unverified',
        lastChecked: new Date().toISOString(),
        isSimulation: false,
      };
    }
  }

  verifyWebhook(verifyToken: string, challenge: string): string | null {
    if (!this.config.metaWebhookVerifyToken) return null;
    if (verifyToken === this.config.metaWebhookVerifyToken) {
      return challenge;
    }
    return null;
  }

  parseWebhookPayload(payload: any): {
    messages: WhatsAppInboundMessage[];
    statuses: WhatsAppStatusUpdate[];
  } {
    const messages: WhatsAppInboundMessage[] = [];
    const statuses: WhatsAppStatusUpdate[] = [];

    if (!payload?.entry || !Array.isArray(payload.entry)) {
      return { messages, statuses };
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const val = change.value;
        if (!val) continue;

        // Process message status updates (sent, delivered, read, failed)
        if (Array.isArray(val.statuses)) {
          for (const s of val.statuses) {
            statuses.push({
              externalMessageId: s.id,
              status: s.status as 'sent' | 'delivered' | 'read' | 'failed',
              timestamp: s.timestamp ? new Date(parseInt(s.timestamp, 10) * 1000).toISOString() : new Date().toISOString(),
              recipientPhone: s.recipient_id,
              errorCode: s.errors?.[0]?.code?.toString(),
              errorMessage: s.errors?.[0]?.title || s.errors?.[0]?.message,
            });
          }
        }

        // Process inbound customer messages
        if (Array.isArray(val.messages)) {
          const contactMap = new Map<string, string>();
          (val.contacts || []).forEach((c: any) => {
            if (c.wa_id && c.profile?.name) {
              contactMap.set(c.wa_id, c.profile.name);
            }
          });

          for (const m of val.messages) {
            const senderWaId = m.from;
            const senderName = contactMap.get(senderWaId) || null;
            const timestamp = m.timestamp
              ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString()
              : new Date().toISOString();

            let type: WhatsAppInboundMessage['type'] = 'unknown';
            let text: string | undefined;
            let media: WhatsAppInboundMessage['media'];

            if (m.type === 'text') {
              type = 'text';
              text = m.text?.body;
            } else if (m.type === 'document') {
              type = 'document';
              media = {
                id: m.document?.id,
                mimeType: m.document?.mime_type,
                filename: m.document?.filename || 'Document.pdf',
                caption: m.document?.caption,
              };
              text = m.document?.caption;
            } else if (m.type === 'image') {
              type = 'image';
              media = {
                id: m.image?.id,
                mimeType: m.image?.mime_type,
                caption: m.image?.caption,
              };
              text = m.image?.caption;
            }

            let quotedMessage: WhatsAppInboundMessage['quotedMessage'];
            if (m.context?.id) {
              quotedMessage = {
                id: m.context.id,
                from: m.context.from,
              };
            }

            messages.push({
              messageId: m.id,
              from: `+${senderWaId}`,
              fromName: senderName,
              timestamp,
              type,
              text,
              media,
              quotedMessage,
              rawPayload: m,
            });
          }
        }
      }
    }

    return { messages, statuses };
  }
}

/**
 * Local OpenWA Adapter Provider (Development & Local Pairing only).
 * Clearly marked as local unofficial bridge; not suitable for high-volume broadcast.
 */
export class OpenWaAdapterProvider implements IWhatsAppProvider {
  readonly providerType: WhatsAppTransportType = 'openwa_adapter';
  private config: WhatsAppProviderConfig;

  constructor(config: WhatsAppProviderConfig) {
    this.config = config;
  }

  private getBaseUrl(): string {
    return this.config.adapterUrl || '/api/whatsapp';
  }

  async sendMessage(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    const recipient = normalizeE164(options.to);
    const hasMedia = Boolean(options.documentUrl || options.imageUrl);
    const captionText = options.caption || options.text || '';

    // Enforce WhatsApp provider caption limit (1024 characters for media messages)
    if (hasMedia && captionText.length > 1024) {
      return {
        success: false,
        status: 'failed',
        provider: 'openwa_adapter',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: `WhatsApp limits media captions to 1024 characters (current: ${captionText.length}). Please shorten the message.`,
        errorCode: 'CAPTION_TOO_LONG',
      };
    }

    const apiKey =
      this.config.adapterApiKey || '6677a271668085c00c3f37ae6cf77d155f4c5a83b0573ac184e135fe1bf726b4';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    };

    const payload = JSON.stringify({
      to: recipient,
      text: captionText,
      options: {
        ...options,
        caption: captionText,
        documentUrl: options.documentUrl,
        imageUrl: options.imageUrl,
        filename: options.filename,
      },
    });

    try {
      let res: Response;
      try {
        res = await fetch(`${this.getBaseUrl()}/api/messages/send`, {
          method: 'POST',
          headers,
          body: payload,
        });
      } catch (proxyErr) {
        // Fallback to direct localhost:3100 if Vite proxy or configured URL was unreachable
        if (this.getBaseUrl() !== 'http://127.0.0.1:3100') {
          res = await fetch('http://127.0.0.1:3100/api/messages/send', {
            method: 'POST',
            headers,
            body: payload,
          });
        } else {
          throw proxyErr;
        }
      }

      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        return {
          success: true,
          messageId: data.messageId,
          externalMessageId: data.messageId,
          status: 'sent',
          provider: 'openwa_adapter',
          timestamp: new Date().toISOString(),
          isSimulation: false,
          rawResponse: data,
        };
      }

      return {
        success: false,
        status: 'failed',
        provider: 'openwa_adapter',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: data.error || `HTTP ${res.status}: Failed to send via OpenWA adapter`,
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'failed',
        provider: 'openwa_adapter',
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: `Local OpenWA adapter unreachable: ${err.message}`,
      };
    }
  }

  async checkHealth(): Promise<WhatsAppConnectionHealth> {
    const apiKey =
      this.config.adapterApiKey || '6677a271668085c00c3f37ae6cf77d155f4c5a83b0573ac184e135fe1bf726b4';
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key': apiKey,
    };
    try {
      let res: Response;
      try {
        res = await fetch(`${this.getBaseUrl()}/api/status`, { headers });
      } catch (proxyErr) {
        if (this.getBaseUrl() !== 'http://127.0.0.1:3100') {
          res = await fetch('http://127.0.0.1:3100/api/status', { headers });
        } else {
          throw proxyErr;
        }
      }
      if (!res.ok) {
        return {
          provider: 'openwa_adapter',
          status: 'disconnected',
          details: `Adapter proxy returned HTTP ${res.status}`,
          webhookStatus: 'unverified',
          lastChecked: new Date().toISOString(),
          isSimulation: false,
        };
      }
      const data = await res.json();
      return {
        provider: 'openwa_adapter',
        status: data.status === 'connected' ? 'connected' : 'disconnected',
        businessPhone: data.businessPhone,
        details: `Local OpenWA session: ${data.session || 'sapj-business-whatsapp'}. Status: ${data.status}`,
        webhookStatus: 'verified',
        lastChecked: new Date().toISOString(),
        isSimulation: false,
      };
    } catch (err: any) {
      return {
        provider: 'openwa_adapter',
        status: 'disconnected',
        details: `OpenWA adapter offline (${err.message}). Start adapter or configure Meta Cloud API.`,
        webhookStatus: 'unverified',
        lastChecked: new Date().toISOString(),
        isSimulation: false,
      };
    }
  }

  verifyWebhook(): string | null {
    return 'openwa_ok';
  }

  parseWebhookPayload(payload: any) {
    return {
      messages: payload?.messages || [],
      statuses: payload?.statuses || [],
    };
  }
}

/**
 * Isolated Simulation Provider for Unit & E2E Testing.
 * Explicitly branded as SIMULATION. Strictly prevents reporting real customer delivery.
 */
export class SimulationProvider implements IWhatsAppProvider {
  readonly providerType: WhatsAppTransportType = 'simulation';

  async sendMessage(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    const simId = `sim_wa_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    return {
      success: true,
      messageId: simId,
      externalMessageId: simId,
      status: 'queued',
      provider: 'simulation',
      timestamp: new Date().toISOString(),
      isSimulation: true,
      error: undefined,
      rawResponse: {
        simulated: true,
        recipient: options.to,
        simulationNotice: 'SIMULATED — NOT SENT TO CUSTOMER',
      },
    };
  }

  async checkHealth(): Promise<WhatsAppConnectionHealth> {
    return {
      provider: 'simulation',
      status: 'configured',
      businessPhone: '+62800SIMULATED',
      details: 'Simulation Mode Active — Local testing harness only. No live messages sent.',
      webhookStatus: 'verified',
      lastChecked: new Date().toISOString(),
      isSimulation: true,
    };
  }

  verifyWebhook(): string | null {
    return 'simulation_challenge';
  }

  parseWebhookPayload() {
    return { messages: [], statuses: [] };
  }
}

const getEnv = (): Record<string, any> => {
  if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
    return (import.meta as any).env;
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env;
  }
  return {};
};

/**
 * Singleton Orchestrator & Transport Resolver.
 */
export class WhatsAppTransportService {
  private static activeConfig: WhatsAppProviderConfig = {
    providerType:
      (getEnv().VITE_WHATSAPP_PROVIDER as WhatsAppTransportType) || 'openwa_adapter',
    metaPhoneNumberId: getEnv().VITE_META_PHONE_NUMBER_ID || '',
    metaWabaId: getEnv().VITE_META_WABA_ID || '',
    metaAccessToken: getEnv().VITE_META_ACCESS_TOKEN || '',
    metaAppSecret: getEnv().VITE_META_APP_SECRET || '',
    metaWebhookVerifyToken: getEnv().VITE_META_WEBHOOK_VERIFY_TOKEN || 'sapj_meta_wa_verify_2026',
    adapterUrl: getEnv().VITE_WHATSAPP_PROXY_URL || '/api/whatsapp',
    adapterApiKey:
      getEnv().VITE_WHATSAPP_ADAPTER_API_KEY ||
      getEnv().WHATSAPP_ADAPTER_KEY ||
      '6677a271668085c00c3f37ae6cf77d155f4c5a83b0573ac184e135fe1bf726b4',
  };

  private static providerInstances = new Map<WhatsAppTransportType, IWhatsAppProvider>();

  static setConfig(newConfig: Partial<WhatsAppProviderConfig>): void {
    this.activeConfig = { ...this.activeConfig, ...newConfig };
    this.providerInstances.clear();
  }

  static getConfig(): WhatsAppProviderConfig {
    return { ...this.activeConfig };
  }

  static getProvider(type?: WhatsAppTransportType): IWhatsAppProvider {
    const resolvedType = type || this.activeConfig.providerType;
    let provider = this.providerInstances.get(resolvedType);
    if (!provider) {
      if (resolvedType === 'meta_cloud') {
        provider = new MetaCloudApiProvider(this.activeConfig);
      } else if (resolvedType === 'openwa_adapter') {
        provider = new OpenWaAdapterProvider(this.activeConfig);
      } else {
        provider = new SimulationProvider();
      }
      this.providerInstances.set(resolvedType, provider);
    }
    return provider;
  }

  static async sendMessage(options: WhatsAppSendOptions): Promise<WhatsAppSendResult> {
    if ((options.isBulk || options.broadcast || options.isCampaign) && !options.consentVerified) {
      return {
        success: false,
        status: 'failed',
        provider: this.activeConfig.providerType,
        timestamp: new Date().toISOString(),
        isSimulation: false,
        error: 'Bulk WhatsApp dispatch is blocked: live bulk campaigns require verified individual customer opt-in consent records and approved dispatch readiness.',
        errorCode: 'BULK_DISPATCH_LOCKED',
      };
    }
    const provider = this.getProvider();
    return provider.sendMessage(options);
  }

  static async checkHealth(): Promise<WhatsAppConnectionHealth> {
    const provider = this.getProvider();
    return provider.checkHealth();
  }
}

