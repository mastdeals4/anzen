# database.md — Anzen Finance/Tax Table Reference

Per-table reference limited to Finance + Tax scope. For CRM/Inventory
tables, read the corresponding module docs (not covered here).

Each row: **Purpose · Relationships · Triggers · RLS · Where used**.

---

## chart_of_accounts
- **Purpose:** master chart of accounts (Indonesian SME + tax additions).
- **Relationships:** self-ref `parent_id`; referenced by `journal_entry_lines.account_id`, `bank_accounts.coa_id`, `petty_cash_books.account_id`, `tax_codes.collection_account_id / payment_account_id`, `finance_expenses.fixed_asset_account_id`.
- **Triggers:** none.
- **RLS:** authenticated read; admin/manager write.
- **UI:** `ChartOfAccountsManager.tsx`.

## accounting_periods
- **Purpose:** fiscal year/month tracking, closed_by/at.
- **Relationships:** referenced by `journal_entries.period_id`.
- **Triggers:** none (period lock enforced in app + Finance close flow).
- **UI:** referenced in period-close UIs (not primary edit surface).

## tax_codes
- **Purpose:** PPN + PPh rate master.
- **Relationships:** referenced by `journal_entry_lines.tax_code_id`, `purchase_invoice_items.tax_code_id`, `payment_vouchers.pph_code_id`, `finance_expenses.pph_code_id`, `suppliers.default_pph_code_id`.
- **Triggers:** none.
- **UI:** Settings.

## organization_tax_settings
- **Purpose:** NPWP, PKP status, Faktur prefix + counter, fiscal year.
- **Relationships:** singleton (first row wins).
- **Triggers:** none.
- **RPCs:** `assign_faktur_pajak_number` mutates `faktur_current_number` under advisory lock.
- **UI:** Settings (not yet exposed as a dedicated screen).

## suppliers
- **Purpose:** vendor master + NPWP/PKP + default tax preference.
- **Relationships:** referenced by `purchase_invoices.supplier_id`, `payment_vouchers.supplier_id`, `finance_expenses.supplier_id`, `journal_entry_lines.supplier_id`.
- **Triggers:** none.
- **UI:** `SuppliersManager.tsx`.

## journal_entries
- **Purpose:** double-entry header. `source_module` + `reference_id` link back to the source doc.
- **Relationships:** referenced by `journal_entry_lines.journal_entry_id`, `sales_invoices.journal_entry_id`, `purchase_invoices.journal_entry_id`, `receipt_vouchers.journal_entry_id`, `payment_vouchers.journal_entry_id`, `petty_cash_vouchers.journal_entry_id`, `tax_payments.journal_entry_id`, `bank_reconciliation_items.journal_entry_id`.
- **Triggers:** none directly.
- **RLS:** authenticated read; admin/manager write.
- **UI:** `GeneralJournalEntry.tsx` for manual entries; auto-created by module triggers.

## journal_entry_lines
- **Purpose:** the ledger. debit XOR credit; account_id required.
- **Relationships:** `journal_entry_id → journal_entries.id ON DELETE CASCADE`.
- **Triggers:** none.
- **UI:** rendered by Ledger, Trial Balance, P&L, Balance Sheet.

## purchase_invoices + purchase_invoice_items
- **Purpose:** AP invoicing (Indonesian PIB import support).
- **Additive tax column:** `tax_period_id` (Tax Compliance integration, 2026-07-13).
- **Triggers:**
  - `trg_post_purchase_invoice` → `post_purchase_invoice_journal`.
  - `trg_auto_attribute_purchase_invoice_period` → attributes to PPN tax_period on insert/update.
  - `trg_lock_purchase_invoices_by_period` → blocks writes on closed tax periods.
- **RPCs:** `delete_purchase_invoice(uuid)`.
- **UI:** `PurchaseInvoiceManager.tsx`.

## sales_invoices + sales_invoice_items
- **Purpose:** AR invoicing.
- **Additive tax columns:** `faktur_pajak_number`, `tax_amount`, `stamp_duty_amount`, `tax_period_id` (Tax Compliance Centre, 2026-07-13).
- **Triggers:**
  - `trg_post_sales_invoice` → `post_sales_invoice_journal`.
  - `trg_auto_attribute_sales_invoice_period` → attributes to PPN tax_period on insert/update.
  - `trg_lock_sales_invoices_by_period` → blocks writes on closed tax periods.
- **UI:** Sales module + `TaxComplianceCentre → Faktur Pajak` for tax number assignment.

## receipt_vouchers
- **Purpose:** customer payments.
- **Triggers:** `trg_post_receipt_voucher`.
- **UI:** `ReceiptVoucherManager.tsx`.

## payment_vouchers
- **Purpose:** supplier payments.
- **Triggers:** `trg_post_payment_voucher`.
- **UI:** `PaymentVoucherManager.tsx`.

## voucher_allocations
- **Purpose:** allocates RV/PV amount against SI/PI.
- **RLS:** authenticated read; admin/manager write.
- **UI:** inline in RV/PV managers.

## petty_cash_books + petty_cash_vouchers + petty_cash_files
- **Purpose:** petty cash tracking with photo receipts.
- **Triggers:** `trg_post_petty_cash`.
- **UI:** `PettyCashManager.tsx`.

## finance_expenses
- **Purpose:** operating expenses, broker items, import PIB. Wide table.
- **Tax columns:** `ppn_amount`, `pph_amount`, `pph_code_id`, `stamp_duty_amount`, `dpp_amount`, `ppn_calc_mode`, `ppn_rate`, `pph_paid_amount`, `broker_items JSONB`, `tax_period_id` (2026-07-13).
- **Triggers:** `trg_auto_post_expense`; `trg_auto_attribute_finance_expense_period` (2026-07-13); `trg_lock_finance_expenses_by_period`.
- **UI:** `ExpenseManager.tsx`.

## bank_accounts
- **Purpose:** bank/cash account master. `coa_id` maps to CoA.
- **UI:** `BankAccountsManager.tsx`.

## bank_reconciliations + bank_reconciliation_items + bank_statement_lines
- **Purpose:** monthly bank statement reconciliation.
- **Tax integration column:** `bank_statement_lines.matched_tax_payment_id → tax_payments.id ON DELETE SET NULL` (2026-07-13).
- **Triggers:**
  - `trg_auto_reconcile_tax_payment` on `bank_reconciliation_items` — flips `tax_payments.status` to `reconciled` on match.
  - `trg_auto_reconcile_tax_payment_from_bsl` on `bank_statement_lines` — same flip via PDF-statement path; **also** flips back to `posted` on unmatch.
- **UI:** `BankReconciliationEnhanced.tsx`.

## approval_workflows + approval_thresholds
- **Purpose:** shared approval gate.
- **Triggers:** none.
- **UI:** `ApprovalNotifications.tsx`.

## audit_logs
- **Purpose:** central mutation audit sink.
- **Written by:** every SECURITY DEFINER RPC that mutates state.

---

## Tax Compliance tables (new, 2026-07-13)

### tax_periods
- **Purpose:** monthly filing period per `(fiscal_year, period_month, tax_type)`.
- **Columns:** status, filing_status, filed_at/by, closed_at/by, reopen_reason/at/by, snapshot totals (input_ppn_total, output_ppn_total, net_ppn, carry_forward_in/out, pph_total).
- **Relationships:** referenced by `tax_payments.tax_period_id`, `faktur_pajak.tax_period_id`, `sales_invoices.tax_period_id`, `finance_expenses.tax_period_id`.
- **Triggers:** `trg_tax_periods_updated_at`.
- **RLS:** authenticated read; admin/manager write.
- **RPCs:** `upsert_tax_period`, `compute_period_ppn`, `close_tax_period`, `reopen_tax_period`.
- **UI:** `TaxCalendarPanel`, `TaxPeriodsPanel`, `PphRegisterPanel`, `PeriodClosePanel`.

### tax_payments
- **Purpose:** government remittances.
- **Columns:** tax_type, payment_date, amount, bank_account_id, billing_code, ntpn, government_reference, **payment_reference** (bank transfer receipt reference, added 2026-07-13), notes, payment_voucher_id (nullable), journal_entry_id (nullable), status.
- **Relationships:** `tax_period_id → tax_periods.id`, `bank_account_id → bank_accounts.id`, `journal_entry_id → journal_entries.id`.
- **Triggers:** `trg_tax_payments_updated_at`; `trg_lock_tax_payments_by_period`.
- **RLS:** authenticated read; admin/manager write.
- **RPCs:** `record_tax_payment` (9-arg legacy + 10-arg with payment_reference), `update_tax_payment` (reverse+repost), `delete_tax_payment` (self-verifying, mirrors delete_purchase_invoice), `mark_tax_payment_reconciled`.
- **UI:** `TaxPaymentsPanel` (form uses bank alias; Edit + Delete row actions gated by status; attachment section reuses TaxAttachments component).

### tax_payment_files
- **Purpose:** attachments for tax payments.
- **Kinds:** billing_code, ntpn, government_receipt, bank_transfer_proof, faktur_pajak, other.
- **RLS:** authenticated read; admin/manager write.
- **UI:** `TaxAttachments` under `TaxPaymentsPanel`.

### faktur_pajak
- **Purpose:** one row per sales_invoice with an assigned Faktur number.
- **Columns:** sales_invoice_id (unique), tax_period_id, faktur_number (unique), issue_date, customer_id, dpp_amount, ppn_amount, status (generated / uploaded / reported / cancelled), reported_at.
- **Triggers:** `trg_faktur_pajak_updated_at`; `trg_lock_faktur_pajak_by_period`.
- **RLS:** authenticated read; admin/manager write.
- **RPCs:** `assign_faktur_pajak_number`.
- **UI:** `FakturPajakPanel` (renders customer.company_name || customer.customer_name; respects global date filter; click invoice # to drill into Sales).

### faktur_pajak_files
- **Purpose:** attachments (PDF / XML / CSV) per Faktur.
- **UI:** `TaxAttachments` under `FakturPajakPanel`.

### tax_calendar_config
- **Purpose:** configurable Indonesian due-date rules per tax_type.
- **Columns:** tax_type (unique), payment_due_day, filing_due_day, due_relative_month_offset, end_of_month_payment, description, is_active.
- **RLS:** authenticated read; **admin-only write** (unlike other tax tables).
- **UI:** not yet exposed (edit via SQL for now).

---

## Views

| View | Query focus |
|------|-------------|
| `vw_input_ppn_report` | Legacy input PPN by month (finance_expenses). |
| `vw_output_ppn_report` | Legacy output PPN by month (sales_invoices). |
| `vw_monthly_tax_summary` | Legacy net PPN monthly. |
| `vw_pph22_advance_tax_report` | Legacy PPh 22 register. |
| `vw_ppn_net_by_period` | Per tax_period Input/Output/Net/Carry Forward. |
| `vw_pph_by_period_type` | Per tax_period+type PPh total/paid/outstanding. |
| `vw_outstanding_tax` | Any period with unpaid tax. |
| `vw_tax_period_status` | One-row-per-period status for the calendar UI. |
# Inventory Version 1.0 canonical objects

The normative reference is `docs/inventory_bible.md`.

| Object | Purpose |
|---|---|
| `inventory_engine_certification` | Engine version and forward-enforcement timestamp |
| `inventory_transactions.operation_id` | Unique movement idempotency key |
| `post_inventory_movement` | Only writer of physical batch quantity |
| `save_batch_inventory_v1` | Canonical Batch Create/Edit |
| `approve_sales_order_inventory_v1` | SO approval plus FEFO reservation |
| `inventory_v1_consume_reservation` | DC-to-reservation batch enforcement |
| `archive_batch_inventory_v1` | Zero-stock history-preserving archive |
| `inventory_v1_stock_summary` | Canonical Stock Summary view |
| `inventory_v1_movement_report` | Canonical Inventory Movement report RPC |
| `inventory_v1_certification_status` | Forward integrity certification |

All Inventory mutation RPCs deny anonymous execution. Direct
`batches.current_stock` and `inventory_transactions` mutations are blocked by
database triggers.
