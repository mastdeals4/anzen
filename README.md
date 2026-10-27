# Anzen ERP — Pharmaceutical Raw Material Trading

A full-featured Enterprise Resource Planning system built for **PT. Shubham Anzen Pharma Jaya**, handling pharmaceutical raw material procurement, sales, inventory, finance, and logistics.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript |
| Build | Vite 5 |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth |
| Storage | Supabase Storage |
| Styling | Tailwind CSS |
| State | React Context API |
| Charts | Recharts |
| PDF | jsPDF + html2canvas |
| Excel | XLSX |

---

## Modules

### CRM
- Inquiry pipeline with multi-product support
- Follow-up scheduling and activity tracking
- CRM Command Center for bulk Gmail email sync
- Sales team performance overview

### Inventory & Batches
- Batch-level stock tracking (FIFO)
- Import date, expiry date, landed cost per unit
- Document uploads per batch (CoA, MSDS, etc.)
- Near-expiry alerts and low-stock thresholds
- Manual stock adjustments with audit trail

### Sales Orders
- Full approval workflow: draft → pending → reserved/shortage → delivered
- Automatic stock reservation on approval
- Shortage detection with automatic import requirement creation
- Customer purchase order (PO) file upload and inline preview
- Auto-release of reservations on cancellation / delivery / closure

### Delivery Challans
- Link one or multiple sales orders per challan
- FIFO batch selection with real-time stock validation
- Two-stage stock deduction: reserved on creation, deducted on approval
- Proforma invoice and delivery challan PDF generation

### Finance
- **Sales Invoices** — linked to delivery challans, with payment status tracking
- **Purchase Invoices** — supplier invoices with balance management
- **Payment Vouchers** — atomic save with voucher allocation and invoice balance update in one DB transaction
- **Receipt Vouchers** — customer payment recording with allocation to invoices or advance payments
- **Credit Notes** — stock restored only on approval (not on creation)
- **Bank Reconciliation** — match transactions to vouchers
- **Petty Cash** — daily petty cash register
- **General Journal** — manual journal entries
- **Chart of Accounts** — full Indonesian accounting chart
- **Financial Reports** — P&L, balance sheet, aging receivables/payables

### Products
- Product master with HSN codes, categories, units
- Source/supplier and grade tracking
- Document management with inline viewer (no popup required)

### Import Containers
- Container-level cost allocation to batches
- Import requirement tracking from shortage orders

### Logistics
- Material Returns
- Stock Rejections

### Settings & Users
- Role-based access control (admin, sales, accounts, warehouse, manager, auditor_ca)
- Company settings (name, logo, address, tax details)
- User management

### Dashboard
- Real-time stat cards per role
- Overdue invoice tracking (single batch query, not N+1)
- Gross profit calculated from actual batch landed costs
- Revenue trend chart (6 months)
- Sales pipeline chart by order status
- Today's Actions panel

---

## Project Structure

```
src/
  pages/           Top-level page components (one per module)
  components/
    finance/       Finance sub-module components
    crm/           CRM sub-module components
    dashboard/     Dashboard charts and widgets
    commandCenter/ CRM command center
    settings/      Settings panels
    tasks/         Task management
  contexts/        Global state providers (Auth, Language, Navigation)
  lib/             Supabase client configuration
  utils/           Currency formatting, date utilities, permissions
  types/           Shared TypeScript interfaces

supabase/
  migrations/      SQL migration files (ordered by timestamp)
  functions/       Deno Edge Functions
```

---

## Environment Variables

Set these in Replit Secrets:

| Variable | Description |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-side only) |

---

## Running the App

```bash
npm install
npm run dev        # starts dev server on port 5000
npm run build      # production build → dist/
```

---

## Production Release Status - 2026-06-03

Final pre-release validation has been run against the live Supabase production
database. Current verified state:

- Finance audit completed.
- Trial Balance is balanced.
- Historical COGS repair completed with additive correction journals.
- The three historical unbalanced journals were repaired; no posted unbalanced
  journals remain.
- Receipt voucher repair completed for `RV/25-26/011`; its journal now has two
  balancing lines and correct debit/credit totals.
- Nineteen stale sales invoice `balance_amount` values were corrected from
  existing receipt allocations.
- `RV2606-0002` is balanced as a receipt voucher; its unallocated remainder is
  unapplied/advance receipt value, not an automatic allocation error.
- `SO-2025-0004 -> DO-26-0002 -> SAPJ-26-002` linkage has been repaired by
  setting the missing DC `sales_order_id`.
- Sales Order dashboard summary cards use the same business-status mapping as
  the table: Total Orders, Processing, Shortage, Completed, and Overdue.

Known release blockers:

- Apply `supabase/migrations/20260603173000_fix_sales_order_delete_trigger_overload.sql`
  through a direct database migration channel.
- Delete the remaining E2E records after that migration:
  `e2e-SO-TEST-1780479381949` and `e2e-customer-TEST-1780479381949`.
- Full live E2E validation is blocked until the E2E cleanup delete path works.
- The 28 batch history mismatches are historical
  `inventory_transactions.stock_before/stock_after` snapshot drift. Current
  batch stock is correct and should not be adjusted for these rows.

---

## Key Database Functions (RPCs)

| Function | Purpose |
|---|---|
| `fn_reserve_stock_for_so_v2` | Reserve stock across batches (FIFO) when SO is approved |
| `fn_release_reservation_by_so_id` | Release all reservations for a sales order |
| `fn_release_partial_reservation` | Release a specific quantity from reservations |
| `fn_auto_release_on_so_status_change` | Trigger: auto-release on delivered/cancelled/closed |
| `save_payment_voucher` | Atomic: insert voucher + allocations + update invoice balances |
| `generate_voucher_number` | Race-condition-safe voucher number generation (advisory lock) |
| `get_overdue_balances` | Batch fetch all overdue invoice balances in one query |
| `get_cogs_for_period` | Real COGS from batch landed costs for a date range |
| `get_invoices_with_balance` | Customer invoices with live balance from allocations |
| `adjust_batch_stock_atomic` | Atomic manual stock adjustment |
| `edit_delivery_challan` | Atomic DC edit with reservation update |

---

## Stock Reservation Flow

```
Sales Order Approved
      │
      ▼
fn_reserve_stock_for_so_v2
      │
      ├─ Sufficient stock ──→ status = 'stock_reserved'
      │
      └─ Insufficient stock → status = 'shortage'
                               + Import Requirements created

Delivery Challan Created  → stock reserved (not yet deducted)
Delivery Challan Approved → stock deducted from current_stock

SO Cancelled / Delivered / Closed
      │
      ▼
trigger_auto_release_on_so_status
      │
      ▼
fn_release_reservation_by_so_id
(sets status = 'released' AND is_released = true)
```

---

## User Roles

| Role | Access |
|---|---|
| `admin` | Full access to all modules |
| `sales` | CRM, Sales Orders, Customers, Delivery Challans |
| `accounts` | Finance, Invoices, Vouchers, Reconciliation |
| `warehouse` | Inventory, Batches, Delivery Challans |
| `manager` | Read-heavy access + approvals |
| `auditor_ca` | Read-only access to finance and reports |

---

## Storage Buckets

| Bucket | Contents |
|---|---|
| `product-source-documents` | Product grade/source documents (CoA, etc.) |
| `batch_documents` | Batch-level documents |
| `sales-order-documents` | Customer PO uploads |

All documents are served via **signed URLs** (1-hour TTL) and displayed in an **inline iframe viewer** — no popup windows.

---

## Developer Notes

- All stock changes go through DB triggers and RPCs. Never update `batches.current_stock` directly.
- Credit notes only restore stock when **approved** — not on creation.
- Payment vouchers use the `save_payment_voucher` RPC for full atomicity.
- Voucher numbers use `generate_voucher_number(prefix)` with advisory locks — safe under concurrent saves.
- The `trg_sync_batch_reserved_stock` trigger is the single source of truth for `batches.reserved_stock`. Always set `status = 'released'` (not just `is_released = true`) when releasing reservations, or they will still count as reserved.
