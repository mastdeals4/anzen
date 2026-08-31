# ANZEN ERP — TARGETED INVESTIGATION: STOCK TRUTH & MONEY TRUTH AUDIT

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff)  
**Audit Mode:** DISCOVERY / ARCHITECTURAL INVESTIGATION (Strictly Read-Only — Zero code/database mutations)  
**Audit Date:** September 1, 2026  
**Audited By:** Senior ERP Solution Architect, Senior Accounting Systems Architect, Inventory & Database Auditor  

---

## 1. Executive Summary

This targeted investigation establishes the authoritative data models, transaction lifecycles, and synchronization boundaries for **Inventory (Stock Truth)** and **Financial Transactions (Money Truth)** in Anzen ERP.

### Key Conclusions:
1. **Goods Dispatched Unbilled:** Because Anzen operates a rapid 24–48 hour turnaround between Delivery Challan dispatch and Sales Invoicing, creating an intermediate General Ledger accounting layer (`Goods Dispatched Unbilled`) introduces unnecessary double-journal overhead for a 2–3 person team. Instead, a strict **operational control view and dashboard alert (`APPROVED DC → NOT YET INVOICED`)** satisfies all audit, operational, and inventory tracking requirements.
2. **Stock Source of Truth:** `batches.current_stock` is the **authoritative operational truth** for physical batch quantity, while `inventory_transactions` serves as the **immutable transaction ledger**. `products.current_stock` is a **derived materialized summary** maintained by database trigger `trigger_update_product_stock`. Divergence risks exist primarily when raw batch records are imported or edited without firing triggers, but the system has stabilized around batch-level truth.
3. **Money Source of Truth:** 
   - **General Ledger (`journal_entries` + `journal_entry_lines`)** is the absolute monetary truth for financial statements.
   - **`voucher_allocations`** is the authoritative truth for AR/AP sub-ledger settlement.
   - **`bank_statement_lines` + `bank_statement_allocations`** is the authoritative truth for external bank reconciliation.
   - A critical dual-architecture legacy exists between *Voucher-based payments* (`payment_vouchers`) and *Direct expense bank linking* (`link_bank_statement_line`), which causes sub-ledger drift if direct expenses are unlinked without voucher synchronization.

---

## 2. Goods Dispatched Unbilled — Operational Control vs Accounting Layer

### 2.1 Business Context & Assessment
In high-volume manufacturing enterprises (SAP S/4HANA), goods dispatches often precede invoicing by weeks or months, necessitating an interim balance sheet accrual (`Dr Goods Dispatched Unbilled / Cr Inventory`) to prevent inventory ledger valuation discrepancies at month-end.

For Anzen ERP (a small 2–3 staff pharmaceutical raw-material trader):
- The warehouse dispatches goods with a physical Delivery Challan (Surat Jalan).
- The finance/admin staff generates the commercial Sales Invoice within **1 to 2 business days** (often on the same afternoon).
- Introducing an interim accounting journal creates 2 additional GL journal lines per delivery, increasing database complexity and potential reversing entry clutter with zero economic benefit during the normal monthly operating cycle.

### 2.2 Recommended Operational Architecture (No Accounting Bloat)
Instead of an accounting entry on DC approval, Anzen requires an **Operational Control & Invoicing Enforcement Engine**:

```
+---------------------------------------------------------------------------------------------------------------+
| OPERATIONAL CONTROL WORKFLOW: APPROVED DC -> SALES INVOICE                                                    |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Event / Document  | Physical Inventory    | General Ledger Impact             | Operational Alert State       |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| DC Approved       | `batches.current_stock`| None (No intermediate GL journal) | Status: "Pending Invoicing"   |
|                   | decremented           |                                   | Age counter: 0 days           |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Unbilled > 48 Hrs | Deducted              | None                              | Warning: Yellow Badge (Age >2d)|
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Month-End Unbilled| Deducted              | None                              | Alert: Red Badge (Month-End)  |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Sales Invoice     | Deducted              | `Dr AR (1120)` / `Dr COGS (5110)` | Clears "Pending Invoicing"    |
| Created           |                       | `Cr Sales (4110)` / `Cr Inv (1130)`| Status: "Invoiced"            |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
```

### 2.3 Proposed Operational View: `vw_approved_dc_pending_invoice`
To provide 100% operational transparency without accounting complexity, the following read-only view tracks unbilled deliveries:
```sql
CREATE OR REPLACE VIEW public.vw_approved_dc_pending_invoice AS
SELECT 
  dc.id AS delivery_challan_id,
  dc.challan_number,
  dc.delivery_date,
  dc.customer_id,
  c.company_name AS customer_name,
  dc.sales_order_id,
  so.order_number AS sales_order_number,
  (CURRENT_DATE - dc.delivery_date::date) AS unbilled_days,
  COUNT(dci.id) AS item_count,
  SUM(dci.quantity) AS total_quantity_dispatched,
  SUM(dci.quantity * COALESCE(soi.unit_price, b.cost_per_unit, 0)) AS estimated_unbilled_value
FROM delivery_challans dc
JOIN customers c ON c.id = dc.customer_id
LEFT JOIN sales_orders so ON so.id = dc.sales_order_id
JOIN delivery_challan_items dci ON dci.delivery_challan_id = dc.id
LEFT JOIN batches b ON b.id = dci.batch_id
LEFT JOIN sales_order_items soi ON soi.sales_order_id = so.id AND soi.product_id = dci.product_id
WHERE dc.status = 'approved' 
  AND dc.invoiced_status IN ('uninvoiced', 'partially_invoiced')
  AND NOT EXISTS (
    SELECT 1 FROM sales_invoices si WHERE si.delivery_challan_id = dc.id AND si.status != 'cancelled'
  )
GROUP BY dc.id, dc.challan_number, dc.delivery_date, dc.customer_id, c.company_name, dc.sales_order_id, so.order_number;
```

---

## 3. Stock Source of Truth Deep Investigation

### 3.1 Complete Stock Dependency & Data Flow Map

```
 +-------------------------------------------------------------------------------------------------------+
 | ANZEN ERP STOCK SOURCE OF TRUTH ARCHITECTURE                                                          |
 +-------------------------------------------------------------------------------------------------------+
 |                                                                                                       |
 |  [goods_receipt_notes] / [import_containers]                                                          |
 |           |                                                                                           |
 |           v                                                                                           |
 |  +-------------------------------------------------------------------+                                |
 |  | 1. IMMUTABLE MOVEMENT LEDGER: inventory_transactions              |                                |
 |  |    - Records: purchase, sale, delivery_challan, return, rejection |                                |
 |  |    - Fields:  quantity, stock_before, stock_after, batch_id       |                                |
 |  +---------------------------------+---------------------------------+                                |
 |                                    | (maintains / audits)                                             |
 |                                    v                                                                  |
 |  +-------------------------------------------------------------------+                                |
 |  | 2. AUTHORITATIVE PHYSICAL TRUTH: batches (product_batches)        |                                |
 |  |    - Primary operational unit for FEFO, Expiry, Costing, CoA      |                                |
 |  |    - Columns: current_stock (Physical), reserved_stock            |                                |
 |  +---------------------------------+---------------------------------+                                |
 |                                    |                                                                  |
 |           +------------------------+------------------------+                                         |
 |           | (Trigger: trigger_update_product_stock)          | (Computed on demand)                    |
 |           v                                                 v                                         |
 |  +----------------------------------+   +----------------------------------------------------------+  |
 |  | 3. DERIVED MATERIALIZED FIELD    |   | 4. DERIVED SUMMARY VIEW                                  |  |
 |  |    products.current_stock        |   |    product_stock_summary                                 |  |
 |  |    - Stored column on products   |   |    - Real-time aggregate view:                           |  |
 |  |    - Used by: Dashboard, Alerts  |   |      SELECT SUM(current_stock) FROM batches ...          |  |
 |  +----------------------------------+   +----------------------------------------------------------+  |
 |                                                                                                       |
 +-------------------------------------------------------------------------------------------------------+
```

### 3.2 Deep Answers to Questions A through G

#### A. Which value is authoritative?
**`batches.current_stock`** is the authoritative physical operational truth. Every pharmaceutical raw material in Anzen is tracked by specific manufacturer batch, expiry date, storage condition, and landed cost. `inventory_transactions` serves as the immutable audit ledger verifying how `batches.current_stock` reached its current state.

#### B. Which value is derived?
- **`products.current_stock`** is a derived materialized summary column on the `products` table, computed as $\sum \text{batches.current_stock}$ for all active batches where `is_active = true`.
- **`product_stock_summary`** is a derived SQL view computing $\text{COALESCE}(\text{SUM}(b.\text{current\_stock}), 0)$ dynamically on query.

#### C. Which value is actually mutated?
- **Directly Mutated:** `batches.current_stock` and `batches.reserved_stock` are directly mutated by core operational functions:
  - `approve_delivery_challan()` $\rightarrow$ decrements `batches.current_stock` and `batches.reserved_stock`.
  - `reserve_stock_for_sales_order()` $\rightarrow$ increments `batches.reserved_stock`.
  - `release_stock_reservation()` $\rightarrow$ decrements `batches.reserved_stock`.
  - `save_goods_receipt_note()` / Batch creation $\rightarrow$ inserts new `batches.current_stock`.
- **Indirectly Mutated:** `products.current_stock` is mutated solely via the trigger `trigger_update_product_stock` executing `update_product_current_stock()`.

#### D. Where can they diverge?
Divergence between `products.current_stock` and $\sum \text{batches.current_stock}$ occurs under 3 specific conditions:
1. **Bulk SQL Data Migrations / Imports:** Directly running `UPDATE batches SET current_stock = ...` using scripts that disable triggers or bypass PostgreSQL trigger execution.
2. **Inactive Batch State Changes:** If a batch is flagged `is_active = false` with non-zero stock, `update_product_current_stock()` excludes it ($\text{WHERE } is\_active = true$), causing `products.current_stock` to differ from raw database batch sums.
3. **Soft vs Hard Batch Deletions:** Deleting a batch row without firing `update_product_current_stock()`. (Resolved in migration `20260111164536` with `AFTER DELETE` trigger).

#### E. Can synchronization triggers fail or race?
- **Race Conditions:** PostgreSQL row-level locking during `UPDATE batches` serializes trigger execution. However, high-concurrency concurrent batch deductions on different batches of the same product both execute `UPDATE products SET current_stock = ...`. Because both triggers compute $\text{SUM}(\text{current\_stock})$, the final state is deterministic and correct.
- **Trigger Failure:** If the trigger fails, the entire transaction (e.g. Delivery Challan approval) rolls back atomically, preventing silent stock drift.

#### F. Do reports and UI screens use different sources?
**YES — Codebase Discrepancy Found:**
- `Dashboard.tsx` queries `products.current_stock` directly:
  ```typescript
  supabase.from('products').select('id, min_stock_level, current_stock').eq('is_active', true);
  ```
- `Stock.tsx` queries `product_stock_summary` view:
  ```typescript
  supabase.from('product_stock_summary').select('*');
  ```
- `DeliveryChallan.tsx` and `Batches.tsx` query `batches` directly:
  ```typescript
  supabase.from('batches').select('id, batch_number, current_stock, reserved_stock');
  ```
*Impact:* If `products.current_stock` ever drifts from `batches.current_stock`, the Dashboard low-stock card will disagree with the Stock overview page.

#### G. Does any business workflow rely specifically on either field?
- **FEFO Allocation & Delivery:** Strictly relies on `batches.current_stock` and `batches.reserved_stock`.
- **Low Stock Dashboard Notification:** Strictly relies on `products.current_stock` vs `products.min_stock_level`.

### 3.3 Target Stock Architecture Recommendation (DO NOT IMPLEMENT NOW)
1. **Retain `batches.current_stock` as Ground Truth:** All physical inventory validation, FEFO picking, and Delivery Challan deductions must continue targeting `batches`.
2. **Convert `products.current_stock` to a Read-Only Generated/View Pattern in Frontend:** Update `Dashboard.tsx` to read from `product_stock_summary` view instead of raw `products.current_stock`, eliminating any possibility of visual disagreement.
3. **Automated Weekly Stock Reconciliation RPC:** Retain `scripts/inventory-stock-reconciliation.mjs` as a scheduled read-only health check to verify $\sum \text{inventory\_transactions} = \text{batches.current\_stock}$.

---

## 4. Bank & Money Truth Deep Investigation

### 4.1 Complete Money Lifecycle Maps

#### Flow 1: Customer Receipt Lifecycle (Sales Invoicing $\rightarrow$ AR $\rightarrow$ Bank)

```
 [Sales Invoice: SI-26-001] (Total: IDR 111,000,000)
       |
       v
 [AR Sub-ledger Created] (Dr AR 1120: 111M / Cr Sales 4110: 100M / Cr PPN Out 2130: 11M)
       |
       v
 [Receipt Voucher Created] (RV-26-001: Amount = IDR 111,000,000)
       |
       +---> [voucher_allocations] (sales_invoice_id = SI-26-001, allocated_amount = 111M)
       |
       v
 [GL Journal Entry Posted] (Dr Bank Account 1111: 111M / Cr AR 1120: 111M)
       |
       v
 [Bank Statement Feed Imported] (bank_statement_lines: Credit = IDR 111,000,000)
       |
       v
 [Bank Reconciliation Link] (link_bank_statement_line -> matched_receipt_id = RV-26-001, matched_entry_id = JE)
```

#### Flow 2: Supplier Payment Lifecycle (Purchase Invoice $\rightarrow$ AP $\rightarrow$ Bank)

```
 [Purchase Invoice: PI-26-001] (Total: IDR 55,500,000)
       |
       v
 [AP Sub-ledger Created] (Dr Inventory 1130: 50M / Dr PPN In 1140: 5.5M / Cr AP 2110: 55.5M)
       |
       v
 [Payment Voucher Created] (PV-26-001: Amount = IDR 55,500,000)
       |
       +---> [voucher_allocations] (purchase_invoice_id = PI-26-001, allocated_amount = 55.5M)
       |
       v
 [GL Journal Entry Posted] (Dr AP 2110: 55.5M / Cr Bank Account 1111: 55.5M)
       |
       v
 [Bank Statement Feed Imported] (bank_statement_lines: Debit = IDR 55,500,000)
       |
       v
 [Bank Reconciliation Link] (link_bank_statement_line -> matched_payment_id = PV-26-001, matched_entry_id = JE)
```

#### Flow 3: Expense Payment Lifecycle (Expense Bill $\rightarrow$ PV / Direct $\rightarrow$ Bank)

```
 [Finance Expense: EXP-26-001] (Total: IDR 10,000,000)
       |
       v
 [Expense Journal Posted] (Dr Operational Exp 6xxx: 10M / Cr AP Expense 2115: 10M)
       |
       v
 [Payment Voucher or Direct Bank Match]
       |
       +---> Option A (Voucher): PV-26-002 -> Dr AP Expense 2115 / Cr Bank 1111
       |
       +---> Option B (Direct Match): link_bank_statement_line -> Dr AP Expense / Cr Bank
```

---

### 4.2 Comprehensive Money Scenario Matrix & Failure Mode Analysis

| # | Business Scenario | System Execution Path | Potential Divergence Point | Risk Severity | Classification |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **1** | **1 Invoice / 1 Payment** | Standard PV creation $\rightarrow$ single allocation in `voucher_allocations`. | None. Clean 1:1 match. | Low | Normal Flow |
| **2** | **1 Payment / Multiple Invoices** | Single PV with $N$ lines in `voucher_allocations`. PV posts 1 aggregate JE. | If 1 child invoice is deleted/edited after PV posting. | High | **ARCHITECTURAL WEAKNESS** |
| **3** | **Partial Payment** | PV allocation $<$ Invoice total. `paid_amount` updated, `balance_amount` remains positive. | Rounding precision on partial foreign currency payments. | Medium | **LIKELY RISK** |
| **4** | **Overpayment** | PV amount $>$ sum of allocations. | PV allows unallocated amount $\rightarrow$ leaves unallocated credit balance in AP. | Medium | **DESIGN DECISION** |
| **5** | **Unlink Bank Line** | `unmatch_bank_line()` invoked on matched statement line. | Resets `bank_statement_lines` match columns, but does not revert PV status. | High | **CONFIRMED BUG** |
| **6** | **Relink Bank Line** | `link_bank_statement_line()` re-invoked with different document. | If previous match left partial allocation in `bank_statement_allocations`. | High | **CONFIRMED BUG** |
| **7** | **Payment Cancellation** | PV cancelled / unposted. | Journal reversed, but child invoice `paid_amount` trigger must fire reliably. | Medium | **LIKELY RISK** |
| **8** | **Bank Transfer Fee** | Bank statement shows net receipt (e.g. IDR 99,993,500 after IDR 6,500 fee). | Auto-match fails because statement amount $\ne$ invoice amount (100M). | High | **CONFIRMED BUG** |
| **9** | **Split Bank Transaction** | 1 bank line covers 2 invoices from different customers. | `link_bank_statement_line` requires multiple calls to `bank_statement_allocations`. | Medium | **ARCHITECTURAL WEAKNESS** |
| **10**| **Duplicate Bank Statement Import**| User re-uploads the same CSV bank statement. | Hash check in `bank_statement_lines.transaction_hash` prevents duplicates. | Low | Prevented |
| **11**| **Same Amount on Multiple Dates** | Multiple monthly rent payments of IDR 15,000,000. | Auto-match matches wrong date if tolerance window is $\pm 3$ days. | Medium | **LIKELY RISK** |
| **12**| **Multi-Currency FX Variance** | USD invoice (USD 1,000 @ 15,500 = IDR 15.5M) paid when rate is 16,000 (IDR 16M). | Realized FX gain/loss must post to Account 7100 / 8100. | Medium | **DESIGN DECISION** |

---

### 4.3 Detailed Trace of Sub-Ledger vs General Ledger Divergence Points

#### Path A: Where `BANK STATEMENT ≠ BANK LEDGER ≠ BANK GL` Can Occur

```
 [BANK STATEMENT] (External Truth: Bank Statement Line)
        |
        x  <--- DIVERGENCE 1: Bank charges deducted at source (IDR 6,500 fee)
        |
 [BANK LEDGER] (Internal Operational Truth: Payment/Receipt Vouchers)
        |
        x  <--- DIVERGENCE 2: Voucher created in 'draft' status (not yet posted to GL)
        |
 [BANK GENERAL LEDGER] (Financial Statement Truth: Account 1111 / 1112 in journal_entries)
```

1. **Divergence 1 (Bank Charges / Net Inflows):** A customer transfers IDR 100,000,000, but the bank statement shows IDR 99,993,500 due to an automatic IDR 6,500 interbank fee. `bank_statement_lines` records 99,993,500, while the Receipt Voucher records 100,000,000. Unless an explicit Bank Charge allocation is created (`Dr Bank Charge 6510: 6,500 / Dr Bank 1111: 99,993,500 / Cr AR 1120: 100,000,000`), Bank Statement $\ne$ Bank GL.
2. **Divergence 2 (Draft / Unposted Vouchers):** Creating a Receipt Voucher updates the customer's operational balance in the UI if not filtered by `is_posted = true`. However, GL Account 1111 is only debited when `is_posted = true`.

---

#### Path B: Where `AR ≠ Receipt Allocations ≠ Customer Balance` Can Occur

```
 [SALES INVOICES (AR)] (sum of total_amount - paid_amount)
        |
        x  <--- DIVERGENCE 3: Direct Credit Note applied without voucher allocation record
        |
 [VOUCHER ALLOCATIONS] (sum of voucher_allocations for sales_invoice_id)
        |
        x  <--- DIVERGENCE 4: Unallocated Advance Payment sitting on customer account
        |
 [CUSTOMER STATEMENT BALANCE] (Customer Ledger View)
```

1. **Divergence 3 (Credit Note Application):** When a Credit Note (`credit_notes`) is approved against a Sales Invoice, it reduces the invoice `balance_amount`. However, credit notes do NOT create a row in `voucher_allocations`. An audit query comparing $\text{Invoice Total} - \sum \text{voucher\_allocations}$ will show a discrepancy equal to the Credit Note value.
2. **Divergence 4 (Customer Advance Payments):** A customer pays an advance of IDR 50,000,000 before a Sales Order is invoiced. The Receipt Voucher records `Dr Bank 1111 / Cr Customer Advance (2140)`. The customer's net balance is IDR -50,000,000, but `sales_invoices` AR balance is IDR 0 until the invoice is issued and the advance is settled via `advance_payment_allocations`.

---

#### Path C: Where `AP ≠ Payment Allocations ≠ Supplier Balance` Can Occur

```
 [PURCHASE INVOICES (AP)] (sum of total_amount - paid_amount)
        |
        x  <--- DIVERGENCE 5: Customs Broker combined bill (taxable fee vs non-taxable reimbursement)
        |
 [PAYMENT ALLOCATIONS] (sum of voucher_allocations for purchase_invoice_id / expense_id)
        |
        x  <--- DIVERGENCE 6: Direct bank line match unlinked without recalculating invoice state
        |
 [SUPPLIER STATEMENT BALANCE] (Supplier Ledger View)
```

1. **Divergence 5 (Customs Broker Hybrid Bills):** Broker bills combine non-taxable reimbursements (PIB, Duty) and taxable handling fees. If allocated via a single voucher, tax withholding (PPh 23) applies only to the service portion. A rounding discrepancy in line-item DPP calculation can leave a fractional Rupiah balance on the invoice AP record.
2. **Divergence 6 (Unlinking Direct Bank Matches):** When an expense or purchase bill was paid via `link_bank_statement_line()`, unlinking via `unmatch_bank_line()` clears `bank_statement_allocations` but historically failed to cascade back to reset `purchase_invoices.paid_amount` (Documented in BUG-02).

---

## 5. Specific Issue Evidence Register

### ISSUE-01: Bank Fee Mismatch in Smart Matching RPC
- **Classification:** **CONFIRMED BUG**
- **Affected File:** [`supabase/migrations/20260108111326_fix_smart_auto_match_date_tolerance.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20260108111326_fix_smart_auto_match_date_tolerance.sql)
- **Function:** `auto_match_bank_transactions()`
- **Reproduction:** Import a bank statement line with amount IDR 49,993,500. Expected Receipt Voucher is IDR 50,000,000 (with IDR 6,500 bank charge).
- **Current Result:** Auto-matching fails with 0% match confidence because match criteria strictly checks `ABS(bsl.amount - doc.amount) = 0`.
- **Expected Result:** Auto-match rule should support configurable bank fee tolerance (e.g. standard IDR 2,500 / IDR 6,500 BI-FAST fees) and suggest a split allocation.
- **Severity:** High

---

### ISSUE-02: Credit Note Reduction Bypasses Voucher Allocation Table
- **Classification:** **ARCHITECTURAL WEAKNESS**
- **Affected File:** [`supabase/migrations/20251212044625_prevent_deletion_and_add_credit_notes.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20251212044625_prevent_deletion_and_add_credit_notes.sql)
- **Table:** `public.credit_notes`, `public.voucher_allocations`
- **Reproduction:** Create a Credit Note of IDR 10,000,000 against Invoice SI-001. Query `voucher_allocations` for SI-001.
- **Current Result:** `voucher_allocations` has no record for the credit note; invoice balance is adjusted via direct update trigger on `sales_invoices.paid_amount`.
- **Expected Result:** Credit notes should be explicitly represented in a unified settlement view so that $\text{Invoice Balance} = \text{Total} - (\text{Voucher Payments} + \text{Credit Notes} + \text{Advance Settlements})$.
- **Severity:** Medium

---

### ISSUE-03: Dual Payment Path (Payment Voucher vs Direct Bank Linking)
- **Classification:** **ARCHITECTURAL WEAKNESS**
- **Affected File:** [`supabase/migrations/20260812156000_restore_bank_allocation_rpc_body.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20260812156000_restore_bank_allocation_rpc_body.sql)
- **Function:** `link_bank_statement_line()`
- **Current Result:** System allows paying an expense either via a Payment Voucher OR by directly linking a raw bank statement line to the expense in Bank Reconciliation.
- **Impact:** Two separate code paths mutate `paid_amount` on expenses, increasing trigger surface area and test complexity.
- **Expected Target Pattern:** Standardize all payments through Payment Vouchers (`payment_vouchers`). Bank Reconciliation should strictly match Bank Statement Lines to posted Vouchers.
- **Severity:** Medium

---

## 6. The Master Architect's Verdict

> **"If I were responsible for protecting Anzen's financial and inventory integrity, what would I make the single source of truth for stock, AR/AP, bank transactions, and the GL?"**

Here is the definitive architectural blueprint for Anzen ERP:

### 1. Physical Stock Source of Truth: `batches` (Backed by `inventory_transactions`)
- **Authoritative Table:** `public.batches` (Columns: `current_stock` for physical on-hand, `reserved_stock` for active SO locks).
- **Available Stock Formula:** $\text{Available Stock} = \text{batches.current\_stock} - \text{batches.reserved\_stock}$.
- **Immutable Audit Trail:** `public.inventory_transactions` must record every increment/decrement with before/after snapshots.
- **UI Aggregates:** The Stock Overview and Dashboard must read from **`product_stock_summary` view** (real-time `SUM(batches.current_stock)`), treating `products.current_stock` purely as a cached summary.

### 2. AR / AP Settlement Source of Truth: Unified Settlement Ledger
- **Authoritative Records:** `public.voucher_allocations` (for cash/bank voucher payments) combined with `public.advance_payment_allocations` (for customer/supplier advances) and `public.credit_notes`.
- **Canonical Invoice Balance Equation:**
  $$\text{Invoice Balance} = \text{Invoice Total} - \sum \text{Voucher Allocations} - \sum \text{Advance Allocations} - \sum \text{Credit Notes}$$
- Direct column writes to `sales_invoices.paid_amount` or `finance_expenses.paid_amount` must be prohibited; `paid_amount` must be computed strictly via deterministic trigger from the allocation tables.

### 3. Bank & Reconciliation Source of Truth: Tripartite Separation
- **External Real-World Truth:** `public.bank_statement_lines` (Immutable bank statement feed; amounts and dates cannot be edited).
- **Internal Operational Cash Truth:** `public.payment_vouchers` and `public.receipt_vouchers` (The company's operational records of money sent or received).
- **Reconciliation Bridge:** `public.bank_statement_allocations` (Explicit link bridging `bank_statement_line_id` $\leftrightarrow$ `journal_entry_id`).
- Standardize all bank disbursements through Payment Vouchers: Eliminate direct bank-to-expense linking so that every bank transaction reconciles to a posted General Ledger journal entry.

### 4. Financial & Reporting Truth: The General Ledger (`journal_entries`)
- **Absolute Financial Truth:** `public.journal_entries` and `public.journal_entry_lines`.
- **Integrity Rule:** Every financial report (Trial Balance, P&L, Balance Sheet, Tax Summary) must query `journal_entry_lines` joined to `chart_of_accounts`.
- **Hard Period Guard:** All posting RPCs must strictly enforce `accounting_periods.status != 'closed'`, guaranteeing that historical financial reports cannot be modified after month-end tax filing.

---
*End of Stock Truth & Money Truth Audit.*
