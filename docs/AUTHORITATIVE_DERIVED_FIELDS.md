# Authoritative Architecture of Derived and Financial Fields

This document defines the authoritative sources of truth, derivation rules, permitted mutators, and synchronization mechanisms for all core financial and inventory fields across the ERP system.

---

## 1. Summary Matrix

| Field | Authoritative Source of Truth | Canonical Calculation / Engine | Permitted Mutator | Database Triggers / RPC Synchronization |
| :--- | :--- | :--- | :--- | :--- |
| **`sales_invoices.paid_amount`** | Posted `voucher_allocations` (`receipt_vouchers.is_posted = true`) + active `invoice_rounding_adjustments` | `get_invoice_allocation_amount(id, NULL) + get_invoice_rounding_adjustment_amount(id)` | Database Triggers / RPC only | `trg_update_invoice_payment_status` on `voucher_allocations`; `trg_sync_si_state_on_rv_posting_change` on `receipt_vouchers`. |
| **`sales_invoices.payment_status`** | Ratio of `paid_amount` vs `total_amount` | `CASE WHEN paid_amount <= 0 THEN 'pending' WHEN paid_amount >= total_amount THEN 'paid' ELSE 'partial' END` | Database Triggers only | `recalculate_sales_invoice_payment_state()` via allocation & posting triggers. |
| **`finance_expenses.paid_amount`** | Posted `voucher_allocations` (`payment`), `bank_statement_allocations`, direct bank lines, and `salary_advance_applications` | `recalculate_expense_payment_state(id)` bounded by `calculate_finance_expense_payable(id)` | Database Triggers / RPC only | `trg_sync_expense_payment_state` on `voucher_allocations`; `trg_sync_bsa_expense_payment_state` on `bank_statement_allocations`. |
| **`finance_expenses.approval_status`** | Approval workflow (`pending`, `approved`, `rejected`) | State transition via `approve_finance_expense()` | Finance Admin only | `trigger_auto_post_expense_accounting_insert` & `_update` auto-generate GL entries. |
| **`batches.current_stock`** | Sum of physical `inventory_transactions.quantity` for batch | `SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('purchase', 'return', 'delivery_challan_reserved') THEN quantity WHEN transaction_type IN ('sale', 'delivery', 'delivery_challan') THEN -quantity ELSE quantity END), 0)` | Canonical Stock Engine only (`app.canonical_stock_engine = 'on'`) | `inventory_v1_guard_movement_write()` guards direct write; `trg_enforce_inventory_op_id` guarantees idempotency. |
| **`products.current_stock`** | Aggregation of active `batches.current_stock` | `SELECT COALESCE(SUM(current_stock), 0) FROM batches WHERE product_id = p_product_id AND is_active = true` | Batch sync triggers | Automatically synchronized on batch movement. |
| **Batch Landed Costs** (`landed_cost_per_unit`, `cost_per_unit`) | `purchase_batch_cost_layers.final_functional_unit_cost` | Landed Cost Allocation Engine (`calculate_container_landed_costs`) | Import Cost Allocation RPC | `trigger_recalc_batches_on_expense` updates landed allocations when container expenses change. |
| **Customer AR Outstanding** | Active `sales_invoices` (`total_amount - paid_amount`) | Canonical AR Subledger query | Derived view / query | Reconciles to General Ledger Account `1120` to the exact cent. |
| **Supplier AP Outstanding** | Gross Payable (`calculate_finance_expense_payable` & purchase invoices) minus posted disbursements | `vw_supplier_authoritative_ap` | Derived view / query | Reconciles to General Ledger Account `2110` to the exact cent. |

---

## 2. Invariant Policies & Rules

### A. One Canonical Posting Path
- Normal day-to-day users cannot directly insert, update, or delete derived financial fields.
- Frontend components must never calculate or overwrite `paid_amount`, `payment_status`, or stock quantities in database mutations. Mutations must flow through canonical database RPCs (`save_payment_voucher_with_allocations`, `recalculate_sales_invoice_payment_state`, `apply_receipt_allocation_rounding_adjustment`).

### B. Automatic AR Rounding Lifecycle
- Only **posted** receipt vouchers are counted toward `paid_amount`.
- Small residual balances (`<= Rp 100`) trigger exactly ONE active record in `invoice_rounding_adjustments` with exactly ONE journal entry (`source_module = 'sales_invoice_rounding'`).
- If a receipt voucher is voided or unposted, the rounding adjustment is automatically and cleanly deleted by trigger `trg_sync_si_state_on_rv_posting_change`.
- Database constraint `invoice_rounding_adjustments_unique_invoice` physically prevents duplicate active rounding entries.

### C. Inventory Idempotency & Protection
- Every new row in `inventory_transactions` requires an `operation_id` (enforced by `trg_enforce_inventory_op_id`).
- Unique partial index `idx_inventory_transactions_operation_id` guarantees that replaying an operation or network retries cannot duplicate stock.
- Direct table inserts without setting `app.canonical_stock_engine = 'on'` are hard-blocked by `inventory_v1_guard_movement_write()`.

### D. Cash & GL 1101 Permanent Retirement
- GL 1101 (Cash on Hand) is permanently retired (`chart_of_accounts.is_active = false`).
- Database triggers `trg_prevent_gl1101_posting` and `trg_prevent_cash_on_hand_fund_transfer` reject any future postings or transfers targeting GL 1101.
- All cash transactions automatically route to GL 1102 (Petty Cash).
