// services/whatsapp-adapter/src/index.ts
//
// Standalone WhatsApp Transport Adapter Service (OpenWA / Chromium Transport).
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
  process.env.ERP_INGRESS_URL || 'https://dkrtsqienlhpouohmfki.supabase.co/functions/v1/enquiry-whatsapp-ingress';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test_whatsapp_secret_key_dev';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '+628119999999';
const SESSION_ID = process.env.SESSION_ID || 'sapj-business-whatsapp';

// Initialize OpenWA provider (default MOCK_MODE=false for real connection)
const provider = new OpenWAProvider({
  sessionId: SESSION_ID,
  erpIngressUrl: ERP_INGRESS_URL,
  webhookSecret: WEBHOOK_SECRET,
  businessPhone: BUSINESS_PHONE,
  mockMode: process.env.MOCK_MODE === 'true',
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
  res.status(200).json({
    status: 'ok',
    service: 'anzen-whatsapp-adapter',
    session: SESSION_ID,
    mode: provider.isMock() ? 'mock' : 'real',
  });
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

// Live QR Display View for Scanning
app.get('/api/session/qr', async (_req: Request, res: Response) => {
  try {
    const status = await provider.getStatus();
    if (status.status === 'connected') {
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>SAPJ WhatsApp Business - Connected</title><meta http-equiv="refresh" content="5"></head>
        <body style="font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;background:#f8fafc;">
          <div style="background:#ecfdf5;border:1px solid #10b981;border-radius:12px;padding:32px;text-align:center;max-width:400px;">
            <h2 style="color:#047857;margin:0 0 8px;">WhatsApp Connected!</h2>
            <p style="color:#065f46;font-size:14px;margin:0;">Active Business Phone: <strong>${status.businessPhone || '+628119999999'}</strong></p>
            <p style="color:#6b7280;font-size:12px;margin:8px 0 0;">Session: <code>${status.session}</code></p>
          </div>
        </body>
        </html>
      `);
    }

    if (!status.qrCode) {
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>SAPJ WhatsApp Business - Generating QR...</title><meta http-equiv="refresh" content="3"></head>
        <body style="font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;background:#f8fafc;">
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center;max-width:400px;">
            <h2 style="color:#334155;margin:0 0 8px;">Generating Authentic QR...</h2>
            <p style="color:#64748b;font-size:14px;">WhatsApp Web Chromium instance is starting. Page will reload automatically.</p>
          </div>
        </body>
        </html>
      `);
    }

    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>SAPJ WhatsApp Business - Scan QR</title>
        <meta http-equiv="refresh" content="10">
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;background:#0f172a;color:#f8fafc;margin:0;padding:16px;">
        <div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:32px;text-align:center;max-width:420px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);">
          <div style="display:inline-block;background:#22c55e;color:#fff;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.05em;">
            OpenWA Real Transport
          </div>
          <h2 style="margin:0 0 8px;font-size:20px;color:#ffffff;">SAPJ WhatsApp Business</h2>
          <p style="color:#94a3b8;font-size:13px;margin:0 0 20px;">
            1. Open WhatsApp Business on your phone<br>
            2. Tap <strong>Linked Devices &rarr; Link a Device</strong><br>
            3. Point your camera at this QR code:
          </p>
          <div style="background:#ffffff;padding:16px;border-radius:12px;display:inline-block;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);">
            <img src="${status.qrCode}" alt="WhatsApp Web QR" style="width:256px;height:256px;display:block;" />
          </div>
          <p style="color:#64748b;font-size:11px;margin:16px 0 0;">
            Session: <code style="color:#38bdf8;">${status.session}</code> &bull; Auto-refreshes every 10s
          </p>
        </div>
      </body>
      </html>
    `);
  } catch (err: any) {
    res.status(500).send(`Error retrieving QR: ${err.message}`);
  }
});

// Session Lifecycle: Connect / Start Session
app.post('/api/session/connect', async (_req: Request, res: Response) => {
  try {
    const status = provider.connect ? await provider.connect() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Disconnect / Log Out Session
app.post('/api/session/disconnect', async (_req: Request, res: Response) => {
  try {
    const status = provider.disconnect ? await provider.disconnect() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Refresh QR Code
app.post('/api/session/refresh-qr', async (_req: Request, res: Response) => {
  try {
    const status = provider.refreshQr ? await provider.refreshQr() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Pair (Explicit/Dev Confirmation)
app.post('/api/session/pair', async (req: Request, res: Response) => {
  try {
    const phone = req.body?.phone;
    const status = provider.pair ? await provider.pair(phone) : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
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
app.post('/api/test/inject-inbound', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';

  if (!isLocalhost && token !== ADAPTER_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid adapter API key' });
  }

  try {
    const result = await provider.forwardInboundToErp(req.body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server & Initialize Provider
async function start() {
  app.listen(PORT, () => {
    console.log(`[Anzen WhatsApp Adapter] Listening on port ${PORT}`);
    console.log(`[Anzen WhatsApp Adapter] Session ID: ${SESSION_ID}`);
    console.log(`[Anzen WhatsApp Adapter] Real QR Viewer: http://localhost:${PORT}/api/session/qr`);
  });

  // Launch provider initialization in background so health and status endpoints respond immediately
  provider.initialize().catch((err) => {
    console.error('[Anzen WhatsApp Adapter] Startup background error:', err);
  });
}

if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    console.error('[Anzen WhatsApp Adapter] Startup error:', err);
  });
}

export { app, provider };
