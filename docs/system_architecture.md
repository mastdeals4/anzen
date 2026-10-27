# system_architecture.md — Anzen ERP End-to-End

## The pipeline

```
                     ┌───────────────────────────┐
                     │           CRM             │
                     │  Inquiries, Emails,       │
                     │  Command Center           │
                     └────────────┬──────────────┘
                                  │  qualify → convert
                                  ▼
                     ┌───────────────────────────┐
                     │          SALES            │
                     │  Sales Orders, Delivery   │
                     │  Challans, Sales Invoices │
                     └────────────┬──────────────┘
                                  │  DC / Invoice
                                  ▼
                     ┌───────────────────────────┐
                     │        INVENTORY          │
                     │  Batches, Stock, Import   │
                     │  Requirements             │
                     └────────────┬──────────────┘
                                  │  cost + FIFO
                                  ▼
                     ┌───────────────────────────┐
                     │          FINANCE          │
                     │  PI / PV / RV / Journal / │
                     │  Petty Cash / Expense /   │
                     │  Bank Recon / Reports     │
                     └────────────┬──────────────┘
                                  │  tax attribution
                                  ▼
                     ┌───────────────────────────┐
                     │  TAX COMPLIANCE CENTRE    │
                     │  PPN, PPh, Faktur Pajak,  │
                     │  Tax Calendar,            │
                     │  Period Close             │
                     └────────────┬──────────────┘
                                  │
                     ┌────────────┴──────────────┐
                     ▼                           ▼
        ┌──────────────────────┐    ┌──────────────────────┐
        │       REPORTS        │    │      DASHBOARD       │
        │  Trial Balance,      │    │  Stat cards,         │
        │  P&L, Balance Sheet, │    │  Tax Compliance      │
        │  Ageing, Ledgers     │    │  cards, Todays       │
        │                      │    │  Actions             │
        └──────────────────────┘    └──────────────────────┘
```

## Module boundaries

| Module    | Entry route(s)              | Owns tables |
|-----------|------------------------------|-------------|
| CRM       | `/crm`, `/command-center`   | `inquiries`, `emails`, `follow_ups` |
| Sales     | `/sales`, `/sales-orders`, `/delivery-challan` | `sales_orders`, `delivery_challans`, `sales_invoices`, `sales_invoice_items` |
| Inventory | `/inventory`, `/batches`, `/stock` | `products`, `batches`, `inventory_transactions`, `stock_reservations`, `import_requirements` |
| Finance   | `/finance/*`                | `journal_entries`, `journal_entry_lines`, `chart_of_accounts`, `purchase_invoices`, `payment_vouchers`, `receipt_vouchers`, `petty_cash_*`, `bank_accounts`, `bank_reconciliations`, `finance_expenses` |
| Tax       | `/finance/tax`              | `tax_periods`, `tax_payments`, `tax_payment_files`, `faktur_pajak`, `faktur_pajak_files`, `tax_calendar_config` |
| Reports   | `/finance/trial_balance` etc | Views + read-only |
| Dashboard | `/dashboard`                | Aggregated reads |

## Cross-module contracts

1. **Sales → Finance:** `sales_invoices` INSERT fires
   `post_sales_invoice_journal()` → creates JE (Dr AR, Cr Revenue, Cr PPN
   Output).
2. **Sales → Tax:** when `assign_faktur_pajak_number(sales_invoice_id)` is
   called, it also upserts `tax_periods` for the invoice's PPN period and
   sets `sales_invoices.tax_period_id`.
3. **Import/Finance → Inventory costing only:** container and purchase data may
   update landed-cost fields on a batch, but never physical quantity. Batch
   Creation is the only stock IN.
4. **Finance → Tax:** `finance_expenses` with `pph_amount > 0` or
   `ppn_amount > 0` is picked up by `vw_input_ppn_report` and
   `vw_pph_by_period_type`. Attribution to a specific tax period is via
   `finance_expenses.tax_period_id`.
5. **Tax → Bank Rec:** `record_tax_payment()` posts a JE with
   `source_module = 'tax_payment'`. `bank_reconciliation_items` matches
   by `journal_entry_id`. On match, `auto_reconcile_tax_payment` trigger
   flips `tax_payments.status = 'reconciled'`.
6. **Sales → Inventory:** Sales Order approval creates FEFO reservations.
   Delivery Challan approval is the only normal physical stock OUT. Sales
   Invoice validates approved DC allocation and is accounting-only.

## What's NOT crossing boundaries

- **CRM does not read from Finance.** Sales pipeline uses SO/DC/Invoice
  status via Sales tables.
- **Inventory does not read from Tax.** PPN on line items is a
  Finance/Tax concern.
- **Tax Compliance Centre does not own bank reconciliation.** It links
  in via JE ids.

## Security perimeter

- All tables have RLS enabled.
- Auth flows through Supabase Auth → `user_profiles.role`
  (`admin` / `manager` / `accounts` / `sales` / `warehouse` / `auditor`).
- SECURITY DEFINER RPCs bypass RLS but enforce role checks in-code.
- Edge functions use the service role client → also bypasses RLS.
- See `SECURITY_AUDIT_2026-07-13.md` (branch security/prod-audit-2026-07-13)
  for the current audit baseline.
