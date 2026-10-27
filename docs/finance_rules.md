# finance_rules.md — Anzen Finance Constitution

> Normative consolidation: [finance_bible.md](finance_bible.md). This file is a
> concise constitutional companion. If wording conflicts, verify the applied
> database and update both documents in the same change.

Immutable rules that govern the Anzen Finance module. Every change to
Finance-adjacent code MUST respect these. If a rule genuinely needs to
change, it needs an explicit design discussion and an update to this file
in the same commit.

---

## 1. Every financial document posts to the Journal

- **Sales Invoices** post via `post_sales_invoice_journal()` trigger.
- **Purchase Invoices** post via `post_purchase_invoice_journal()` trigger.
- **Receipt Vouchers** post via `post_receipt_voucher_journal()` trigger.
- **Payment Vouchers** are saved through `save_payment_voucher_command` and
  posted through the canonical `post_payment_voucher(uuid, uuid)` RPC. The
  legacy insert trigger remains only for backward compatibility.
- **Petty Cash Vouchers** post via `post_petty_cash_journal()` trigger.
- **Finance Expenses** post via `auto_post_expense_accounting()` trigger.
- **Tax Payments** post via the `record_tax_payment(...)` RPC (not a
  trigger, so the RPC can construct a JE without a supplier row).

**Rule:** No document can bypass the Journal. If you invent a new
Finance flow, it MUST post a JE with the correct `source_module` and
`reference_id`.

## 2. One posting path per module

- Never write a JE from client code. Always route through the module's
  trigger or a SECURITY DEFINER RPC. Client code is stateless and
  untrusted from the accounting engine's point of view.
- Never duplicate a JE. If a JE with `source_module = X` and
  `reference_id = Y` already exists, the module's trigger must either
  reuse it or REPLACE it (a "reverse then re-post" pattern is acceptable
  when reissuing).

## 3. Debits equal credits — always

- Every JE must satisfy `SUM(debit) = SUM(credit)`.
- `journal_entries.total_debit` and `total_credit` are set at creation.
  If a trigger emits unbalanced lines, that's a bug — fix the trigger,
  don't hide it.
- Purely additive migrations (recent history: 20260702140000
  `fix_unbalanced_purchase_invoice_jes`) exist to repair prior bugs
  in-place; they don't legalize new unbalanced posts.

## 4. Bank Reconciliation is single-source

- All bank/cash movement lives on `journal_entry_lines` against a
  bank-mapped `chart_of_accounts` row.
- `bank_reconciliation_items.journal_entry_id` is the matching key.
- Tax Payments MUST use this same path (via `record_tax_payment` RPC).
  The `auto_reconcile_tax_payment` trigger flips `tax_payments.status`
  to `reconciled` when the linked JE is matched.
- **Rule:** No second reconciliation system. Any new Finance module that
  moves money must post a JE against a bank CoA account.

## 5. Attachments are per-parent

- Attachments live in the `documents` Supabase storage bucket.
- Each module has its own child table with the same shape:
  `<parent>_files(id, <parent>_id FK, file_url, file_name, file_type, file_size, uploaded_by, uploaded_at [, kind])`.
- Examples: `petty_cash_files`, `tax_payment_files`, `faktur_pajak_files`.
- **Rule:** Do not introduce a global attachments table. Do not upload
  files from a form without a parent-id-scoped row in `<parent>_files`.

## 6. Approval Workflow is centralized

- `approval_workflows` + `approval_thresholds` govern any workflow that
  needs a manager/admin gate.
- New transaction types register a row in `approval_thresholds`; the
  Finance UI (or a RPC) inserts a row in `approval_workflows` with
  `transaction_type`, `transaction_id`, `amount`.
- **Rule:** Do not build a bespoke approval flow. Extend the existing
  tables and reuse `ApprovalNotifications`.

## 7. Closed periods are frozen

- **Accounting periods** with `status = 'closed'` block posting via
  application logic (client-side check today; long-term: a
  DB-side trigger similar to `enforce_tax_period_lock`).
- **Tax periods** with `status = 'closed'` block INSERT/UPDATE/DELETE
  on `sales_invoices` and `finance_expenses` whose `tax_period_id`
  references them, via the `enforce_tax_period_lock()` trigger
  (service_role bypass).
- **Rule:** No edits inside a closed period. Admin Override goes through
  `reopen_tax_period(period_id, reason)` which requires a reason and
  writes to `audit_logs`.

## 8. Every deletion reverses/unlinks safely

- `delete_purchase_invoice(uuid)` (2026-07-09) is the reference pattern:
  it verifies orphan cleanup and rolls back the whole operation if any
  invariant would be violated.
- **Rule:** Never `DELETE FROM finance_*` without a corresponding
  reversal of dependent JEs, payment allocations, and bank rec matches.
  Use a SECURITY DEFINER RPC named `delete_<entity>(uuid)` with a
  self-verifying integrity check.

## 9. Every state change is auditable

- `audit_logs(user_id, table_name, action_type, record_id, old_values, new_values, created_at)`
  is the sink.
- All state-changing RPCs in Tax Compliance (`assign_faktur_pajak_number`,
  `record_tax_payment`, `mark_tax_payment_reconciled`, `close_tax_period`,
  `reopen_tax_period`) write to `audit_logs`.
- **Rule:** New SECURITY DEFINER RPCs that mutate finance-critical state
  MUST insert into `audit_logs`.

## 10. Currency is per-document, not per-line

- `purchase_invoices.currency` and `.exchange_rate` are the source of
  truth. Line items store per-unit price in document currency; the JE
  posts in IDR using the document-level exchange rate.
- **Rule:** Never mix currencies in a single JE. Post FX gain/loss to
  7300 (Rugi Selisih Kurs).

## 11. RLS is the primary security gate

- Every finance table has RLS enabled.
- Read policies are broad ("authenticated read") because Finance data is
  operationally visible.
- Write policies are role-gated (admin/manager only, `is_active = true`).
- **Rule:** SECURITY DEFINER RPCs are trusted because they enforce role
  checks in-code. Client-side code never gets a bypass.

## 12. Faktur Pajak numbers are sequential and unique per issuer

- `organization_tax_settings.faktur_current_number` is the counter.
- `assign_faktur_pajak_number(sales_invoice_id)` uses
  `pg_advisory_xact_lock(hashtext('faktur_pajak_seq'))` to serialize
  concurrent callers.
- **Rule:** Never assign a Faktur number from client code. Always via
  the RPC.

## 13. Tax payments hit the same journal as any other payment

- Dr Tax Payable (2130/2131/2132/2133/2137/2138 by tax type).
- Cr Bank (bank_accounts.coa_id, fallback 1111).
- Same shape as a normal payment voucher — hence Bank Reconciliation
  works with zero changes.
- **Rule:** No parallel "tax journal". Tax entries live in the same
  `journal_entries` table with `source_module = 'tax_payment'`.

## 14. Every trigger is idempotent

- `IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DROP TRIGGER IF EXISTS` +
  `CREATE TRIGGER` are the norm.
- **Rule:** A migration must be safe to re-run against a partially
  applied state. The `upsert_notification` migration failure (2026-07-13)
  exists as a cautionary tale — read commit 36e52c7 for the fix.

## 15. Documentation is code

- These `docs/*.md` files ARE the architecture. If code drifts from the
  docs, either the docs are stale (fix them first) or the code is wrong
  (fix the code).
- **Rule:** Update the relevant doc(s) in the same PR as the code change
  that motivates the update. Don't ship an "I'll doc it later" PR.
