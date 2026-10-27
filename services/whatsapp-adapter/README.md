# Anzen WhatsApp Transport Adapter
### DEVELOPMENT / STAGING ENVIRONMENT ONLY

> **IMPORTANT WARNING:**
> OpenWA is strictly a **development and staging transport adapter**.
> It is **NOT approved for production use**.
> The production target is the official **Meta WhatsApp Cloud API**.
> All OpenWA-specific logic, libraries, and session files are isolated inside this service.
> The core Anzen ERP does NOT depend on OpenWA.

---

## Architectural Isolation Boundary

```
[ Customer WhatsApp ]
        ↕
[ OpenWA Gateway / Chromium ]
        ↕
[ OpenWAProvider / Adapter Service (Port 3100) ]
        ↕ (HTTP with X-Webhook-Secret / Bearer Token)
[ Supabase Edge Functions: enquiry-whatsapp-ingress & outbound ]
        ↕
[ Canonical Communication Tables: enquiry_conversations & enquiry_conversation_messages ]
        ↕
[ Enquiry Brain 7.6A–7.6E (Non-Authoritative Interpretation) ]
        ↕
[ Human Review Gate ]
        ↕
[ Authoritative Anzen ERP State ]
```

## Security Guarantees
1. **No External Client Impersonation**: Inbound webhooks must supply `X-Webhook-Secret`. Unauthenticated requests are rejected (401).
2. **Server-Derived Destination**: Outbound sends derive the recipient phone strictly from the canonical conversation record. Clients cannot supply arbitrary phone numbers to prevent relay abuse.
3. **Strict Human Gate**: Outbound requests require an authenticated ERP user with role `admin`, `manager`, or `sales` (verified via `auth.uid()`).
4. **Session Isolation**: Session credentials and pairing files are ignored in `.gitignore` and `.dockerignore`.

## Environment Variables
- `PORT`: Service port (default: `3100`)
- `ADAPTER_API_KEY`: Secret key required by `POST /api/messages/send`
- `ERP_INGRESS_URL`: URL of the ERP ingress Edge Function (e.g., `http://localhost:54321/functions/v1/enquiry-whatsapp-ingress`)
- `WEBHOOK_SECRET`: Secret sent in `X-Webhook-Secret` header to ERP ingress
- `BUSINESS_PHONE`: Dedicated test/business phone number (e.g., `+628119999999`)
- `MOCK_MODE`: `true` for headless simulation during tests; `false` to launch OpenWA browser
- `SESSION_ID`: OpenWA session identifier (`sapj-business-whatsapp`)
- `SESSION_DATA_PATH`: Storage path for persistent session tokens (default: `/app/_sessions`)
- `CLOUDFLARE_TUNNEL_TOKEN`: Cloudflare Zero Trust Named Tunnel token

## Endpoints
- `GET /health`: Health check
- `GET /api/status`: Operational connection status (`connected`, `disconnected`, `unpaired`, `error`)
- `GET /api/session/qr`: Fullscreen auto-refreshing QR viewer for mobile phone scanning
- `POST /api/session/connect`: Start session and generate pairing QR
- `POST /api/session/disconnect`: Disconnect session
- `POST /api/session/refresh-qr`: Force browser reload for fresh QR
- `POST /api/messages/send`: Send outbound message (Requires Bearer token)
- `POST /api/test/inject-inbound`: Inbound test message injection for automated test suites

---

## Persistent VPS Deployment Guide

### Recommended Server Specifications
- **OS**: Ubuntu 22.04 LTS or Debian 12
- **CPU**: 2 vCPU minimum (Chromium headless rendering)
- **RAM**: 2 GB RAM minimum (4 GB recommended with swap)
- **Storage**: 20 GB SSD (Chromium caches and profile data)
- **Networking**: Inbound ports closed (port 3100 binds only to 127.0.0.1); outbound HTTPS allowed.

### 1-Click Deployment on Any VPS
1. Transfer `services/whatsapp-adapter` to `/opt/sapj-whatsapp-adapter` on the server.
2. Transfer `whatsapp-session-sapj-business-whatsapp.tar.gz` into the folder.
3. Extract session: `mkdir -p _sessions && tar -xzf whatsapp-session-sapj-business-whatsapp.tar.gz -C ./_sessions`
4. Configure `.env` with `CLOUDFLARE_TUNNEL_TOKEN` and production secrets.
5. Run `./deploy.sh` to launch Docker containers and verify health.
