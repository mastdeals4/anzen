// services/whatsapp-adapter/src/providers/WhatsAppProvider.ts
//
// Provider-neutral abstraction for WhatsApp transport.
// Allows seamless future migration from OpenWA (development/staging)
// to Meta WhatsApp Cloud API (production).

export type WhatsAppConnectionState = 'connected' | 'disconnected' | 'unpaired' | 'error';

export interface WhatsAppSendResult {
  success: boolean;
  messageId: string;
  timestamp: string;
  error?: string;
}

export interface WhatsAppConnectionStatus {
  status: WhatsAppConnectionState;
  session: string;
  businessPhone?: string | null;
  lastSeen?: string;
  qrCode?: string | null; // Data URL or ASCII string if unpaired
  error?: string;
}

export interface WhatsAppDownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
  size: number;
}

export interface WhatsAppInboundMessage {
  messageId: string;
  chatId: string;
  senderPhone: string;
  senderName?: string | null;
  businessPhone?: string | null;
  text?: string | null;
  receivedAt?: string;
  isGroup?: boolean;
  quotedMessage?: {
    id?: string;
    body?: string;
    sender?: string;
  } | null;
  attachments?: Array<{
    filename: string;
    mimeType?: string;
    size?: number;
    base64Data?: string;
  }>;
  rawPayload?: Record<string, unknown> | null;
}

export interface WhatsAppProvider {
  initialize(): Promise<void>;
  sendMessage(to: string, text: string, options?: Record<string, unknown>): Promise<WhatsAppSendResult>;
  getStatus(): Promise<WhatsAppConnectionStatus>;
  downloadMedia?(message: any): Promise<WhatsAppDownloadedMedia | null>;
  disconnect?(): Promise<void>;
}
