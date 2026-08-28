# Security Hardening Report - 2026-06-02

Scope constraint honored: no CRM workflow, stock allocation/reservation logic, or sales order business logic was changed.

## Edge Function Security Audit

| Function | Current auth status before sprint | Change made |
|---|---|---|
| `admin-delete-user` | Authenticated admin only | No code change required. Already returns 401/403. |
| `admin-update-password` | Authenticated admin only | No code change required. Already returns 401/403. |
| `ai-email-assistant` | Authenticated user required | No code change required. Not an admin/maintenance function. |
| `backup-export` | Authenticated admin only | No code change required. Already returns 401/403. |
| `backup-import` | Authenticated admin only | No code change required. Already returns 401/403. |
| `classify-sourcing-email` | Authenticated user required | No code change required. Not an admin/maintenance function. |
| `extract-gmail-contacts` | Service-role function accepted caller-supplied Gmail tokens | Added active-user role validation (`admin`, `manager`, `sales`), server-side token lookup by authenticated user, and audit logging. Browser no longer supplies Gmail tokens. |
| `fix-stock-reservations` | Anonymous service-role maintenance/repair function | Added admin-only auth/role gate, 401/403 handling, audit logging, and removed bucket creation/update privacy mutation. |
| `gmail-attachment-save` | Authenticated user plus admin/manager document-save role check | Switched Gmail token reads to encrypted-token RPC helper. |
| `gmail-inbox-list` | Authenticated user required | Switched Gmail token reads to encrypted-token RPC helper. |
| `gmail-inbox-message` | Authenticated user required | Switched Gmail token reads to encrypted-token RPC helper. |
| `gmail-oauth-callback` | Authenticated user required | No auth change. Database trigger now encrypts tokens written by this function after migration/key setup. |
| `parse-bca-statement` | Authenticated user required | No code change required. Not an admin/maintenance function. |
| `parse-pharma-email` | Service-role parser callable anonymously | Added active-user role validation (`admin`, `manager`, `sales`) before parsing. |
| `parse-source-reply-email` | Authenticated user required | No code change required. Not an admin/maintenance function. |
| `send-app-notifications` | Anonymous service-role system notification function | Added per-notification role validation, 401/403 handling, audit logging, and sender impersonation guard. |
| `send-bulk-email` | Authenticated user required, workflow role gate for fallback sender | Switched Gmail token reads to encrypted-token RPC helper. |
| `sync-gmail-emails` | Authenticated user lookup, weak error handling | Added active-user role validation (`admin`, `manager`, `sales`) and switched Gmail token reads to encrypted-token RPC helper. |

## fix-stock-reservations

Findings:
- It was callable without an authenticated user.
- It used the service role to create missing buckets as `public: true`.
- It updated existing buckets to `public: true`, overwriting privacy settings automatically.

Changes:
- Now requires authenticated active `admin`.
- Returns 401 for missing/invalid JWT and 403 for non-admin users.
- Removed all bucket creation and `public: true` update behavior.
- Writes audit rows for start/completion to `audit_logs` via `edge_function_security` entries.

## Storage Bucket Audit

Static status from migrations:

| Bucket | Public/Private in migrations | Purpose |
|---|---:|---|
| `bank-statements` | private | Bank statement uploads |
| `batch-documents` | public | Batch/import documents |
| `crm-documents` | private | CRM documents and CRM product documents |
| `documents` | public | General documents / purchase invoice fallback |
| `expense-documents` | public | Expense documents |
| `inventory_photos` | public | Inventory photos |
| `petty-cash-receipts` | private | Petty cash receipts |
| `product-documents` | public | Product documents |
| `product-source-documents` | public | Product source documents |
| `purchase-invoices` | private | Purchase invoice documents |
| `rejection_photos` | public | Stock rejection photos |
| `sales-order-documents` | public | Sales order / customer PO documents |
| `task-attachments` | private | Task attachments |

Changes:
- No bucket permissions were changed automatically.
- Added `public.storage_bucket_security_audit` view.
- Added manual review script: `scripts/storage-lockdown-public-buckets.sql`.

## User Profile RLS

Findings:
- Existing anon policies allowed broad anonymous `SELECT` on `user_profiles`, exposing profile fields beyond login need.

Changes:
- Migration drops anonymous `user_profiles` SELECT policies.
- Added `lookup_email_for_username_login(username)` SECURITY DEFINER RPC that returns only `email` and `is_active` for one username lookup.
- Login flow now uses that RPC instead of anonymous table SELECT.

## Gmail Security

Findings:
- `gmail_connections.access_token` and `refresh_token` were plain text columns.

Changes:
- Added `access_token_encrypted`, `refresh_token_encrypted`.
- Added audit fields: `token_accessed_at`, `token_refreshed_at`, `revoked_at`.
- Added pgcrypto-backed encrypt/decrypt helpers and a trigger that moves written plaintext tokens into encrypted columns.
- Added `get_gmail_connection_secret(...)` RPC for service-side decrypted token access; it updates `token_accessed_at`.
- Gmail-facing Edge Functions now use the encrypted-token helper path.

Required deployment step:
- Configure `app.gmail_token_encryption_key` with a strong secret before relying on encrypted token writes, for example through a controlled database setting/secret management process. The migration intentionally does not hard-code a key.

## XSS Protection

`dangerouslySetInnerHTML` review:

| File | Status |
|---|---|
| `src/components/crm/EmailBodyViewer.tsx` | Already sanitized with DOMPurify. |
| `src/components/crm/GmailLikeComposer.tsx` | Added DOMPurify sanitization for HTML composer preview. |
| `src/components/crm/StockUpdateEmailComposer.tsx` | Added DOMPurify sanitization for stock email preview. |

## Files Changed

- `supabase/functions/_shared/security.ts`
- `supabase/functions/_shared/gmailSecrets.ts`
- `supabase/functions/extract-gmail-contacts/index.ts`
- `supabase/functions/fix-stock-reservations/index.ts`
- `supabase/functions/gmail-attachment-save/index.ts`
- `supabase/functions/gmail-inbox-list/index.ts`
- `supabase/functions/gmail-inbox-message/index.ts`
- `supabase/functions/parse-pharma-email/index.ts`
- `supabase/functions/send-app-notifications/index.ts`
- `supabase/functions/send-bulk-email/index.ts`
- `supabase/functions/sync-gmail-emails/index.ts`
- `src/components/crm/GmailLikeComposer.tsx`
- `src/components/crm/StockUpdateEmailComposer.tsx`
- `src/contexts/AuthContext.tsx`
- `supabase/migrations/20260602090000_security_hardening_sprint.sql`
- `scripts/storage-lockdown-public-buckets.sql`
- `SECURITY_HARDENING_REPORT_2026-06-02.md`

## SQL Migrations Created

- `supabase/migrations/20260602090000_security_hardening_sprint.sql`

## Remaining Risks / Follow-Up

- Apply and verify the Gmail token encryption key before deploying the migration to production.
- Run `SELECT * FROM public.storage_bucket_security_audit;` against production and approve bucket lockdown bucket-by-bucket.
- Public bucket lockdown may require signed URL adjustments in older flows before changing bucket privacy.
- Some non-maintenance AI/parser functions allow any authenticated user; this preserves current app behavior but can be narrowed later by module permission.
- Project-wide TypeScript typecheck has pre-existing failures unrelated to this sprint; build verification was used for this scoped change.
