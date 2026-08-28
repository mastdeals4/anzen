# Release Notes — v1.0-crm-sourcing-stable

**Date:** 2026-06-25
**Status:** Feature-complete. Bug fixes only from this point.

---

## CRM / Sourcing Module

### Send To India Workflow

- Sales selects one or more CRM inquiries and clicks **Send To India**.
- ACE ERP Reference Number is required on every selected inquiry before sending.
- Multi-product inquiries (`has_items = true`) are automatically expanded into individual product rows — each child item's product name, specification, quantity, make, delivery date, and remarks are used in the email table.
- One consolidated email is generated per send. No per-row emails.
- Recipients are loaded from the `sourcing_email_recipients` database table (`india` route). No static recipient fallback is used.
- Sender is always `kunal@sapharmajaya.co.id` (resolved server-side via `requiredSenderEmail`).
- Subject: `India Pricing Request - ACE Ref <deduped refs>` — ACE refs are deduplicated so a multi-item inquiry does not repeat the same ref.
- HTML body built by `buildIndiaTable()` in `GmailLikeComposer.tsx`. Columns: ACE ERP Ref, Customer Name, Product Name, Specification, Make, Quantity, Required Delivery Date, Documents Available, Remarks.
- After first send, CRM composer shows a read-only info panel (last sent date, sent by, reminder count) redirecting follow-up reminders to Sourcing Outbox.

### Sourcing Outbox Workflow

- Operational queue showing all inquiries with `source_status` in `sent`, `waiting_reply`, `partial_received`.
- Tabs: India / China / Local, with badge counts per route.
- Completed inquiries (`price_ready = true`, or `received + kunal_price_status != pending`, or `unavailable`, or `won`/`lost`) are hidden from the active queue.
- Reminder due threshold: 3 days since last send.
- AI mail review: scans inbox for supplier replies and surfaces match confidence scores.
- Recipients per route loaded from `sourcing_email_recipients` DB table via `loadAllRouteRecipients()`.

### Consolidated Reminder Emails

- Pure-reminder batches (all rows already sent at least once) use `buildSourcingReminderHtml()` from `src/utils/sourcingEmailBuilder.ts`.
- Reminder table adds two extra columns: **Days Pending** and **Last Sent Date**.
- Mixed batches (any `not_sent` rows) use `buildEmailBody()` (plain-text format) with subject `Sourcing Request - N item(s)`.
- Pure-reminder subject: `Reminder – Pending Pricing Requests`.
- `last_reminder_sent_at` and `reminder_count` are updated on each reminder send.

### Reply Processing

- `KunalIndiaPriceReview` scans the configured Gmail mailbox for supplier price replies.
- Replies are matched to open CRM inquiries by ACE ERP ref, product name, and subject heuristics.
- Extracted pricing options (purchase price, make, lead time) are saved to `crm_inquiry_pricing_options`.
- All extractions are INSERT-only into `pricing_ledger` (audit trail, never UPSERT).
- `source_status` progresses: `not_sent` → `sent` → `waiting_reply` → `partial_received` → `received`.

### Pricing Workflow Integration

- Once source prices are received, `kunal_price_status` transitions from `pending` to `done` after prices are entered in Pricing Worksheet.
- `price_ready = true` signals that the customer quote can be sent.
- Pricing Worksheet (formerly "Kunal Pricing") is the entry point for final purchase/selling price input.
- Quote status: `not_sent` → `sent` → `won` / `lost`.

### UI Terminology Cleanup

All employee-specific names removed from the UI:

| Old label | New label |
|-----------|-----------|
| Anvi Sourcing (sidebar) | Sourcing Outbox |
| Kunal Pricing (sidebar) | Pricing Worksheet |
| Kunal Pricing (page heading) | Pricing Worksheet |
| Sales / Anvi (dashboard section) | Sourcing |
| Mark for Kunal Review (button) | Send to Pricing Queue |

Internal variable names, database columns, and API routes are unchanged.

### Multi-product Email Fixes

- **Subject deduplication**: child items sharing a parent's ACE ref no longer produce repeated refs in the subject line.
- **Single-child expansion**: `has_items = true` parents with exactly one child item now correctly use the child's product fields (product name, specification, quantity, etc.) in the email table. Previously the unmodified parent row was used.
- **Recipient loading**: Admin, Sales, and legacy sourcing screens use `loadAllRouteRecipients()` so the DB-configured recipient list is used at send time.

### Production Fixes Completed

- `isCompleted` logic: `price_ready = true` now correctly marks a row as done regardless of other status fields; `source_status = received` no longer hides a row until `kunal_price_status != pending`.
- `bodyOverride` null check: changed `!== undefined` to `!= null` so an unset override (initialised to `null`) does not silently send a null body.
- Reminder subject consistency: `improveWithAi` and `sendGroup` now use the same subject string.
- Unused `contact` variable removed from `sendGroup`.

---

## Architecture Constraints (do not change without a production incident)

- **CRM** owns the initial `Send To India` send only.
- **Sourcing Outbox** owns all subsequent reminders.
- **Pricing Worksheet** owns purchase/selling price entry.
- `pricing_ledger` is INSERT-only (audit log). Never UPSERT.
- `crm_inquiries` is the live source of truth for all status fields.
- `buildIndiaTable` (initial send) and `buildSourcingReminderHtml` (reminders) are separate builders by design — they have different column sets.
