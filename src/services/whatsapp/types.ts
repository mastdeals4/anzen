// src/services/whatsapp/types.ts
//
// Meta WhatsApp Cloud API and transport-neutral communication types for Anzen ERP.

export type WhatsAppTransportType = 'meta_cloud' | 'openwa_adapter' | 'simulation';

export type WhatsAppDeliveryState = 'queued' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppSendOptions {
  to: string; // E.164 phone number
  text?: string;
  documentUrl?: string;
  filename?: string;
  imageUrl?: string;
  caption?: string;
  templateName?: string;
  languageCode?: string;
  templateComponents?: any[];
  quotedMessageId?: string;
  isCampaign?: boolean;
  isBulk?: boolean;
  broadcast?: boolean;
  consentVerified?: boolean;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  externalMessageId?: string;
  status: WhatsAppDeliveryState;
  provider: WhatsAppTransportType;
  timestamp: string;
  isSimulation: boolean;
  error?: string;
  errorCode?: string | number;
  rawResponse?: any;
}

export interface WhatsAppStatusUpdate {
  externalMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipientPhone?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface WhatsAppInboundMessage {
  messageId: string;
  from: string;
  fromName?: string | null;
  timestamp: string;
  type: 'text' | 'document' | 'image' | 'audio' | 'interactive' | 'unknown';
  text?: string;
  media?: {
    id?: string;
    mimeType?: string;
    filename?: string;
    url?: string;
    caption?: string;
  };
  quotedMessage?: {
    id?: string;
    body?: string;
    from?: string;
  };
  rawPayload: any;
}

export interface WhatsAppProviderConfig {
  providerType: WhatsAppTransportType;
  // Meta Cloud API Credentials
  metaPhoneNumberId?: string;
  metaWabaId?: string;
  metaAccessToken?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  // Local OpenWA Adapter (Dev only)
  adapterUrl?: string;
  adapterApiKey?: string;
}

export interface WhatsAppConnectionHealth {
  provider: WhatsAppTransportType;
  status: 'connected' | 'configured' | 'unconfigured' | 'error' | 'disconnected';
  businessPhone?: string;
  details: string;
  webhookStatus: 'verified' | 'unverified' | 'pending';
  lastChecked: string;
  isSimulation: boolean;
}

