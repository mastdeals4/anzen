# CHANGELOG — Major Anzen ERP Milestones

Reverse-chronological summary of major project milestones. Detailed
per-file diffs live in `git log`.

## 2026-07-26 — Finance stabilization and source-document consolidation

- Bank Reconciliation Loan, Loan Repayment, and Capital Injection actions now
  call shared Finance commands backed by the existing `loans`,
  `loan_transactions`, and `capital_contributions` source tables.
- Owner Withdrawal and non-customer journal receipts now use an atomic shared
  bridge over the existing Manual Journal command and guarded bank-link command;
  the Bank Reconciliation component no longer constructs journal lines itself.
- Removed the superseded `record_non_customer_bank_receipt` RPC, which contained
  its own account mapping, journal creation, and numbering implementation.
- Replaced the legacy loan/capital journal-number implementations with the
  canonical advisory-lock journal generator and added complete transaction /
  functional currency metadata to their existing document models and journals.
- Corrected native Capital Contribution posting, which referenced the
  nonexistent `bank_accounts.coa_id_idr`; it now uses the canonical `coa_id`.
- Journal Register now returns every active posted journal across all accounting
  dates and source modules. Its journal-line lookup is batched to avoid the
  PostgREST URL-length HTTP 400 and per-request row cap, and Journal Numbers in
  both the register and Bank Reconciliation open the shared journal detail popup.
- Manual Journal remains a separate user-entry workspace and continues to list
  only journals whose source module is `manual`.
- Deterministically created three missing Capital Contribution source documents
  for legacy two-line Owner Capital bank journals. No journal amount or line was
  modified. JE2607-0048 was not guessed into a Loan document and is explicitly
  listed for manual review.
- Generated `docs/finance_exception_report.csv` with 463 business-readable
  exception rows (424 distinct records requiring review).

## 2026-07-26 — Finance notification currency display

- Pending Expense approval cards now read repaired transaction-currency
  metadata and display the document amount through the shared
  `formatCurrency` utility; USD expenses no longer fall back to `Rp`.
- Added a shared transaction-currency resolver with Finance metadata
  precedence (`transaction_currency`, `currency_code`, payment/bank
  metadata, then related bank currency) and reused it in Expense Manager.
- Approval workflow amounts now use the shared formatter instead of a
  literal dollar prefix. Petty Cash remains IDR because its native document
  model stores functional IDR amounts and no transaction-currency field.
- The notification audit confirmed that Receipt, Payment, Contra, and Journal
  do not currently emit amount cards; the bell dropdown renders stored text
  and performs no independent Finance currency formatting.

## 2026-07-13 — Tax Compliance accounting engine (Phase 3)
- **delete_tax_payment(id)** — SECURITY DEFINER, self-verifying. Same
  integrity pattern as `delete_purchase_invoice`. Reverses the JE,
  releases both typed FK (`matched_tax_payment_id`) and
  `matched_entry_id` bank recon links, unmatches
  bank_reconciliation_items, removes attachments (storage cleanup path
  returned via audit_logs), integrity-checks every touched table,
  RAISE EXCEPTION rolls back on any orphan. Refuses on closed periods.
- **update_tax_payment(...)** — SECURITY DEFINER. Reverse-and-repost
  pattern. Refuses on closed periods. Refuses on reconciled payments
  unless caller is admin (breaks the recon match; payment returns to
  posted). Full old/new audit log.
- **bank_statement_lines.matched_tax_payment_id** — typed FK column
  matching the pattern for expenses/receipts/petty cash/fund transfer.
  Auto-populated by the reconciliation trigger, released on delete/edit.
- **compute_period_ppn upgraded** — Input PPN now sums `purchase_invoices`
  + `finance_expenses` (was: expenses only). PPh totals filter by
  `tax_codes.tax_type = tax_period.tax_type` for the right split.
  Snapshot is authoritative; every source-row change fires an
  AFTER trigger that recomputes affected periods immediately.
- **close_tax_period hardened** — blocks on: missing Faktur (PPN),
  draft sales/purchase invoices, unposted tax-payment JEs, unreconciled
  tax_payments, outstanding > 0. Snapshot recomputed then re-checked.
- **UI: Edit + Delete** rows added to `TaxPaymentsPanel` — no
  redesign, just the missing surface for the new RPCs. Edit is
  disabled when a payment is reconciled (with tooltip). Delete
  confirmation explains what it reverses.
- Docs updated: `tax_compliance.md` (§4.8 Edit/Delete, §4.9 Live
  snapshot, hardened §4.4), `finance_architecture.md` (RPC + trigger
  tables), `database.md` (typed FK, new RPCs).

## 2026-07-13 — Tax Compliance integration (Phase 2)
- **Auto-attribution + companion PPh periods**: sales/purchase invoices and
  expenses with tax now auto-attach to the correct `tax_period`; new PPN
  periods auto-create matching PPh21/22/23/4(2)/Unifikasi periods.
  Backfill run for existing rows. Removed the developer "Seed …" buttons
  from Tax Calendar.
- **Extended period lock**: `purchase_invoices`, `tax_payments`,
  `faktur_pajak`, and `journal_entries` with `source_module='tax_payment'`
  are now frozen inside a closed tax period (admin override via
  `reopen_tax_period`).
- **Bank alias + gov fields on Tax Payment form**: reuses
  `bank_accounts.alias` display pattern from Payment Voucher; adds
  explicit `payment_reference` column; JE reference falls through NTPN →
  Billing Code → Payment Reference → synthetic.
- **Faktur Pajak page**: real customer names (customer/company), respects
  Global Date Filter, click invoice # to drill into Sales, status filter
  chips, Excel export.
- **9 CA-quality Tax Reports** with Global Date Filter, Excel + PDF
  export (via existing xlsx + browser print pipeline). Replaces "Registers
  (legacy)" tab; renamed to "Tax Reports".
- **Dashboard notifications**: `generate_tax_notifications()` RPC runs
  alongside the existing 10-minute notification checks and emits
  `tax_overdue`, `tax_due_soon`, `faktur_missing` events into the shared
  notifications table (direct INSERT, dedup by unread status).
- **Finance sidebar typography** matched to Main sidebar — text-xs,
  font-medium, `text-gray-600` / active `text-blue-600`, blue-500 left bar.
- **Docs renamed** to lowercase (`finance_architecture.md`,
  `database.md`, `tax_compliance.md`, etc.) with content updates.

## 2026-07-13 — Security Audit + Tax Compliance Centre
- **Security audit fixes** (commit `dafc2bf`): CRITICAL + HIGH findings
  resolved — user self-promotion via user_profiles UPDATE blocked,
  auto_create_user_profile trigger no longer trusts raw_user_meta_data,
  audit_logs INSERT restricted to self, notifications spoofing closed,
  pricing_settings UPDATE restricted to admin/manager. See
  `SECURITY_AUDIT_2026-07-13.md`.
- **Migration idempotency fix** (`36e52c7`): `upsert_notification` migration
  now drops-then-creates by iterating `pg_proc`, safe against pre-existing
  functions with a different return type.
- **Tax Compliance Centre — schema + RPCs** (`8b9d595`): 6 new tables,
  4 new views, 8 new RPCs including `record_tax_payment` which posts a
  journal entry through the same rails as any payment voucher. Auto-
  reconciliation trigger integrates with existing Bank Reconciliation.
  See `docs/tax_compliance.md`.
- **Tax Compliance Centre — UI** (`081546e`): 6 workflow-oriented panels
  replacing the Tax Reports tab (Calendar, PPN Periods, PPh Register,
  Tax Payments, Faktur Pajak, Period Close). Legacy report registers
  retained as one sub-tab.
- **Dashboard integration** (`1d0fcd3`): Tax Compliance cards for admin
  and accounts roles.
- **Architecture docs** (this commit): 6 markdown docs in `docs/` —
  README, FINANCE_RULES (the constitution), SYSTEM_ARCHITECTURE,
  FINANCE_ARCHITECTURE, TAX_COMPLIANCE, DATABASE_SCHEMA, CHANGELOG.

## 2026-07-09 — Finance stabilization pass
- Staff / Utility masters (`12336bd`).
- `delete_purchase_invoice` self-verifying reversal (`10af557`).

## 2026-07-08 — Finance Core frozen
- Commit `b119b7d`: user declared Finance stable after QA sprint. Freeze
  lifted for the Tax Compliance sprint on 2026-07-13.

## 2026-07 (early) — Finance QA + SAP layout sweep
- SAP B1 header layout applied across Expense, Payment, Receipt, Contra,
  Petty Cash, Purchase, Journal, Supplier, Bank, COA, Staff, Utility.
- Dynamic expense form (Salary / Utility / Broker / Normal categories).
- Broker calc engine — 10-column reimbursement grid.

## 2026-07-02 — Finance tax engine hardening
- `finance_tax_engine_hardening.sql` — reworked PPN views.
- Broker items with per-line PPN and PPh 23 tracking.
- Import PIB category breakdown.

## 2026-01 — Payment voucher bank-account fix
- `fix_payment_voucher_use_specific_bank_account.sql` — payment voucher
  now credits the specific bank account instead of a default.

## 2025-12-24/25 — COGS accounting + Expense auto-post
- `add_cogs_accounting_to_sales_invoice.sql` — post COGS + Inventory
  clearing on sales invoice.
- `add_expense_accounting_auto_posting.sql` — finance_expenses trigger
  fires JE.

## 2025-12-16 — Complete Indonesian accounting system
- `complete_indonesian_accounting_system.sql` — the foundation: CoA,
  accounting_periods, tax_codes, organization_tax_settings, suppliers,
  journal_entries + lines, purchase_invoices, receipt_vouchers,
  payment_vouchers, voucher_allocations, petty_cash, bank_reconciliation.

## 2025-12-11 — Manager role + approval system
- `add_manager_role_and_approval_system.sql` — approval_workflows +
  approval_thresholds.

## 2025-11-20 — Initial finance expansion
- `expand_finance_accounts_and_payments.sql` — bank_accounts,
  customer_payments, vendor_bills.

## 2025-10-31 / 2025-11-20 — Pharma trading schema
- Initial pharma trading domain: customers, products, batches, sales,
  audit_logs, user_profiles.
