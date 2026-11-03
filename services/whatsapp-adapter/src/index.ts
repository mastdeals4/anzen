// services/whatsapp-adapter/src/index.ts
//
// Standalone WhatsApp Transport Adapter Service (OpenWA / Chromium Transport).
// Keeps OpenWA and WhatsApp-specific libraries completely isolated from Anzen ERP.

import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { OpenWAProvider } from './providers/OpenWAProvider';

// Load local environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADAPTER_API_KEY = process.env.ADAPTER_API_KEY || '';
const ERP_INGRESS_URL =
  process.env.ERP_INGRESS_URL || 'https://dkrtsqienlhpouohmfki.supabase.co/functions/v1/enquiry-whatsapp-ingress';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || undefined;
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
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
  const token = bearerToken || xApiKey;

  if (!token || !ADAPTER_API_KEY || token !== ADAPTER_API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid adapter API key' });
  }
  next();
}

// Middleware: Authenticate administrative & QR session endpoints
function requireAdminAuth(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
  const token = bearerToken || xApiKey;

  if (token && ADAPTER_API_KEY && token === ADAPTER_API_KEY) {
    return next();
  }

  return res.status(401).json({ success: false, error: 'Unauthorized: Admin authentication required' });
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

// Connection Status (redacts qrCode if accessed without valid adapter key)
app.get('/api/status', async (req: Request, res: Response) => {
  try {
    const status = await provider.getStatus();

    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
    const token = bearerToken || xApiKey;

    const isAuthorized = Boolean(token && ADAPTER_API_KEY && token === ADAPTER_API_KEY);

    if (!isAuthorized && status.qrCode) {
      return res.status(200).json({
        ...status,
        qrCode: null,
        protected: true,
      });
    }

    res.status(200).json(status);
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Live QR Display View for Scanning
app.get('/api/session/qr', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const status = await provider.getStatus();
    const isPreview = _req.query.preview === '1' || _req.query.preview === 'true';

    if (status.status === 'connected' && !isPreview) {
      return res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head><title>SAPJ WhatsApp Business - Connected</title><meta http-equiv="refresh" content="5"></head>
        <body style="font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;background:#f8fafc;">
          <div style="background:#ecfdf5;border:1px solid #10b981;border-radius:12px;padding:32px;text-align:center;max-width:400px;">
            <h2 style="color:#047857;margin:0 0 8px;">WhatsApp Connected!</h2>
            <p style="color:#065f46;font-size:14px;margin:0;">Active Business Phone: <strong>${status.businessPhone || 'Unable to detect connected number'}</strong></p>
            <p style="color:#6b7280;font-size:12px;margin:8px 0 0;">Session: <code>${status.session}</code></p>
          </div>
        </body>
        </html>
      `);
    }

    let activeQrCode = status.qrCode;
    if (!activeQrCode && isPreview) {
      try {
        const samplePath = '/Users/Kunal/.gemini/antigravity/brain/ba0a5665-f6f0-4bb7-bcd8-a665594273a2/live-pairing-qr.png';
        if (fs.existsSync(samplePath)) {
          activeQrCode = `data:image/png;base64,${fs.readFileSync(samplePath).toString('base64')}`;
        }
      } catch {}
    }

    if (!activeQrCode) {
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
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>SAPJ WhatsApp Business - Scan QR</title>
        <meta http-equiv="refresh" content="10">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: #0f172a;
            color: #f8fafc;
            margin: 0;
            padding: 16px;
          }
          .card {
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 20px;
            padding: clamp(20px, 3.5vw, 32px);
            text-align: center;
            width: 100%;
            max-width: min(540px, 94vw);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
            display: flex;
            flex-direction: column;
            align-items: center;
          }
          .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: #22c55e;
            color: #ffffff;
            font-size: 11px;
            font-weight: 700;
            padding: 4px 12px;
            border-radius: 999px;
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
          }
          .badge-dot {
            width: 6px;
            height: 6px;
            background: #ffffff;
            border-radius: 50%;
            animation: pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite;
          }
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.4; transform: scale(0.85); }
          }
          h2 {
            margin: 0 0 8px;
            font-size: clamp(20px, 2.5vw, 24px);
            font-weight: 700;
            color: #ffffff;
          }
          .instructions {
            color: #94a3b8;
            font-size: clamp(12px, 1.6vw, 14px);
            line-height: 1.5;
            margin: 0 0 18px;
            max-width: 440px;
          }
          .instructions strong {
            color: #e2e8f0;
          }
          .qr-wrapper {
            background: #ffffff;
            padding: clamp(16px, 2.5vw, 24px);
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.35);
            margin: 0 auto;
            position: relative;
          }
          .qr-image {
            width: clamp(280px, min(420px, 80vw, 46vh), 420px);
            height: clamp(280px, min(420px, 80vw, 46vh), 420px);
            aspect-ratio: 1 / 1;
            object-fit: contain;
            display: block;
            image-rendering: -webkit-optimize-contrast;
            image-rendering: crisp-edges;
            image-rendering: pixelated;
          }
          .actions {
            margin-top: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
            justify-content: center;
          }
          .btn-enlarge {
            background: #334155;
            color: #f1f5f9;
            border: 1px solid #475569;
            border-radius: 8px;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            transition: all 0.15s ease;
          }
          .btn-enlarge:hover {
            background: #475569;
            border-color: #64748b;
          }
          .footer {
            color: #64748b;
            font-size: 12px;
            margin: 16px 0 0;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
          }
          .session-code {
            color: #38bdf8;
            background: #0f172a;
            padding: 2px 8px;
            border-radius: 4px;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 11px;
            border: 1px solid #334155;
          }
          /* Lightbox Modal */
          .modal-overlay {
            display: none;
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.94);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            z-index: 9999;
            align-items: center;
            justify-content: center;
            padding: 16px;
          }
          .modal-overlay.active {
            display: flex;
          }
          .modal-card {
            background: #1e293b;
            border: 1px solid #475569;
            border-radius: 20px;
            padding: clamp(20px, 3vw, 28px);
            text-align: center;
            max-width: min(580px, 96vw);
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.85);
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: center;
          }
          .btn-close {
            position: absolute;
            top: 14px;
            right: 14px;
            background: #334155;
            color: #e2e8f0;
            border: 1px solid #475569;
            border-radius: 50%;
            width: 32px;
            height: 32px;
            font-size: 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.15s ease;
          }
          .btn-close:hover {
            background: #475569;
          }
          .modal-qr-wrapper {
            background: #ffffff;
            padding: clamp(18px, 3vw, 28px);
            border-radius: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
            margin: 12px 0;
          }
          .modal-qr-image {
            width: clamp(280px, min(500px, 86vw, 62vh), 500px);
            height: clamp(280px, min(500px, 86vw, 62vh), 500px);
            aspect-ratio: 1 / 1;
            object-fit: contain;
            display: block;
            image-rendering: -webkit-optimize-contrast;
            image-rendering: crisp-edges;
            image-rendering: pixelated;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">
            <span class="badge-dot"></span>
            OpenWA Real Transport
          </div>
          <h2>SAPJ WhatsApp Business</h2>
          <div class="instructions">
            1. Open <strong>WhatsApp Business</strong> on your phone<br>
            2. Tap <strong>Linked Devices &rarr; Link a Device</strong><br>
            3. Point your camera at this QR code:
          </div>

          <div class="qr-wrapper">
            <img class="qr-image" id="qrImg" src="${activeQrCode}" alt="WhatsApp Web QR Code" />
          </div>

          <div class="actions">
            <button class="btn-enlarge" type="button" onclick="openModal()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              Enlarge QR Code
            </button>
          </div>

          <div class="footer">
            <span>Session:</span>
            <code class="session-code">${status.session}</code>
            <span>&bull;</span>
            <span>Auto-refreshes every 10s</span>
          </div>
        </div>

        <!-- Lightbox Modal for Enlarge View -->
        <div class="modal-overlay" id="qrModal" onclick="handleBackdropClick(event)">
          <div class="modal-card" onclick="event.stopPropagation()">
            <button class="btn-close" type="button" onclick="closeModal()" title="Close">&times;</button>
            <h3 style="margin:0 0 4px;font-size:18px;color:#ffffff;font-weight:700;">Enlarged QR Code</h3>
            <p style="margin:0;color:#94a3b8;font-size:13px;">Point phone camera directly at the code below</p>
            <div class="modal-qr-wrapper">
              <img class="modal-qr-image" src="${activeQrCode}" alt="WhatsApp Web QR Large" />
            </div>
            <div style="color:#64748b;font-size:12px;">
              Press <kbd style="background:#0f172a;color:#cbd5e1;padding:2px 6px;border-radius:4px;border:1px solid #334155;font-size:11px;">Esc</kbd> or click anywhere outside to close
            </div>
          </div>
        </div>

        <script>
          const modal = document.getElementById('qrModal');

          function openModal() {
            modal.classList.add('active');
            sessionStorage.setItem('sapj_qr_enlarged', '1');
          }

          function closeModal() {
            modal.classList.remove('active');
            sessionStorage.removeItem('sapj_qr_enlarged');
          }

          function handleBackdropClick(e) {
            if (e.target === modal) {
              closeModal();
            }
          }

          document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
              closeModal();
            }
          });

          // Restore modal state across 10s meta refresh
          if (sessionStorage.getItem('sapj_qr_enlarged') === '1') {
            modal.classList.add('active');
          }
        </script>
      </body>
      </html>
    `);
  } catch (err: any) {
    res.status(500).send(`Error retrieving QR: ${err.message}`);
  }
});

// Session Lifecycle: Connect / Start Session
app.post('/api/session/connect', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const status = provider.connect ? await provider.connect() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Disconnect / Log Out Session
app.post('/api/session/disconnect', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const status = provider.disconnect ? await provider.disconnect() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Refresh QR Code
app.post('/api/session/refresh-qr', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const status = provider.refreshQr ? await provider.refreshQr() : await provider.getStatus();
    res.status(200).json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Session Lifecycle: Pair (Explicit/Dev Confirmation)
app.post('/api/session/pair', requireAdminAuth, async (req: Request, res: Response) => {
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
app.post('/api/test/inject-inbound', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await provider.forwardInboundToErp(req.body);
    res.status(result.success ? 200 : 502).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server & Initialize Provider
async function start() {
  app.listen(PORT, HOST, () => {
    console.log(`[Anzen WhatsApp Adapter] Listening on ${HOST}:${PORT}`);
    console.log(`[Anzen WhatsApp Adapter] Session ID: ${SESSION_ID}`);
    console.log(`[Anzen WhatsApp Adapter] Protected QR Endpoint: http://${HOST}:${PORT}/api/session/qr`);
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
