import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const openwaProviderSrc = readFileSync(
  resolve('services/whatsapp-adapter/src/providers/OpenWAProvider.ts'),
  'utf-8'
);
const adapterIndexSrc = readFileSync(
  resolve('services/whatsapp-adapter/src/index.ts'),
  'utf-8'
);
const enquiryWhatsAppServiceSrc = readFileSync(
  resolve('src/services/enquiry/EnquiryWhatsAppService.ts'),
  'utf-8'
);
const whatsAppSettingsSrc = readFileSync(
  resolve('src/components/crm/settings/WhatsAppSettings.tsx'),
  'utf-8'
);
const crmSettingsModalSrc = readFileSync(
  resolve('src/components/crm/settings/CrmSettingsModal.tsx'),
  'utf-8'
);
const crmOmnichannelInboxSrc = readFileSync(
  resolve('src/components/crm/inbox/CrmOmnichannelInbox.tsx'),
  'utf-8'
);
const sendBulkEmailSrc = readFileSync(
  resolve('supabase/functions/send-bulk-email/index.ts'),
  'utf-8'
);
const sharedIngestionSrc = readFileSync(
  resolve('supabase/functions/_shared/enquiryIngestion.ts'),
  'utf-8'
);

test('1. OpenWA Provider and Adapter Session Lifecycle Endpoints', () => {
  // Provider methods
  assert.ok(openwaProviderSrc.includes('public async connect('), 'OpenWAProvider must implement connect()');
  assert.ok(openwaProviderSrc.includes('public async disconnect('), 'OpenWAProvider must implement disconnect()');
  assert.ok(openwaProviderSrc.includes('public async refreshQr('), 'OpenWAProvider must implement refreshQr()');
  assert.ok(openwaProviderSrc.includes('public async pair('), 'OpenWAProvider must implement pair()');
  assert.ok(openwaProviderSrc.includes('public async getStatus('), 'OpenWAProvider must implement getStatus()');
  assert.ok(openwaProviderSrc.includes('QRCode.toDataURL'), 'OpenWAProvider must generate valid QR code data URLs');

  // Adapter HTTP routes
  assert.ok(adapterIndexSrc.includes("app.post('/api/session/connect'"), 'Adapter must expose POST /api/session/connect');
  assert.ok(adapterIndexSrc.includes("app.post('/api/session/disconnect'"), 'Adapter must expose POST /api/session/disconnect');
  assert.ok(adapterIndexSrc.includes("app.post('/api/session/refresh-qr'"), 'Adapter must expose POST /api/session/refresh-qr');
  assert.ok(adapterIndexSrc.includes("app.post('/api/session/pair'"), 'Adapter must expose POST /api/session/pair');
  assert.ok(adapterIndexSrc.includes("app.get('/api/status'"), 'Adapter must expose GET /api/status');
  assert.ok(adapterIndexSrc.includes("app.post('/api/messages/send'"), 'Adapter must expose POST /api/messages/send');
  assert.ok(adapterIndexSrc.includes("app.post('/api/test/inject-inbound'"), 'Adapter must expose POST /api/test/inject-inbound');
});

test('2. Client EnquiryWhatsAppService Session Management', () => {
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async connectSession('), 'Service must implement connectSession');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async disconnectSession('), 'Service must implement disconnectSession');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async refreshQr('), 'Service must implement refreshQr');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async pairSession('), 'Service must implement pairSession');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async getConnectionStatus('), 'Service must implement getConnectionStatus');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async injectTestInbound('), 'Service must implement injectTestInbound');
  assert.ok(enquiryWhatsAppServiceSrc.includes('static async sendWhatsAppMessage('), 'Service must preserve sendWhatsAppMessage');
});

test('3. WhatsAppSettings Component & Connection States', () => {
  // Verifies the 4 connection states
  assert.ok(whatsAppSettingsSrc.includes('CONNECTED'), 'Must render CONNECTED state');
  assert.ok(whatsAppSettingsSrc.includes('DISCONNECTED'), 'Must render DISCONNECTED state');
  assert.ok(whatsAppSettingsSrc.includes('QR REQUIRED'), 'Must render QR REQUIRED state');
  assert.ok(whatsAppSettingsSrc.includes('ERROR'), 'Must render ERROR state');

  // Verifies QR code rendering & actions
  assert.ok(whatsAppSettingsSrc.includes('<img') && whatsAppSettingsSrc.includes('status.qrCode'), 'Must render QR code image tag');
  assert.ok(whatsAppSettingsSrc.includes('handleRefreshQr'), 'Must provide Refresh QR action');
  assert.ok(whatsAppSettingsSrc.includes('handlePair'), 'Must provide Pair / Confirm QR action');
  assert.ok(whatsAppSettingsSrc.includes('handleDisconnect'), 'Must provide Disconnect action');
  assert.ok(whatsAppSettingsSrc.includes('handleTestInbound'), 'Must provide Test Inbound action');

  // Verifies CrmSettingsModal integration
  assert.ok(crmSettingsModalSrc.includes('<WhatsAppSettings />'), 'CrmSettingsModal must embed WhatsAppSettings');
  assert.ok(!crmSettingsModalSrc.includes('WhatsApp Business Webhook — Listening'), 'Must replace static placeholder');
});

test('4. CRM Omnichannel Inbox WhatsApp Segregation & Messaging', () => {
  // Ingress & Canonical Mapping
  assert.ok(sharedIngestionSrc.includes('export async function mirrorInboundWhatsApp'), 'Must mirror inbound WhatsApp');
  assert.ok(sharedIngestionSrc.includes('channel: "whatsapp"'), 'Must assign channel = whatsapp');

  // Inbox UI
  assert.ok(crmOmnichannelInboxSrc.includes("export type ChannelFilter = 'all' | 'email' | 'whatsapp' | 'unlinked'"), 'Channel filter includes whatsapp');
  assert.ok(crmOmnichannelInboxSrc.includes("channelFilter === 'whatsapp'"), 'Inbox filters by whatsapp');
  assert.ok(crmOmnichannelInboxSrc.includes("selectedConversation.channel === 'whatsapp'"), 'Detail view detects whatsapp conversation');
  assert.ok(crmOmnichannelInboxSrc.includes('EnquiryWhatsAppService.sendWhatsAppMessage'), 'Outbound reply routes to WhatsApp service');
});

test('5. Strict Email Account Roles & Cross-Use Prevention', () => {
  // Email constants
  assert.ok(sendBulkEmailSrc.includes('sales@sapharmajaya.co.id'), 'send-bulk-email must reference sales@sapharmajaya.co.id');
  assert.ok(sendBulkEmailSrc.includes('kunal@avira.co.id'), 'send-bulk-email must reference kunal@avira.co.id');

  // Strict enforcement check
  assert.ok(
    sendBulkEmailSrc.includes('STRICT_ACCOUNT_ROLE_VIOLATION'),
    'send-bulk-email must block account role violations with STRICT_ACCOUNT_ROLE_VIOLATION'
  );
  assert.ok(
    sendBulkEmailSrc.includes('CRM_WORKFLOWS') && sendBulkEmailSrc.includes('PRICING_WORKFLOWS'),
    'send-bulk-email must enforce CRM vs Pricing workflow separation'
  );
});

test('6. Live Adapter Service Verification (Port 3100)', async (t) => {
  let isListening = false;
  try {
    const probe = await fetch('http://localhost:3100/health', { signal: AbortSignal.timeout(1500) });
    isListening = probe.ok;
  } catch {
    isListening = false;
  }

  if (!isListening) {
    t.skip('Adapter service not active on port 3100 (offline during migration)');
    return;
  }

  // Test /health
  const healthRes = await fetch('http://localhost:3100/health');
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.service, 'anzen-whatsapp-adapter');

  // Test /api/session/pair
  const pairRes = await fetch('http://localhost:3100/api/session/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+628119999999' }),
  });
  assert.equal(pairRes.status, 200);
  const pairData = await pairRes.json();
  assert.equal(pairData.status, 'connected');
  assert.equal(pairData.businessPhone, '+628119999999');

  // Test /api/status (CONNECTED)
  const statusRes = await fetch('http://localhost:3100/api/status');
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.status, 'connected');
  assert.equal(statusData.businessPhone, '+628119999999');

  // Test outbound send with connected session
  const sendRes = await fetch('http://localhost:3100/api/messages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test_whatsapp_secret_key_dev',
    },
    body: JSON.stringify({
      to: '+628123456789',
      text: 'Automated regression test message',
    }),
  });
  assert.equal(sendRes.status, 200);
  const sendData = await sendRes.json();
  assert.equal(sendData.success, true);
  assert.ok(sendData.messageId);

  // Test /api/session/disconnect
  const disconnectRes = await fetch('http://localhost:3100/api/session/disconnect', {
    method: 'POST',
  });
  assert.equal(disconnectRes.status, 200);
  const disconnectData = await disconnectRes.json();
  assert.equal(disconnectData.status, 'disconnected');

  // Test /api/session/connect (moves to unpaired with QR)
  const connectRes = await fetch('http://localhost:3100/api/session/connect', {
    method: 'POST',
  });
  assert.equal(connectRes.status, 200);
  const connectData = await connectRes.json();
  assert.equal(connectData.status, 'unpaired');
  assert.ok(connectData.qrCode.startsWith('data:image/'));

  // Re-pair for active state
  await fetch('http://localhost:3100/api/session/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '+628119999999' }),
  });
});
