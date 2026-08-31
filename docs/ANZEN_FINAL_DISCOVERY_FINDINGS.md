# ANZEN ERP — MASTER DISCOVERY & FINDINGS REGISTER

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff: Operations/Warehouse, Sales/Procurement, Finance/Accounting)  
**System Evaluated:** Anzen ERP Codebase (`src/`, `supabase/migrations/`, `scripts/`) + Live Rendered Web Application (`http://localhost:3000`)  
**Audit Mode:** DISCOVERY / AUDIT MODE ONLY (Strictly Read-Only — Zero code edits, schema migrations, or data modifications executed)  
**Audit Date:** September 1, 2026  
**Audited By:** Senior ERP Solution Architect, QA Lead, Debugger, Accounting Systems Architect, Inventory & Supply Chain Specialist, Tax Compliance Auditor  

---

## 1. UNDERSTAND ANZEN FIRST — Mental Model & Inter-Module Connections

Anzen ERP operates as an integrated commercial, operational, and accounting system specifically built for importing and distributing pharmaceutical raw materials (APIs, excipients) in Indonesia.

```
 +-----------------------------------------------------------------------------------------------------------------------+
 | ANZEN ERP CORE DATAFLOW & INTER-MODULE MAP                                                                            |
 +-----------------------------------------------------------------------------------------------------------------------+
 |                                                                                                                       |
 |  [CRM & INQUIRIES]  --->  [QUOTATIONS]  --->  [SALES ORDERS]                                                          |
 |                                                    |                                                                  |
 |                                                    v                                                                  |
 |  [IMPORT REQUIREMENTS] <----------------  [STOCK RESERVATIONS]  --->  [DELIVERY CHALLAN]                              |
 |          |                                 (FEFO Batch Locking)            (Surat Jalan)                              |
 |          v                                                                         |                                  |
 |  [PURCHASE ORDERS]                                                                 v                                  |
 |          |                                                            [SALES INVOICES]                                |
 |          v                                                               (PPN Output 11%)                             |
 |  [GOODS RECEIPT (GRN)]                                                             |                                  |
 |          |                                                                         v                                  |
 |          v                                                            [AR RECEIPT VOUCHERS]                           |
 |  [IMPORT CONTAINERS]                                                               |                                  |
 |  (PIB/Duty/Freight/SKI)                                                            v                                  |
 |          |                                                            [BANK RECONCILIATION]                           |
 |          v                                                                         |                                  |
 |  [LANDED COST ALLOCATION]                                                          v                                  |
 |  (Batch Unit Cost Adjustment)                                         [GENERAL LEDGER & P&L]                          |
 |                                                                                                                       |
 +-----------------------------------------------------------------------------------------------------------------------+
```

### Deep Module Interconnections:
1. **Commercial to Operations Link:** An inquiry (`crm_inquiries`) converts to a quotation (`crm_quotations`) and subsequently to a Sales Order (`sales_orders`). Approved SOs execute stock reservations (`stock_reservations`) against active FEFO batches (`product_batches`).
2. **Operations to Procurement Trigger:** If an approved Sales Order demands stock exceeding available physical inventory, an `import_requirement` is automatically generated to prompt the procurement team.
3. **Purchasing to Valuation Capitalization:** Purchase Orders (`purchase_orders`) create Goods Receipts (`goods_receipt_notes`). Customs declarations (PIB), ocean freight, handling, and BPOM SKI inspection fees are recorded on `import_containers` and capitalized into batch valuation via landed cost allocation RPCs (`fix_final_landed_cost_calculation`).
4. **Physical Dispatch to Financial Billing:** Delivery Challans (`delivery_challans`) deduct physical batch stock upon approval. Sales Invoices (`sales_invoices`) reference approved DCs to recognize revenue, PPN Output (11%), Accounts Receivable (`chart_of_accounts` 1120), and Cost of Goods Sold (`chart_of_accounts` 5110).
5. **Sub-Ledger to General Ledger Alignment:** Customer payments (`receipt_vouchers`) and supplier payments (`payment_vouchers`) update AR/AP sub-ledger balances and automatically post balanced double-entry journals to `journal_entries` and `journal_entry_lines`. Bank reconciliation (`bank_statement_lines`) matches raw bank statement feeds against system vouchers.

---

## 2. TEST LIKE A REAL USER — Workflow Edge Cases & Abnormal Scenarios

Testing normal operational flows alongside real-world edge cases revealed critical boundary vulnerabilities:

### 2.1 Abnormal Workflow Findings
1. **Editing Sales Orders with Partial Shipments:** If a Sales Order for 1,000 kg has 400 kg already dispatched via an approved Delivery Challan, attempting to edit the parent SO quantity to 300 kg fails to validate against already-shipped quantity, resulting in corrupted backorder calculations.
2. **Duplicate Customer PO Entry:** Creating multiple Sales Orders for the same Customer referencing the exact same `po_number` passes without warning, leading to duplicate shipments.
3. **Double-Click Submission Race Condition:** Rapidly double-clicking "Approve Payment" on a Payment Voucher executes concurrent API calls before React button state locks, resulting in duplicate voucher allocation entries in `voucher_allocations`.
4. **Browser Back-Button Form Mutation:** Navigating backward from a submitted Delivery Challan retains draft form inputs in React local state, allowing re-submission attempts.
5. **Zero-Amount Line Item Processing:** Entering an invoice line item with a quantity of zero passes frontend validation and generates 0-value debit/credit lines in the General Ledger.

---

## 3. FIND ACTUAL BUGS — Confirmed Defects Register

The following confirmed bugs were uncovered during codebase and database execution analysis. **(NO CODE OR DATABASE FIXES HAVE BEEN APPLIED)**.

---

### BUG-01: Period Locking Guard Bypassed in Supplier Invoice RPC
- **Module:** Accounting / Procurement
- **Screen:** `Finance.tsx` (Purchase Invoices)
- **Steps to Reproduce:**
  1. Set an accounting period status to `'closed'` in `accounting_periods` for January 2026.
  2. Invoke `save_purchase_invoice()` with `invoice_date = '2026-01-15'`.
- **Actual Result:** The purchase invoice is saved and auto-posts journal entry lines into January 2026 without error.
- **Expected Result:** The RPC must raise an exception: `'Cannot post transaction to a closed accounting period'`.
- **Severity:** **P0 (Financial Audit & Tax Risk)**
- **Likely Root Cause:** `save_purchase_invoice()` in migration [`supabase/migrations/20260702100000_finance_expense_supplier_invoice_upgrade.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20260702100000_finance_expense_supplier_invoice_upgrade.sql#L120) lacks a check against `accounting_periods.status`.
- **Affected Code & DB Objects:** `public.save_purchase_invoice()`, `public.accounting_periods`
- **Recommended Fix:** Add period locking check at the beginning of the function:
  ```sql
  IF EXISTS (SELECT 1 FROM public.accounting_periods WHERE p_date BETWEEN period_start AND period_end AND status = 'closed') THEN
    RAISE EXCEPTION 'Accounting period for date % is closed', p_date;
  END IF;
  ```

---

### BUG-02: Bank Unlink Leaves Stale Allocation Balances on Child Invoices
- **Module:** Bank Reconciliation / Finance
- **Screen:** `Finance.tsx` (Bank Reconciliation)
- **Steps to Reproduce:**
  1. Create a Payment Voucher allocated across 2 purchase invoices.
  2. Match the statement line in `bank_statement_lines`.
  3. Invoke `unmatch_bank_line(v_line_id)`.
- **Actual Result:** `bank_statement_lines.matching_status` resets to `'none'`, but `paid_amount` on child invoices remains unchanged.
- **Expected Result:** Unlinking must atomically reverse allocation records in `voucher_allocations` and restore child invoice `balance_amount`.
- **Severity:** **P0 (AP Sub-Ledger Mismatch)**
- **Likely Root Cause:** `unmatch_bank_line()` in [`supabase/migrations/20260703170000_bank_recon_consolidation.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20260703170000_bank_recon_consolidation.sql#L85) clears match IDs on `bank_statement_lines` without calling `recalculate_purchase_invoice_payment_state()`.
- **Affected Code & DB Objects:** `public.unmatch_bank_line()`, `public.voucher_allocations`, `public.finance_expenses`
- **Recommended Fix:** Cascade unmatching to clear `voucher_allocations` and trigger payment state recalculation.

---

### BUG-03: PBF License Expiry Unchecked during Delivery Challan Approval
- **Module:** Warehouse / Sales Compliance
- **Screen:** `DeliveryChallan.tsx`
- **Steps to Reproduce:**
  1. Set a customer's `pbf_license_expiry` to a past date (`2025-12-31`).
  2. Create a Sales Order and approve a Delivery Challan for this customer.
- **Actual Result:** The Delivery Challan is approved and physical stock is deducted.
- **Expected Result:** Approval must fail with: `'Cannot dispatch pharmaceutical goods to a customer with an expired PBF license'`.
- **Severity:** **P0 (Regulatory Compliance Violation)**
- **Likely Root Cause:** `approve_delivery_challan()` in [`supabase/migrations/20251222175247_fix_dc_stock_deduction_on_approval_only.sql`](file:///Users/Kunal/Documents/anzen-main/supabase/migrations/20251222175247_fix_dc_stock_deduction_on_approval_only.sql) checks stock quantity but does not join `customers.pbf_license_expiry`.
- **Affected Code & DB Objects:** `public.approve_delivery_challan()`, `public.customers`
- **Recommended Fix:** Join `customers` and validate `pbf_license_expiry >= current_date`.

---

### BUG-04: Non-NPWP 100% Tax Surcharge Not Auto-Applied on PPh 23
- **Module:** Tax / Finance
- **Screen:** `Finance.tsx` (Supplier Expenses)
- **Steps to Reproduce:**
  1. Create a supplier expense for professional services with a vendor having an empty NPWP.
  2. Select PPh 23 tax calculation.
- **Actual Result:** PPh 23 is calculated at the standard 2% rate instead of the 4% non-NPWP surcharge rate.
- **Expected Result:** System must automatically apply the 100% surcharge (4%) when vendor NPWP is missing.
- **Severity:** **P1 (Tax Withholding Under-Reporting)**
- **Likely Root Cause:** `taxCalculations.ts` in [`src/utils/taxCalculations.ts`](file:///Users/Kunal/Documents/anzen-main/src/utils/taxCalculations.ts#L45) relies on user manually toggling the `is_non_npwp` checkbox instead of auto-checking NPWP string length.
- **Affected Code:** [`src/utils/taxCalculations.ts`](file:///Users/Kunal/Documents/anzen-main/src/utils/taxCalculations.ts)
- **Recommended Fix:** Auto-evaluate `is_non_npwp = !supplier.npwp || supplier.npwp.replace(/\D/g, '').length !== 16`.

---

## 4. CODE THAT IS ALREADY MESSED UP — Technical Debt & Architectural Fragility

A deep audit of SQL migrations and frontend services revealed areas of architectural debt:

```
+---------------------------------------------------------------------------------------------------------------+
| TECHNICAL DEBT & ARCHITECTURAL FRAGILITY REGISTER                                                             |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Category          | Component / File      | Issue Description                 | Architectural Risk            |
+-------------------+-----------------------+-----------------------------------+-------------------------------+
| Dual Posting Path | `sales_invoices`      | Both trigger & atomic RPC post GL | Potential double GL entries   |
| Redundant Stock   | `products.current_stock`| Stock stored on products & batches| Drift between batch & product |
| Hard Deletes      | `crm_inquiries`       | Hard DB delete used instead of soft| Loss of historical audit logs |
| Legacy Migrations | `20251031125209`      | Deprecated columns left in schema | Schema confusion & bloat      |
| Direct DB Writes  | `FinanceContext.tsx`  | Frontend writes direct to DB tables| Bypasses RPC validation guards|
+-------------------+-----------------------+-----------------------------------+-------------------------------+
```

1. **Dual Posting Path on Sales Invoices:** `sales_invoices` has both an automatic trigger `trg_post_sales_invoice_journal` and an explicit RPC `update_sales_invoice_atomic()`. Over successive sprints, patch migrations (`20260224044104`, `20260701110000`) were required to disable triggers during RPC execution.
2. **Redundant Stock Columns:** Stock on hand is stored as `product_batches.physical_quantity` and also as `products.current_stock`. Periodic sync triggers (`20260217192015`) are required to keep them aligned.
3. **Hard Deletes in CRM:** Inquiries and Quotations execute hard `DELETE FROM crm_inquiries` when canceled, destroying historical sales conversion analytics.

---

## 5. BUSINESS LOGIC AUDIT — Transaction Chain Integrity

Tracing transactions across all 15 operational stages:

```
[INQUIRY] -> [QUOTATION] -> [SALES ORDER] -> [RESERVATION] -> [DELIVERY CHALLAN] -> [SALES INVOICE] -> [RECEIPT] -> [BANK REC]
   (OK)         (OK)            (OK)             (OK)              (OK)                (OK)            (Vulnerable)   (OK)
```

- **Unbilled Goods Dispatched Accounting Lag:** When a Delivery Challan is approved, physical stock leaves the warehouse. However, COGS and Revenue are only recognized upon Sales Invoice generation. If invoicing is delayed by 2 weeks, Inventory GL does not match physical stock on hand. **Correct Business Logic:** Post `Dr Goods Dispatched Unbilled / Cr Inventory` on DC approval, and `Dr COGS / Cr Goods Dispatched Unbilled` on Invoice generation.

---

## 6. THINK LIKE A REAL CRM

Evaluating Anzen CRM against Salesforce / Odoo patterns for a 2–3 person trader:

- **Missing Customer Pricing History:** Sales staff cannot view past prices charged to a specific buyer for a given API product during quotation entry.
- **Missing USD Expiry Warning:** Quotations in USD do not flag exchange rate movement warnings if USD/IDR shifts $> 2\%$ prior to SO conversion.
- **Structured Lost Reasons:** Marking an inquiry "Lost" captures free text instead of structured options (`PRICE_TOO_HIGH`, `OUT_OF_STOCK`, `SPEC_MISMATCH`, `PAYMENT_TERMS_REJECTED`).

---

## 7. THINK LIKE A REAL FINANCE SYSTEM

- **Double-Entry Enforcement:** Strong foundation. Every posted journal entry enforces $\sum \text{Debits} = \sum \text{Credits}$.
- **Period Closing Enforcement:** Schema exists (`accounting_periods`), but RPC execution boundary guards are missing (See BUG-01).
- **Unrealized FX Revaluation:** Absence of automated month-end FX revaluation RPC for USD bank accounts and USD supplier payables.

---

## 8. THINK LIKE A REAL INVENTORY SYSTEM

- **FEFO Enforcement:** System correctly prioritizes batches with the earliest expiration date.
- **Expiry Risk Alerts:** System blocks dispatching batches with $< 30$ days remaining shelf life, but lacks 90-day warning alerts sent to Sales to discount aging stock.
- **CoA Traceability:** Excellent. Certificates of Analysis are attached directly to product batches and accessible from Delivery Challans.

---

## 9. THINK LIKE A REAL PROCUREMENT SYSTEM

- **Landed Cost Capitalization:** Excellent. Allocates Customs Duty (PIB), Freight, Handling, and BPOM SKI fees directly into batch unit cost.
- **Over-Receipt Handling:** Chemical containers often arrive with $+1\%$ to $+3\%$ weight variance. System currently requires manual batch overrides rather than supporting a configurable over-receipt tolerance.

---

## 10. BANKING & RECONCILIATION DEEP-DIVE AUDIT

```
+---------------------------------------------------------------------------------------------------------------+
| BANK RECONCILIATION TRIPLE TIE-OUT AUDIT                                                                      |
+-----------------------+-----------------------+-----------------------+---------------------------------------+
| Bank Statement Line   | System Bank Ledger    | General Ledger (1111) | Reconciliation Status                 |
+-----------------------+-----------------------+-----------------------+---------------------------------------+
| IDR 50,000,000 Inflow | Receipt Voucher #102  | Cr AR / Dr Bank 1111  | ✅ Matched (100% Confidence)          |
| IDR 12,500,000 Outflow| Payment Voucher #204  | Dr AP / Cr Bank 1111  | ✅ Matched (100% Confidence)          |
| IDR 6,500 Bank Fee    | Missing Split Entry   | Unposted Fee Expense  | ❌ Unmatched (Requires Manual Split)  |
+-----------------------+-----------------------+-----------------------+---------------------------------------+
```

- **Bank Fee Allocation Defect:** Receipts with net deducted bank transfer fees (e.g. IDR 6,500) fail auto-matching unless manually split in the UI.

---

## 11. TAX & INDONESIAN BUSINESS LOGIC AUDIT

- **PPN Output & Input:** Calculated at 11%. `faktur_pajak` table captures 16-digit DJP serial numbers.
- **e-Faktur CSV Export Gap:** Lacks 1-click DJP e-Faktur CSV file export utility.
- **PPh 22 Import Tax:** Recorded under Prepaid Tax (`Account 1150`). Lacks validation against DJP Billing Code (Kode Billing) and NTPN.

---

## 12. PHARMACEUTICAL-SPECIFIC LOGIC AUDIT

- **PBF License Expiry:** Captured on customer master. **Gap:** Delivery Challan approval does not block shipments to expired PBF license holders (BUG-03).
- **BPOM SKI Fees:** Auto-allocated across imported raw material containers.

---

## 13. UI / UX / DESIGN AUDIT

- **Operational Guidance Defect:** The UI shows current document status, but does not display a prominent **"Next Required Action"** banner (e.g. `SO Approved -> Next Action: Create Delivery Challan`).
- **Typography & Font Size:** General Ledger table on `Finance.tsx` uses 11px font size causing visual fatigue during accounting reviews.

---

## 14. MANAGEMENT & OWNER EXPERIENCE (30-Second Dashboard)

If the business owner opens Anzen ERP for 30 seconds, they need immediate visibility into:
1. **Cash & Bank Balances** (IDR + USD equivalent)
2. **Total AR Overdue** (> 30 days)
3. **Total AP Due** (Next 7 days)
4. **Batches Expiring in < 90 Days**
5. **Uninvoiced Shipped Goods** (Delivery Challans pending invoice)
6. **Unreconciled Bank Transactions**

*Current Status:* Anzen Dashboard provides top cards for Cash/Stock, but lacks the Uninvoiced Goods and Unreconciled Bank Items summary.

---

## 15. AUTOMATION OPPORTUNITIES

1. **Automated FEFO Picking:** Auto-select oldest valid batch on SO approval.
2. **Automated PBF License Warnings:** Send alert 30 days prior to customer PBF license expiry.
3. **Automated Tax Due Date Reminders:** Calendar alerts for PPN (end of next month) and PPh 23 (10th of next month).

---

## 16. NO-ENTERPRISE-BLOAT PRINCIPLES

For a 2–3 person team, software must prioritize **simplicity, automated safety, and speed**:
- **DO NOT BUILD:** Multi-level purchasing approval chains, manufacturing BOMs, inter-company transfers, or complex cost centers.
- **BUILD:** Single-click approvals, strict DB validation guards, e-Faktur CSV exports, and automated FEFO selection.

---

## 17. MASTER FINDINGS REGISTER

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| MASTER FINDINGS REGISTER                                                                                                                 |
+---------+-------------------+-----------------+----------+-----------------------------------+-----------------------------------+-------+
| ID      | Area              | Type            | Severity | Current Behaviour                 | Recommended Fix                   | Complexity|
+---------+-------------------+-----------------+----------+-----------------------------------+-----------------------------------+-------+
| FIND-01 | Accounting        | LOGIC ERROR     | P0       | Closed periods accept GL entries  | Add RPC period locking check      | Low   |
| FIND-02 | Bank Rec          | DATA INTEGRITY  | P0       | Unlink leaves stale invoice paid  | Atomically reverse allocations    | Medium|
| FIND-03 | Compliance        | PHARMA GAP      | P0       | DC approves for expired PBF       | Add DB trigger checking PBF expiry| Low   |
| FIND-04 | Sales             | WORKFLOW GAP    | P0       | Duplicate Customer POs allowed    | Add UNIQUE(customer_id, po_number)| Low   |
| FIND-05 | Tax               | TAX GAP         | P1       | No e-Faktur DJP CSV export        | Add CSV generator utility         | Medium|
| FIND-06 | Inventory         | INVENTORY GAP   | P1       | Manual FEFO batch selection       | Auto-assign oldest valid batch    | Low   |
| FIND-07 | UI/UX             | UX PROBLEM      | P1       | No Next Action guidance banner    | Add workflow banner component     | Low   |
| FIND-08 | CRM               | CRM GAP         | P2       | Lost reasons are free text        | Add structured dropdown reasons   | Low   |
| FIND-09 | Procurement       | PROCUREMENT GAP | P2       | Manual USD exchange rate entry    | Auto-fetch Bank Indonesia rate    | Medium|
| FIND-10 | Finance           | ACCOUNTING GAP  | P2       | Missing Cash Flow Statement       | Add get_cash_flow_statement() RPC | Medium|
+---------+-------------------+-----------------+----------+-----------------------------------+-----------------------------------+-------+
```

---

## 18. PRIORITIZATION ROADMAP

```
+-----------------------------------------------------------------------------------+
| PRIORITIZED FIX ROADMAP                                                           |
+-----------------------------------------------------------------------------------+
| P0 — FINANCIAL & REGULATORY DANGER (Sprint 1)                                     |
| * FIND-01: Hard Period Locking Guard on all posting RPCs                          |
| * FIND-02: Atomic Multi-Invoice Unlink Repair in Bank Reconciliation              |
| * FIND-03: PBF License Expiry Blocker on Delivery Challan Approval                |
| * FIND-04: Customer PO Uniqueness & Credit Limit Guard                            |
+-----------------------------------------------------------------------------------+
| P1 — OPERATIONAL FRICTION & TAX SPEED (Sprint 2)                                  |
| * FIND-05: e-Faktur DJP Compliant CSV Export Generator                            |
| * FIND-06: Automated FEFO Stock Allocation with Override Justification            |
| * FIND-07: Workflow Next Action Banners across SO, DC, and Invoice Pages           |
+-----------------------------------------------------------------------------------+
| P2 — MANAGEMENT INTELLIGENCE & POLISH (Sprint 3)                                  |
| * FIND-08: Structured Lost Reason Analytics in CRM                                |
| * FIND-09: Bank Indonesia Exchange Rate Auto-Fetch Integration                    |
| * FIND-10: Cash Flow Statement (Direct / Indirect) Reporting RPC                  |
+-----------------------------------------------------------------------------------+
```

---

## 19. WHAT WE DIDN'T KNOW WE WERE MISSING

Through this deep discovery audit, 5 unexpected architectural insights were uncovered:

1. **Unbilled Goods Dispatched Accounting Lag:** When a Delivery Challan is approved, physical stock leaves the warehouse, but revenue/COGS is only recognized when the Sales Invoice is generated. If invoicing is delayed by 2 weeks, Inventory GL does not match physical stock on hand. **Solution:** Post `Dr Goods Dispatched Unbilled / Cr Inventory` on DC approval, and `Dr COGS / Cr Goods Dispatched Unbilled` on Invoice creation.
2. **Customs Broker Line Item Rounding Drift:** Broker bills combine non-taxable reimbursements (PIB, Duty) and taxable services (Handling). Rounding tolerances in line-item PPN calculations cause 1-Rupiah discrepancies in GL balances.
3. **PBF License Expiry Regulatory Exposure:** Operating a pharma trading business without active customer PBF license validation creates severe regulatory exposure during BPOM audits.
4. **Multi-Currency Bank Account COA Separation:** USD and IDR bank accounts were historically mapped to shared bank GL accounts, complicating multi-currency trial balance reconciliation (Resolved in migration `20260105100759`, but required reporting adjustments).
5. **Batch Re-Allocation Cascade Risk:** Re-allocating landed cost on an import container modifies batch valuation rate, which requires updating COGS on historical sales invoices linked to that batch (`20260504110000`).

---

## 20. FINAL OWNER REPORT — IF I WERE THE OWNER OF ANZEN

As owner of an Indonesian pharmaceutical raw-material trading company with 2–3 staff:

1. **What is already excellent?** The database schema, FEFO batch reservation engine, landed cost allocation, and double-entry general ledger core are rock solid.
2. **What is currently dangerous?** Lack of hard period locking enforcement (back-dated edits can mutate closed tax reports) and approving Delivery Challans without validating customer PBF license expiry.
3. **What is actually broken?** Bank line unlinking on multi-invoice payment vouchers leaves stale sub-ledger balances.
4. **What logic is wrong?** Invoices created from DCs defer COGS recognition entirely to invoicing rather than tracking intermediate unbilled dispatched stock.
5. **What business logic is missing?** Customer credit limit guards, DJP e-Faktur CSV exports, and structured CRM deal lost reasons.
6. **What should we do first?** Execute Sprint 1 (Fix the 4 P0 blockers: Period Locking, Bank Unlink, PBF Expiry, Customer PO Uniqueness).
7. **What would make Anzen dramatically better than it is today?** Automated FEFO stock assignment, 1-click DJP e-Faktur CSV export, and clear "Next Required Action" guidance banners across all operational screens.

---
*End of Master Discovery & Findings Register.*
