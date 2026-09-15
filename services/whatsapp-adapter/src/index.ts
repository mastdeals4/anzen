// services/whatsapp-adapter/src/index.ts
//
// Standalone WhatsApp Transport Adapter Service (OpenWA Dev/Staging).
// Keeps OpenWA and WhatsApp-specific libraries completely isolated from Anzen ERP.

import express, { Request, Response } from 'express';
import cors from 'cors';
import { OpenWAProvider } from './providers/OpenWAProvider';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '3100', 10);
const ADAPTER_API_KEY = process.env.ADAPTER_API_KEY || 'test_whatsapp_secret_key_dev';
const ERP_INGRESS_URL =
  process.env.ERP_INGRESS_URL || 'http://localhost:54321/functions/v1/enquiry-whatsapp-ingress';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test_whatsapp_secret_key_dev';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '+628119999999';

// Initialize OpenWA provider
const provider = new OpenWAProvider({
  sessionId: process.env.SESSION_ID || 'anzen-staging-session',
  erpIngressUrl: ERP_INGRESS_URL,
  webhookSecret: WEBHOOK_SECRET,
  businessPhone: BUSINESS_PHONE,
  mockMode: process.env.MOCK_MODE !== 'false',
});

// Middleware: Authenticate outbound requests
function requireApiKey(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== ADAPTER_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid adapter API key' });
  }
  next();
}

// Health Check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'anzen-whatsapp-adapter' });
});

// Connection Status
app.get('/api/status', async (_req: Request, res: Response) => {
  try {
    const status = await provider.getStatus();
    res.status(200).json(status);
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Outbound Send
app.post('/api/messages/send', requireApiKey, async (req: Request, res: Response) => {
  const { to, text, options } = req.body;

  if (!to || !text) {
    return res.status(400).json({ success: false, error: 'Missing required fields: to, text' });
  }

  try {
    const result = await provider.sendMessage(to, text, options);
    if (!result.success) {
      return res.status(502).json(result);
    }
    res.status(200).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test / Staging Inbound Injection Endpoint
// Allows automated tests to simulate inbound customer messages & media
app.post('/api/test/inject-inbound', requireApiKey, async (req: Request, res: Response) => {
  try {
    const result = await provider.forwardInboundToErp(req.body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server & Initialize Provider
async function start() {
  await provider.initialize();
  app.listen(PORT, () => {
    console.log(`[Anzen WhatsApp Adapter] Listening on port ${PORT}`);
  });
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    console.error('[Anzen WhatsApp Adapter] Startup error:', err);
  });
}

export { app, provider };
