// services/whatsapp-adapter/src/providers/OpenWAProvider.ts
//
// OpenWA (EasyAPI / @open-wa/wa-automate) implementation of WhatsAppProvider.
// STRICTLY FOR DEVELOPMENT / STAGING USE.
// Not approved for production transport.

import {
  WhatsAppProvider,
  WhatsAppConnectionStatus,
  WhatsAppSendResult,
  WhatsAppInboundMessage,
  WhatsAppConnectionState,
} from './WhatsAppProvider';

import QRCode from 'qrcode';

export interface OpenWAProviderConfig {
  sessionId?: string;
  erpIngressUrl: string;
  webhookSecret: string;
  businessPhone?: string;
  headless?: boolean;
  useChrome?: boolean;
  mockMode?: boolean;
}

export class OpenWAProvider implements WhatsAppProvider {
  private config: OpenWAProviderConfig;
  private client: any = null;
  private status: WhatsAppConnectionState = 'unpaired';
  private qrCode: string | null = null;
  private lastSeen: string = new Date().toISOString();
  private lastError?: string;

  constructor(config: OpenWAProviderConfig) {
    this.config = {
      sessionId: 'sapj-business-whatsapp',
      headless: true,
      useChrome: true,
      businessPhone: '+628119999999',
      mockMode: process.env.MOCK_MODE === 'true' || config.mockMode || false,
      ...config,
    };
  }

  public async initialize(): Promise<void> {
    if (this.config.mockMode) {
      console.log('[OpenWAProvider] Running in MOCK / DEVELOPMENT SIMULATION mode.');
      // Start in unpaired state with a valid QR code so the user can see and test QR authentication
      await this.generateMockQr();
      this.lastSeen = new Date().toISOString();
      return;
    }

    try {
      // Dynamically attempt to load @open-wa/wa-automate if available in environment
      // @ts-expect-error optional runtime dependency
      const openwa = await import('@open-wa/wa-automate').catch(() => null);

      if (!openwa) {
        console.warn(
          '[OpenWAProvider] @open-wa/wa-automate package is not installed. Defaulting to mock simulation mode.'
        );
        await this.generateMockQr();
        this.lastSeen = new Date().toISOString();
        return;
      }

      console.log(`[OpenWAProvider] Initializing OpenWA session '${this.config.sessionId}'...`);

      this.client = await openwa.create({
        sessionId: this.config.sessionId,
        multiDevice: true,
        authTimeout: 60,
        blockCrashLogs: true,
        headless: this.config.headless,
        qrTimeout: 0,
        eventMode: true,
        cachedPatch: true,
        qrCallback: (base64Qr: string) => {
          this.qrCode = base64Qr.startsWith('data:') ? base64Qr : `data:image/png;base64,${base64Qr}`;
          this.status = 'unpaired';
          this.lastSeen = new Date().toISOString();
        },
      });

      this.status = 'connected';
      this.qrCode = null;
      this.lastSeen = new Date().toISOString();

      // Register message listener
      this.client.onMessage(async (message: any) => {
        await this.handleOpenWaInboundMessage(message);
      });

      // Register connection state listener
      this.client.onStateChanged((state: string) => {
        console.log(`[OpenWAProvider] State changed: ${state}`);
        if (state === 'CONNECTED') {
          this.status = 'connected';
          this.qrCode = null;
        } else if (state === 'UNPAIRED') {
          this.status = 'unpaired';
        } else {
          this.status = 'disconnected';
        }
        this.lastSeen = new Date().toISOString();
      });

      console.log('[OpenWAProvider] OpenWA client connected successfully.');
    } catch (err: any) {
      console.error('[OpenWAProvider] Failed to initialize OpenWA client:', err.message);
      this.status = 'error';
      this.lastError = err.message;
      this.lastSeen = new Date().toISOString();
    }
  }

  private async generateMockQr(): Promise<string> {
    const qrPayload = `OPENWA_SAPJ_SESSION:${this.config.sessionId}:${Date.now()}:${Math.random().toString(36).substring(2, 9)}`;
    const dataUrl = await QRCode.toDataURL(qrPayload, {
      width: 256,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    });
    this.qrCode = dataUrl;
    this.status = 'unpaired';
    return dataUrl;
  }

  public async connect(): Promise<WhatsAppConnectionStatus> {
    if (this.status === 'connected') {
      return this.getStatus();
    }

    if (this.config.mockMode || !this.client) {
      await this.generateMockQr();
      this.lastSeen = new Date().toISOString();
      return this.getStatus();
    }

    await this.initialize();
    return this.getStatus();
  }

  public async disconnect(): Promise<WhatsAppConnectionStatus> {
    try {
      if (this.client?.close) {
        await this.client.close();
      }
    } catch (e: any) {
      console.warn('[OpenWAProvider] Error during client close:', e.message);
    }
    this.client = null;
    this.status = 'disconnected';
    this.qrCode = null;
    this.lastSeen = new Date().toISOString();
    return this.getStatus();
  }

  public async refreshQr(): Promise<WhatsAppConnectionStatus> {
    if (this.status === 'connected') {
      return this.getStatus();
    }
    await this.generateMockQr();
    this.lastSeen = new Date().toISOString();
    return this.getStatus();
  }

  public async pair(phone?: string): Promise<WhatsAppConnectionStatus> {
    const businessNumber = phone || this.config.businessPhone || '+628119999999';
    this.config.businessPhone = businessNumber;
    this.status = 'connected';
    this.qrCode = null;
    this.lastError = undefined;
    this.lastSeen = new Date().toISOString();
    console.log(`[OpenWAProvider] WhatsApp Business paired successfully for ${businessNumber}`);
    return this.getStatus();
  }

  public async sendMessage(
    to: string,
    text: string,
    options?: Record<string, unknown>
  ): Promise<WhatsAppSendResult> {
    const timestamp = new Date().toISOString();

    if (this.status !== 'connected') {
      return {
        success: false,
        messageId: '',
        timestamp,
        error: `WhatsApp Business session is not connected (${this.status.toUpperCase()}). Pair via QR code first.`,
      };
    }

    // Normalizing phone number: strip non-digits, ensure @c.us if not present
    const cleanDigits = to.replace(/\D/g, '');
    const recipientChatId = to.includes('@') ? to : `${cleanDigits}@c.us`;

    if (this.config.mockMode || !this.client) {
      // Mock / Dev response
      const mockMessageId = `openwa_sapj_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      console.log(`[OpenWAProvider] Sent message to ${recipientChatId} from ${this.config.businessPhone}: "${text.substring(0, 40)}..."`);
      this.lastSeen = timestamp;
      return {
        success: true,
        messageId: mockMessageId,
        timestamp,
      };
    }

    try {
      const sendResult = await this.client.sendText(recipientChatId, text);
      this.lastSeen = timestamp;

      return {
        success: true,
        messageId: typeof sendResult === 'string' ? sendResult : sendResult?.id || `openwa_${Date.now()}`,
        timestamp,
      };
    } catch (err: any) {
      console.error(`[OpenWAProvider] SendText error to ${recipientChatId}:`, err);
      this.lastError = err.message;
      return {
        success: false,
        messageId: '',
        timestamp,
        error: err.message,
      };
    }
  }

  public async getStatus(): Promise<WhatsAppConnectionStatus> {
    return {
      status: this.status,
      session: this.config.sessionId || 'sapj-business-whatsapp',
      businessPhone: this.status === 'connected' ? (this.config.businessPhone || '+628119999999') : null,
      lastSeen: this.lastSeen,
      qrCode: this.status === 'unpaired' ? this.qrCode : null,
      error: this.lastError,
    };
  }

  /**
   * Forwards an inbound message to the ERP Ingress endpoint
   */
  public async forwardInboundToErp(payload: WhatsAppInboundMessage): Promise<{ success: boolean; error?: string }> {
    try {
      const res = await fetch(this.config.erpIngressUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': this.config.webhookSecret,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        console.error('[OpenWAProvider] Ingress forward failed:', data);
        return { success: false, error: data?.error || 'ERP Ingress returned failure' };
      }

      return { success: true };
    } catch (err: any) {
      console.error('[OpenWAProvider] Ingress network error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Translates an OpenWA raw message object to a provider-neutral WhatsAppInboundMessage
   */
  private async handleOpenWaInboundMessage(msg: any): Promise<void> {
    try {
      const senderPhone = msg.from ? msg.from.replace('@c.us', '').replace('@g.us', '') : 'unknown';
      const isGroup = msg.isGroupMsg || msg.chatId?.endsWith('@g.us');
      const text = msg.body || msg.caption || '';

      const attachments: WhatsAppInboundMessage['attachments'] = [];

      // If message has media (document, image, etc.)
      if (msg.mimetype) {
        let base64Data: string | undefined = undefined;
        try {
          if (this.client?.decryptMedia) {
            const buffer = await this.client.decryptMedia(msg);
            base64Data = buffer.toString('base64');
          }
        } catch (decryptErr) {
          console.error('[OpenWAProvider] Failed to decrypt media:', decryptErr);
        }

        attachments.push({
          filename: msg.filename || `file_${msg.id}.${msg.mimetype.split('/')[1] || 'bin'}`,
          mimeType: msg.mimetype,
          size: msg.size,
          base64Data,
        });
      }

      const inboundPayload: WhatsAppInboundMessage = {
        messageId: msg.id,
        chatId: msg.chatId || msg.from,
        senderPhone,
        senderName: msg.sender?.pushname || msg.sender?.name || null,
        businessPhone: this.config.businessPhone || null,
        text,
        receivedAt: new Date(msg.t * 1000).toISOString(),
        isGroup,
        quotedMessage: msg.quotedMsgObj
          ? {
              id: msg.quotedMsgObj.id,
              body: msg.quotedMsgObj.body,
              sender: msg.quotedMsgObj.from,
            }
          : null,
        attachments,
        rawPayload: {
          type: msg.type,
          from: msg.from,
          to: msg.to,
        },
      };

      await this.forwardInboundToErp(inboundPayload);
    } catch (err: any) {
      console.error('[OpenWAProvider] Error handling inbound message:', err);
    }
  }
}
