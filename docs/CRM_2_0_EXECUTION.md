# SAPJ ERP CRM 2.0 Product Redesign & Sales Automation Rebuild
## Persistent Execution & Audit Checklist

---

## 1. Executive Summary
- **Target Standard:** Modern B2B SaaS CRM experience (Autocloz interaction standard, Excel/Sheets-style high-density customer database, WhatsApp Business conversational thread UX).
- **Core Screen Focus:** 13-inch laptop display optimization (1280x800 and 1440x900 viewport).
- **Infrastructure Status:** Local Mac-hosted OpenWA adapter running under macOS `launchd` on loopback `127.0.0.1:3100`, zero credential exposure, protected server-side Vite proxy.

---

## 2. Core Architectural Principles
1. **Zero Credential Exposure:**
   - Adapter API keys and webhook secrets reside strictly in server-side configurations.
   - Vite proxy at `/api/whatsapp/*` injects authentication headers server-side.
   - Browser network calls, query parameters, and URLs contain zero sensitive keys.
2. **5 Consolidated Primary Destinations:**
   - **INBOX (`/crm/inbox`):** Unified omnichannel 3-column communication center.
   - **INQUIRIES (`/crm/inquiries`):** 357 historical & active inquiries with zero cut-off partitions and instant KPI filter cards.
   - **CAMPAIGNS (`/crm/campaigns`):** Bulk WhatsApp & Bulk Email command center with verified phone audit.
   - **CUSTOMERS (`/crm/customers`):** Excel-style spreadsheet database with frozen company column and expandable multi-contact sub-rows.
   - **DOCUMENT BANK (`/crm/documents`):** Standalone repository for COA, MSDS, TDS, GMP, and specifications.
3. **Strict Phone Validation & Landline Exclusion:**
   - Indonesian landlines (021, 022, 024, 031, etc.) strictly flagged as ineligible for WhatsApp broadcast.
   - Automatic E.164 normalization (`+628...`) for Indonesian cellular numbers (Telkomsel, Indosat, XL, Tri, Smartfren).
   - Anti-spam safeguards with human approval gates, consent checks, and pacing delays (10s, 15s, 20s, 30s).

---

## 3. Persistent Execution Checklist

| ID | Module / Task | Status | Verification Check |
| :--- | :--- | :--- | :--- |
| **SEC-01** | Secure 32-byte credential rotation & loopback binding | **COMPLETED** | Zero `VITE_WHATSAPP_ADAPTER_KEY` in frontend; adapter bound to `127.0.0.1` |
| **SEC-02** | Vite server-side proxy (`/api/whatsapp`) | **COMPLETED** | Browser DevTools inspect shows zero tokens; proxy forwards with auth headers |
| **NAV-01** | Consolidate top navigation to exactly 5 destinations | **COMPLETED** | `INBOX`, `INQUIRIES`, `CAMPAIGNS`, `CUSTOMERS`, `DOCUMENT BANK` verified |
| **AUD-01** | Phone validation engine (`src/utils/phoneValidation.ts`) | **COMPLETED** | Audits 521 contacts: identifies mobile, landline, missing, duplicate |
| **AUD-02** | Landline WhatsApp exclusion | **COMPLETED** | Area codes 021, 022, 024, 031 strictly excluded from WhatsApp broadcast |
| **CMP-01** | WhatsApp Business Composer & dynamic tags | **COMPLETED** | `{{contact_person}}`, `{{company_name}}`, `{{product_name}}`, formatting helpers |
| **CMP-02** | Document Bank attachment integration | **COMPLETED** | Attach COA, Specs, MSDS, or Catalog link to message payload |
| **CMP-03** | Authentic WhatsApp chat mockup preview | **COMPLETED** | `#075e54` header, `#efeae2` wallpaper, `#d9fdd3` outgoing bubble, `✓✓` ticks |
| **CMP-04** | Recipient carousel switcher in live preview | **COMPLETED** | `< [Recipient X of Y] >` with per-contact interpolation preview |
| **CMP-05** | Human Approval Gate & dispatch controls | **COMPLETED** | Test Pilot vs Live Broadcast, Confirmation Modal, Pause, Resume, Cancel, Retry Failed |
| **CST-01** | Spreadsheet customer database (Google Sheets experience) | **COMPLETED** | Compact 32px rows, sticky frozen company column, column sort & filter |
| **CST-02** | Expandable multi-contact cards | **COMPLETED** | Expandable sub-rows parsing multiple emails/phones into structured cards |
| **INQ-01** | Inquiries workspace preservation | **COMPLETED** | All 357 historical inquiries rendered with zero cutoffs, 9 KPI filter cards |
| **INB-01** | 3-column omnichannel inbox | **COMPLETED** | Left conversation list, centre chat/email thread, right Customer 360 & sourcing card |
| **DOC-01** | Standalone Document Bank destination | **COMPLETED** | Dedicated primary tab for COA, MSDS, TDS, Specs with permanent/temporary filters |
| **TST-01** | Regression suite & TypeScript typecheck | **COMPLETED** | `npm run typecheck` (0 errors), `npm run test:targeted -- crm` (20 suites, 93 tests passed) |
| **TST-02** | Playwright E2E verification & screenshots | **RUNNING** | Tests across 5 destinations and protected pairing modal |

