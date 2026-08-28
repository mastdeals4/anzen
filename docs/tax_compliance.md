# tax_compliance.md — Anzen Tax Compliance Centre

Indonesian tax handling for Anzen. Ships with the Tax Compliance Centre
(2026-07-13). Reference migrations:

- `20260713140000_tax_compliance_centre_schema.sql`
- `20260713140100_tax_compliance_rpcs.sql`
- `20260713150000_tax_compliance_integration.sql` (auto-attribution
  triggers, extended period lock, notifications, `payment_reference`
  column, `record_tax_payment` 10-arg overload)
- `20260713160000_tax_compliance_accounting_engine.sql` (accounting
  engine completion — `delete_tax_payment` / `update_tax_payment`
  self-verifying RPCs, `bank_statement_lines.matched_tax_payment_id`
  typed FK, live snapshot recompute triggers, hardened `close_tax_period`
  preconditions, `compute_period_ppn` now sums purchase invoices +
  expenses for Input PPN)
- `20260713170000_tax_compliance_engine_fixes.sql` (bug fixes — schema
  cache `NOTIFY pgrst`, `auto_reconcile_tax_payment_from_bsl` hardened with
  `source_module='tax_payment'` guard, snapshot backfill re-run, re-grants)
- `20260713180000_recon_engine_hardening.sql` (universal reconciliation
  status-sync trigger `z_bsl_sync_reconciliation_status` on
  `bank_statement_lines` — ensures all modules share one engine)
- `20260713190000_tax_compliance_single_engine.sql` (single engine
  migration — adds `payment_vouchers.tax_period_id`, extends
  `compute_period_ppn` to include PV PPh, fixes `vw_pph_by_period_type`
  to use `tax_payments` for paid amounts, rewrites `vw_monthly_tax_summary`
  to read from the same snapshot as PPN Periods)

## 1. Coverage

- **PPN** (Pajak Pertambahan Nilai, VAT) — Input, Output, Net, Carry
  Forward. Default rate 11 %. DPP Nilai Lain and Manual override modes
  supported on `finance_expenses` (added 2026-07-07).
- **PPh 21** (employee income withholding), **PPh 22** (import),
  **PPh 23** (services), **PPh 4(2)** (final), **PPh Unifikasi**
  (unified return).
- **Faktur Pajak** — sequential numbering, PDF/XML attachments, status
  (generated → uploaded → reported).
- **Tax Payments** — remittance to the government with billing code,
  NTPN, bank transfer proof.
- **Tax Calendar** — configurable Indonesian due-date defaults.
- **Tax Period Close** — hard lock with admin-only reopen.
- **Bea Meterai** — stamp duty on invoices (2026-07-01).

## 2. Data model

### Core tables

| Table | Purpose |
|-------|---------|
| `tax_periods` | Monthly filing period per (year, month, tax_type). Holds status, filing_status, due-dates, snapshot totals. |
| `tax_payments` | One row per remittance. Links to `payment_voucher_id` (nullable) + `journal_entry_id`. |
| `tax_payment_files` | Attachments (billing code, NTPN, gov receipt, bank proof). |
| `faktur_pajak` | One row per sales_invoice with an assigned Faktur #, DPP/PPN split, status. |
| `faktur_pajak_files` | PDF/XML/CSV attachments per Faktur. |
| `tax_calendar_config` | Configurable payment/filing due-day per tax_type. |
| `tax_codes` | Master of tax rates (PPN, PPh21/22/23/25/4(2), other). |
| `organization_tax_settings` | NPWP, PKP status, Faktur prefix + counter. |

### Additive columns

- `sales_invoices.tax_period_id → tax_periods.id`
- `finance_expenses.tax_period_id → tax_periods.id`
- `purchase_invoices.tax_period_id → tax_periods.id`
- `payment_vouchers.tax_period_id → tax_periods.id` (added 2026-07-13 single-engine migration)

### Views

- `vw_ppn_net_by_period` — Input/Output/Net/Carry Forward per PPN period.
- `vw_pph_by_period_type` — Total/Paid/Outstanding per PPh type per period.
- `vw_outstanding_tax` — Any period with unpaid tax.
- `vw_tax_period_status` — One-row-per-period status summary for the UI.

Legacy views kept for backwards compat: `vw_input_ppn_report`,
`vw_output_ppn_report`, `vw_monthly_tax_summary`, `vw_pph22_advance_tax_report`.
Rendered by the "Registers (legacy)" tab.

## 3. Chart of Accounts — tax rows

| Code | Name |
|------|------|
| 1150 | PPN Input (VAT Receivable) |
| 2130 | PPN Output (VAT Payable) |
| 2131 | PPh 21 Payable |
| 2132 | PPh 23 Payable |
| 2133 | PPh 25 Payable |
| 2135 | Bea Meterai Payable |
| 2137 | PPh 22 Payable (added 2026-07-13) |
| 2138 | PPh 4(2) Payable (added 2026-07-13) |
| 6950 | Bea Meterai Expense |

## 4. Workflows

### 4.1 Recording an expense with PPN + PPh

1. User creates a `finance_expenses` row with `ppn_amount`, `pph_amount`,
   `pph_code_id`.
2. `auto_post_expense_accounting()` trigger posts:
   - Dr Expense category
   - Dr 1150 PPN Input (if ppn_amount > 0)
   - Cr Bank / Cash / AP
   - Cr PPh Payable (if pph_amount > 0)
3. Optionally set `tax_period_id` to attribute to a Tax Compliance
   period. If NULL, it still shows in the legacy `vw_input_ppn_report`
   by expense_date month.

### 4.2 Issuing a Faktur Pajak

1. User opens `/finance/tax` → **Faktur Pajak** tab.
2. Sees sales invoices with PPN and no Faktur number.
3. Clicks "Generate #" → calls `assign_faktur_pajak_number(invoice_id)`.
4. RPC atomically:
   - `pg_advisory_xact_lock('faktur_pajak_seq')`
   - Increments `organization_tax_settings.faktur_current_number`
   - Formats: `{faktur_prefix}.{lpad(number,8)}-{YY}`
   - Writes `sales_invoices.faktur_pajak_number`
   - Upserts `tax_periods` for the PPN period, sets
     `sales_invoices.tax_period_id`
   - Upserts `faktur_pajak` row with DPP/PPN split, status='generated'
   - Writes `audit_logs` entry
5. User attaches Faktur PDF (uploaded → `faktur_pajak_files`).
6. Status transitions: generated → uploaded → reported.

### 4.3 Recording a Tax Payment

1. User opens `/finance/tax` → **Tax Payments** tab.
2. Form fields: Tax Type, Tax Period, Payment Date, Amount, Bank Account
   (rendered by alias — "BCA Operational" — via `bank_accounts.alias`),
   Billing Code (Kode Billing), NTPN, Payment Reference, Notes.
3. Submit → `record_tax_payment(...)` 10-arg RPC:
   - Inserts `tax_payments` row (status='draft') including
     `payment_reference` for the bank-transfer receipt reference.
   - Posts a JE with `source_module='tax_payment'`:
     - Dr Tax Payable (2130/2131/2132/2133/2137/2138)
     - Cr Bank (bank_accounts.coa_id or 1111 fallback)
   - JE `reference_number` prefers NTPN → Billing Code → Payment
     Reference → synthetic `TAX-YYMM-<uuid>` in that order.
   - Updates `tax_payments.journal_entry_id`, flips status='posted'
   - Nudges `tax_periods.status` from 'open' → 'payment_pending'
   - Writes `audit_logs` entry
4. User attaches Billing Code / NTPN receipt / bank transfer proof to
   `tax_payment_files` via the shared attachment component (same UX
   as Expense / Petty Cash — PDF + image + paste-to-attach).
5. On the next bank statement, the payment shows up in Bank
   Reconciliation as an unmatched JE → user matches it →
   `bank_reconciliation_items.is_matched = true` → `auto_reconcile_tax_payment`
   trigger fires → `tax_payments.status = 'reconciled'`.

### 4.6 Auto-attribution from source modules

Sales Invoices, Purchase Invoices, and Finance Expenses no longer need
manual "assign to period" clicks. Three BEFORE INSERT/UPDATE triggers
(one per table) resolve the correct `tax_period_id` from the transaction
date and create the PPN period if it doesn't yet exist. Companion
PPh21/22/23/4(2)/Unifikasi periods for the same month are created via
an AFTER INSERT trigger on `tax_periods` itself. Backfill was run for
all pre-existing rows in the migration.

### 4.8 Edit / Delete a Tax Payment

- **Edit** → `update_tax_payment(...)` RPC. Reverses the current JE,
  posts a fresh one with the new fields, keeps the `tax_payments` row
  (same id, same period, same tax_type). Refuses when the period is
  closed. Refuses when the payment is `reconciled` unless the caller is
  an admin — non-admins must first unmatch it in Bank Reconciliation.
  Full old/new audit_log entry.
- **Delete** → `delete_tax_payment(id)` RPC. Same integrity pattern as
  `delete_purchase_invoice`: locks the row, releases any
  `bank_statement_lines` typed FK + `matched_entry_id`, releases
  `bank_reconciliation_items.is_matched`, deletes attachments (storage
  paths returned in audit log for client-side bucket cleanup), removes
  the JE lines + JE, deletes the row, then re-queries every touched
  table. Any orphan → `RAISE EXCEPTION` rolls the whole transaction
  back. Refuses on closed periods.

### 4.9 Live snapshot recompute

Every INSERT/UPDATE/DELETE of `sales_invoices`, `purchase_invoices`,
`finance_expenses`, or `tax_payments` fires an AFTER trigger that calls
`recompute_periods_for_date(row.date)` → refreshes every `tax_periods`
row (PPN + companion PPh types) for that month. The snapshot on
`tax_periods` is always live — no scheduled job, no manual "Recompute"
button required.

### 4.7 Notifications

`generate_tax_notifications()` (SECURITY DEFINER) runs on the same
10-minute cadence as low-stock / expiry / follow-up / delivery-due
checks, called from `initializeNotificationChecks()`. It writes to the
existing `notifications` table with types `tax_overdue`, `tax_due_soon`,
`faktur_missing`. Direct INSERT is used (bypassing
`upsert_notification`'s admin-only cross-user check because we're
SECURITY DEFINER). A NOT EXISTS guard prevents duplicate unread
notifications per (user, type, period).

### 4.4 Closing a Tax Period

1. User opens `/finance/tax` → **Period Close** tab.
2. UI shows blockers per period:
   - Missing Faktur (PPN only)
   - Unreconciled payments
   - Rp X outstanding
3. Close button enabled only when blockers = 0.
4. Click → `close_tax_period(period_id)` RPC — hardened to check:
   - No missing Faktur Pajak (PPN periods)
   - No draft sales invoices in period
   - No draft purchase invoices in period
   - No unposted `journal_entries` for tax payments in period
   - No unreconciled `tax_payments` (status draft or posted)
   - Zero outstanding payable per `vw_outstanding_tax`
   - Recomputes snapshot (`compute_period_ppn`) before validating
   - Requires admin or manager role
   - Sets `status='closed'`, `closed_at`, `closed_by`
   - Writes `audit_logs` including the snapshot totals
5. Subsequent INSERT/UPDATE/DELETE on `sales_invoices`,
   `purchase_invoices`, `finance_expenses`, `tax_payments`, and
   `faktur_pajak` rows attributed to the closed period are blocked by
   `enforce_tax_period_lock()` trigger.  `journal_entries` with
   `source_module='tax_payment'` are blocked by
   `enforce_tax_je_period_lock()`. Only `service_role` (edge functions)
   bypasses these locks.

### 4.5 Reopening a closed period (admin override)

1. On Period Close, click "Reopen (admin)".
2. Enter a reason (required, kept in `audit_logs`).
3. `reopen_tax_period(period_id, reason)` RPC:
   - Requires admin role
   - Sets `status='reopened'`, `reopen_reason`, `reopened_at`,
     `reopened_by`
   - Writes `audit_logs`

## 5. Tax Calendar defaults (Indonesia, 2026)

| Tax Type | Payment Due | Filing Due |
|----------|-------------|------------|
| PPN | End of following month | End of following month |
| PPh 21 | 10th of following month | 20th of following month |
| PPh 22 | On transaction | 20th of following month |
| PPh 23 | 10th of following month | 20th of following month |
| PPh 4(2) | 15th of following month | 20th of following month |
| PPh Unifikasi | — | 20th of following month |

Adjustable in `tax_calendar_config`. Admin-only write.

## 6. Approval thresholds

Bootstrapped in the schema migration:

- `tax_payment_approval` — up to Rp 10 000 000 needs manager; above needs admin.
- `tax_period_close` — always admin (no amount threshold).

## 7. Faktur Pajak numbering

Format: `{prefix}.{sequential-8-digit}-{YY}`

Example: `010.00000042-26`

The prefix comes from `organization_tax_settings.faktur_prefix` (typical
NNN kode transaksi ID). Counter comes from `.faktur_current_number`.
Advisory lock ensures no gaps under concurrency. Idempotent — calling
`assign_faktur_pajak_number` on an invoice that already has one returns
the existing number.

## 8. Audit trail

Every state-changing RPC writes to `audit_logs(user_id, table_name,
action_type, record_id, new_values)`. Actions:

- `assign_faktur_pajak_number` → table='faktur_pajak', action='insert'
- `record_tax_payment` → table='tax_payments', action='insert'
- `mark_tax_payment_reconciled` → table='tax_payments', action='update'
- `close_tax_period` → table='tax_periods', action='update' (action='close')
- `reopen_tax_period` → table='tax_periods', action='update' (action='reopen')

## 9. Not implemented (recommendations)

- **Billing Code expiry tracking** — MPN billing codes have a validity
  period; today users track this manually. A `billing_codes` table with
  `expires_at` would surface expiring codes on the dashboard.
- **e-Faktur XML import/export** — the DGT's e-Faktur desktop app
  produces/consumes XML. We can generate the outbound XML from
  `faktur_pajak` rows; inbound reconciliation via CSV/XML would be a
  future add.
- **PPh 21 monthly employee calc** — today it flows through
  `finance_expenses.pph_amount`. A full payroll-integrated calc is out
  of scope for this sprint.
- **SPT PPN (VAT return) PDF generation** — the summary numbers exist
  in `vw_ppn_net_by_period`. A future add would render an SPT-form PDF.
