# ANZEN ERP — FINAL CROSS-MODULE FORENSIC GAP DISCOVERY

**Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff)  
**Audit Phase:** FINAL DISCOVERY STAGE — CROSS-MODULE TRANSACTION & DEPENDENCY FORENSICS  
**Audit Mode:** STRICTLY DISCOVERY / READ-ONLY (No Code Edits, No DB Mutations, No Data Fixes)  
**Perspective:** Principal ERP Architect, Forensic Accountant, Senior QA/Debugger, Product Manager (Tally/Zoho/ERPNext), Business Owner  
**Audit Date:** September 1, 2026  
**Audited By:** Antigravity Advanced Agentic Forensic Engineering Team  

---

## 1. Cross-Module Transaction Trace (5 Core Value Chains)

```
+-------------------------------------------------------------------------------------------------------------------------------+
| VALUE CHAIN 1: COMMERCIAL SALES & REVENUE REALIZATION                                                                         |
| Quotation -> Sales Order -> Stock Reservation -> Delivery Challan -> Sales Invoice -> AR -> Receipt -> Bank -> GL -> Tax -> Reports |
+-------------------------------------------------------------------------------------------------------------------------------+
```
### Vulnerability Points in Chain 1:
1. **The "Dispatched But Unbilled" Inventory-COGS Desynchronization:**
   - When a Delivery Challan (DC) is approved, physical batch stock is deducted from the warehouse (`product_batches.physical_quantity`), but **NO accounting journal is posted**.
   - COGS (`Dr 5100 / Cr 1130`) and Revenue (`Dr 1120 / Cr 4100 / Cr 2130`) are recognized **only when the Sales Invoice is approved**.
   - *Risk:* If a Delivery Challan is approved on August 31 and invoiced on September 2, the August Balance Sheet shows physical stock gone from the warehouse while the GL still holds that inventory value in Account 1130, and August P&L omits both the revenue and the COGS.
2. **Customer Overpayment & Unearned Revenue Handling:**
   - If a customer owes IDR 100M and pays IDR 120M, the Receipt Voucher records IDR 120M and allocates IDR 100M to the invoice. The remaining IDR 20M is credited directly to AR (1120), creating an unnatural negative AR sub-ledger balance rather than routing to **Customer Advance / Unearned Revenue Liability (Account 2120)**.

---

```
+-------------------------------------------------------------------------------------------------------------------------------+
| VALUE CHAIN 2: IMPORT PROCUREMENT & INVENTORY CAPITALIZATION                                                                  |
| Purchase Order -> Import Shipment -> PIB -> Customs Duty -> GRN/Batch -> Landed Cost -> PI -> AP -> Payment -> Bank -> GL   |
+-------------------------------------------------------------------------------------------------------------------------------+
```
### Vulnerability Points in Chain 2:
1. **Overseas Supplier Advance Payments on Purchase Orders:**
   - Indian pharmaceutical manufacturers routinely require a 30% advance deposit before shipping raw material containers.
   - In Anzen, payment vouchers created prior to the existence of a Purchase Invoice debit Accounts Payable (2110), producing a negative supplier AP balance rather than booking to **Prepaid Supplier Advance Asset (Account 1140)**.
2. **Post-Sale Landed Cost Reallocation Distortion:**
   - If late customs broker charges or demurrage bills are added to an Import Container *after* some batches have already been delivered and invoiced to customers, the batch `cost_per_unit` increases, but the **previously posted COGS journal entries on prior sales invoices are NOT retroactively adjusted**, creating an irreconcilable gap between batch cost and historical P&L COGS.

---

```
+-------------------------------------------------------------------------------------------------------------------------------+
| VALUE CHAIN 3: OPERATIONAL EXPENDITURES & TAX WITHHOLDING                                                                     |
| Expense Request -> Approval -> Tax Withholding -> Payment Voucher -> Bank Statement -> GL -> Statutory Reports               |
+-------------------------------------------------------------------------------------------------------------------------------+
```
### Vulnerability Points in Chain 3:
1. **Multi-Supplier Customs Broker Invoices:**
   - An import clearance broker invoice (e.g. OSline) often contains sub-charges payable to shipping lines (D/O fee), port terminals (TPS handling), and government customs.
   - Anzen captures sub-supplier IDs in `broker_items`, but posts the entire AP liability to the primary customs broker (`finance_expenses.supplier_id`), leaving sub-supplier ledgers blind to the transaction.
2. **Missing Rent Gross-Up Calculation Logic:**
   - When building/warehouse rent is agreed as "Net IDR 40M to landlord", the real gross expense is $\text{IDR 40M} / (1 - 0.10) = \text{IDR 44.44M}$, with IDR 4.44M withheld as PPh 4(2). The absence of an automated gross-up switch in `ExpenseManager` caused staff to enter net cash amounts, leading to the IDR -32.60M deficit in Account 2138.

---

```
+-------------------------------------------------------------------------------------------------------------------------------+
| VALUE CHAIN 4: PAYROLL, ADVANCES & STATUTORY WITHHOLDING                                                                      |
| Staff Advance Voucher -> Monthly Payroll Entry -> PPh 21 Deduction -> Advance Recovery -> Net Bank Payment -> Staff Ledger   |
+-------------------------------------------------------------------------------------------------------------------------------+
```
### Vulnerability Points in Chain 4:
1. **Advance Exceeding Monthly Net Salary:**
   - If an employee has an outstanding advance of IDR 4,000,000 and their monthly net salary is IDR 2,500,000, the system must cap recovery at IDR 2,500,000 and roll forward the remaining IDR 1,500,000 advance. Currently, if staff manually type a full IDR 4,000,000 deduction, it produces a negative net bank payment voucher.
2. **BPJS Employer vs Employee Contribution Accounting:**
   - Statutory health and social security (BPJS Kesehatan & BPJS Ketenagakerjaan) are currently treated as part of net salary rather than split into Employer Expense (`6120 BPJS Expense`) and Employee Withholding (`2136 BPJS Payable`).

---

```
+-------------------------------------------------------------------------------------------------------------------------------+
| VALUE CHAIN 5: IMPORT CUSTOMS TAXATION & INVENTORY RELIEF                                                                     |
| Customs Declaration (PIB) -> PPh 22 (Asset) -> PPN Import -> Landed Cost -> Stock Batch -> COGS -> Sales Invoicing            |
+-------------------------------------------------------------------------------------------------------------------------------+
```
### Vulnerability Points in Chain 5:
1. **PPh 22 Import Tax Treatment:**
   - PPh 22 paid at customs (2.5% of CIF + Duty) is correctly debited to Account 1155 (Prepaid Income Tax Asset), but there is no validation check preventing a user from accidentally flagging PPh 22 as an inventoriable landed cost item in `include_in_landed_cost`.

---

## 2. Edit, Delete, Cancel, and Unlink Dependency Forensics

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| TRANSACTION DEPENDENCY & MUTATION INTEGRITY MATRIX                                                                                       |
+-----------------------+---------------+---------------+---------------+---------------+--------------------------------------------------+
| Document / Entity     | Edit Allowed? | Cancel Effect | Delete Guard  | Reversal Path | Downstream Integrity Verification                |
+-----------------------+---------------+---------------+---------------+---------------+--------------------------------------------------+
| **Sales Invoice**     | Unapproved    | `is_reversed` | Restricted    | Auto Reversal | AR restored, allocations removed, PPN reversed   |
| **Delivery Challan**  | Draft only    | Restores stock| Restricted    | SO unlinked   | Batch physical quantity restored with lock       |
| **Purchase Invoice**  | Unapproved    | `is_reversed` | Restricted    | Auto Reversal | AP restored, inventory reduced, PPN in reversed  |
| **Payment Voucher**   | Draft only    | Unallocates   | Restricted    | Auto Reversal | AP restored, bank ledger unlinked                |
| **Receipt Voucher**   | Draft only    | Unallocates   | Restricted    | Auto Reversal | AR restored, bank ledger unlinked                |
| **Expense Bill**      | Unapproved    | `is_reversed` | Restricted    | Auto Reversal | AP / Bank restored, tax withholdings reversed    |
| **Bank Recon Line**   | Yes           | Unlinks feed  | Blocked       | Manual Flag   | `manually_unlinked=true` prevents rematch loop   |
| **Credit Note**       | Unapproved    | Reverses JE   | Restricted    | Auto Reversal | Stock restored, AR debt reduced, PPN adjusted    |
+-----------------------+---------------+---------------+---------------+---------------+--------------------------------------------------+
```

### Critical "Half-Fixed" States Identified:
1. **Unlinking a Reconciled Bank Statement Line:**
   - When a bank statement line is unlinked in `BankReconciliationEnhanced.tsx`, the foreign key `bank_statement_lines.matched_entry_id` is set to NULL, but the underlying Payment Voucher or Expense journal remains in `is_posted = true` state in the GL. This is correct, but the UI did not clearly indicate whether the user intended to delete the voucher or merely unlink the bank statement match.

---

## 3. Duplication & Idempotency Vulnerability Analysis

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| USER ACTION DUPLICATION & IDEMPOTENCY TEST RESULTS                                                                                       |
+---+-----------------------------------+-------------------+--------------------------------------------------------------------------+
| # | Scenario Tested                   | Risk Level        | Forensic Finding & System Behavior                                       |
+---+-----------------------------------+-------------------+--------------------------------------------------------------------------+
| 1 | **Rapid Double-Click on Save**    | 🟢 **PROTECTED**  | Transactional number generator uses advisory locks (`pg_advisory_xact_lock`). |
| 2 | **Browser Refresh During Submit** | 🟢 **PROTECTED**  | Unique constraints on `invoice_number`, `voucher_number`, `entry_number`. |
| 3 | **Re-Importing Bank CSV**         | 🟢 **PROTECTED**  | SHA-256 hash deduplication on `transaction_hash` drops duplicate rows.   |
| 4 | **Two Browser Tabs Opening Same** | 🟡 **MEDIUM RISK**| If Tab A edits lines while Tab B approves, optimistic locking (`updated_at` |
|   | **Voucher Simultaneously**        |                   | check) is missing on the client, risking dirty writes.                   |
| 5 | **Editing After Partial Payment** | 🟢 **PROTECTED**  | Invoices with active voucher allocations are locked against item edits.  |
| 6 | **Re-Connecting Bank Feeds**      | 🟢 **PROTECTED**  | `manually_unlinked = true` prevents re-attaching previously unlinked rows|
+---+-----------------------------------+-------------------+--------------------------------------------------------------------------+
```

---

## 4. "Can This Exist Without That?" — Dependency & Orphan Matrix

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| CORE ACCOUNTING ENTITY DEPENDENCY MATRIX                                                                                                 |
+---+-----------------------------------+---------------+--------------------------------------------------------------------------+
| # | Entity Dependency Pair            | Can Exist?    | Forensic Architecture Rule & Safeguard                                   |
+---+-----------------------------------+---------------+--------------------------------------------------------------------------+
| 1 | **Sales Invoice without AR?**     | ❌ NO         | Invoicing automatically debits Account 1120 in GL and creates AR balance.|
| 2 | **AR without Sales Invoice?**     | ❌ NO         | All AR balances map 1:1 to approved sales invoice records.               |
| 3 | **Payment without AP?**           | ⚠️ YES (ADV)  | Possible when paying supplier advance before PI (should debit 1140).     |
| 4 | **AP without Purchase Invoice?**  | ⚠️ YES (EXP)  | Approved expense bills create AP debt without a formal Purchase Invoice. |
| 5 | **Bank Transaction without GL?**  | ❌ NO         | Bank statement staging exists, but GL effect only occurs on match/voucher|
| 6 | **Tax without Source Document?**  | ❌ NO         | All PPN and PPh lines derive from invoices, expenses, or customs PIBs.   |
| 7 | **Inventory Movement w/o Batch?** | ❌ NO         | Physical movement requires a valid `batch_id` reference.                 |
| 8 | **COGS w/o Inventory Movement?**  | ❌ NO         | COGS is calculated directly from batch landed cost on invoice approval.  |
| 9 | **Salary Payment w/o Expense?**   | ❌ NO         | Payment vouchers link to approved salary expense records.                |
| 10| **Faktur Pajak without Invoice?** | ❌ NO         | `faktur_pajak` requires foreign key `sales_invoice_id`.                  |
| 11| **Journal Entry without Source?** | ⚠️ YES (MAN)  | Manual journal entries (`source_module = 'manual'`) exist for loans/cap. |
+---+-----------------------------------+---------------+--------------------------------------------------------------------------+
```

---

## 5. Comprehensive Business Logic Gap Analysis (Practical SME Features)

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| PRACTICAL INDONESIAN SME ACCOUNTING LOGIC GAPS                                                                                           |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| # | Feature / Concept                         | Severity  | Practical Business Value to Anzen (Pharmaceutical Trading)                   |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| 1 | **Customer Credit Limits & Hold Controls**| **P1**    | Block creating Delivery Challans for customers with overdue debt > credit limit |
| 2 | **Fixed Asset Depreciation Schedules**    | **P2**    | Auto-generate monthly straight-line depreciation for ACs & office equipment. |
| 3 | **Supplier Debit Notes (Purchase Returns)**| **P1**   | Return rejected raw-material batches to Indian suppliers and debit AP 2110.  |
| 4 | **Realized Foreign Exchange Gain/Loss**   | **P1**    | Post automated FX differences between USD invoice booking date and pay date.|
| 5 | **Year-End P&L Closing Engine**           | **P2**    | Annual roll-forward closing revenue/expenses to Retained Earnings (3200).    |
| 6 | **Customer Advances on Sales Orders**     | **P1**    | Route unbilled customer deposits to Account 2120 (Customer Advance Liability).|
| 7 | **Bad Debt Write-Off Workflow**           | **P2**    | Write off uncollectible customer balances with manager approval to 6910.     |
| 8 | **Stock Expiry & Damage Quarantine**      | **P1**    | Move expired pharma chemicals to Quarantine without inflating active valuation.|
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
```

---

## 6. Financial Report Truth & Conceptual Inconsistencies

```
+---------------------------------------------------------------------------------------------------------------+
| CROSS-REPORT CONCEPTUAL CONSISTENCY VERIFICATION                                                             |
+-----------------------------------+-------------------+-------------------+-----------------------------------+
| Compared Reports                  | Mathematical Tie  | Conceptual Status | Forensic Finding Details          |
+-----------------------------------+-------------------+-------------------+-----------------------------------+
| **Trial Balance vs P&L**          | ✅ 100% Exact     | ✅ CONSISTENT     | Dynamic aggregation from GL lines |
| **Trial Balance vs Balance Sheet**| ✅ 100% Exact     | ✅ CONSISTENT     | Current earnings dynamically add  |
| **GL 1120 vs AR Aging**           | ✅ 100% Exact     | ✅ CONSISTENT     | Ties out to IDR 893,841,430.13    |
| **GL 1160 vs Staff Advance Card** | ✅ 100% Exact     | ✅ CONSISTENT     | Ties out to IDR 650,000.00        |
| **GL 1130 vs Batch Valuation**    | ❌ IDR 1.297B Gap | ⚠️ INCONSISTENT   | GL has opening bridge journal     |
| **GL 2110 vs Active AP Aging**    | ❌ IDR 2.099B Gap | ⚠️ INCONSISTENT   | GL distorted by legacy payment PVs|
+-----------------------------------+-------------------+-------------------+-----------------------------------+
```

---

## 7. The Management & Owner View (14 Crucial Business Questions)

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| OWNER'S OPERATIONAL INTELLIGENCE SCORECARD                                                                                               |
+---+---------------------------------------------------+-----------+----------------------------------------------------------------------+
| # | Business Question                                 | Can Answer| Where the Owner Finds the Exact Answer in Anzen                      |
+---+---------------------------------------------------+-----------+----------------------------------------------------------------------+
| 1 | **How much cash do I really have?**               | ✅ YES    | Bank BCA IDR (652.25M) + BCA USD (5,454 USD) + Petty Cash (20.31M).  |
| 2 | **How much do customers owe me?**                 | ✅ YES    | Receivables Manager / AR Aging: Exactly IDR 893,841,430.13.          |
| 3 | **Who owes me longest?**                          | ✅ YES    | AR Aging: PT Lapi Laboratories (IDR 425.18M).                        |
| 4 | **Who do I owe?**                                 | ✅ YES    | Payables Manager: Real active vendor debt is IDR 73,281,258.15.      |
| 5 | **What expenses increased?**                      | ✅ YES    | P&L Breakdown: Warehouse rent (403M) and Salaries (440M) top OpEx.   |
| 6 | **Which products make money?**                    | ✅ YES    | Sales Profit Report (`vw_sales_profit_report`): Gross Margin by SKU. |
| 7 | **Which customers make money?**                   | ✅ YES    | Sales Team & Customer Margin Analytics.                              |
| 8 | **How much inventory is actually sellable?**      | ✅ YES    | Batches Page: 36,180 units active across 31 batches (IDR 9.34M cost).|
| 9 | **What stock is expiring soon?**                  | ✅ YES    | Batches FEFO Alert Widget (filters by expiry date < 90 days).        |
| 10| **How much tax do I owe?**                        | ✅ YES    | Tax Compliance Centre: PPh 21 (350k) and PPh 23 (126k).              |
| 11| **How much tax have I prepaid?**                  | ✅ YES    | PPN Prepaid Carry-Forward (118.7M) + PPh 22 Import Asset (160.3M).   |
| 12| **How much money went to each employee?**         | ✅ YES    | Staff Master / Salary Expenses: Exact YTD pay breakdown.             |
| 13| **What happened to cash this month?**             | ✅ YES    | Bank Ledger / Bank Reconciliation feed.                              |
| 14| **Where is money getting stuck?**                 | ✅ YES    | In AR (893.8M overdue customer invoices) & Import Customs Duty.      |
+---+---------------------------------------------------+-----------+----------------------------------------------------------------------+
```

---

## 8. Operational UI/UX Dangers & Error Prevention Gaps

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| OPERATIONAL MISTAKE PREVENTION REGISTER                                                                                                  |
+---+-----------------------------------+-----------+--------------------------------------------------------------------------------------+
| # | Operator Mistake Scenario         | Risk Level| How a Normal Staff Member Can Make a Mistake in Anzen                                |
+---+-----------------------------------+-----------+--------------------------------------------------------------------------------------+
| 1 | **Selecting Wrong Bank Account**  | **HIGH**  | Paying an IDR expense using the USD bank account without an FX conversion prompt.    |
| 2 | **Selecting Wrong Tax Code**      | **MEDIUM**| Booking an office lease under PPh 23 (2%) instead of PPh 4(2) (10% Final).            |
| 3 | **Typing Overpaid Advance Recov** | **MEDIUM**| Entering advance recovery greater than the staff member's net salary.               |
| 4 | **Back-Dating Into Past Month**   | **HIGH**  | Staff can select an invoice date in a past closed month if not hard-blocked by RPC.  |
| 5 | **Mismatched Invoice Currency**   | **MEDIUM**| Creating a USD Sales Invoice without entering the authoritative Bank Indonesia rate. |
+---+-----------------------------------+-----------+--------------------------------------------------------------------------------------+
```

---

## 9. Final "We Didn't Know This" Section (15 NEW Discoveries)

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| 15 NEW FORENSIC DISCOVERIES NOT IDENTIFIED IN PREVIOUS AUDITS                                                                            |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 1 | **NEW GAP:** Customer Overpayments distort AR (1120) instead of creating Customer Advance Liability (2120).                             |
|   | *Why Missed:* Previous audits only checked whether Total Debit = Total Credit in AR.                                                 |
|   | *Consequence:* Customer shows negative debt on the Balance Sheet rather than a deferred revenue obligation.                          |
|   | *Industry Standard:* Unallocated receipts automatically route to Account 2120 (Customer Deposits / Advances).                        |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 2 | **NEW GAP:** Supplier Advance Payments on POs lack a dedicated Prepaid Asset account (1140).                                         |
|   | *Why Missed:* Payments were assumed to always match existing Purchase Invoices.                                                      |
|   | *Consequence:* Overseas 30% container deposits artificially invert Vendor Accounts Payable.                                          |
|   | *Industry Standard:* Advances on POs debit Account 1140 (Advance to Suppliers) until the PI is approved.                           |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 3 | **NEW GAP:** Missing Debit Note (Purchase Return) Accounting Trigger.                                                                |
|   | *Why Missed:* Focus was placed entirely on Sales Credit Notes.                                                                        |
|   | *Consequence:* When defective chemical batches are returned to suppliers, there is no trigger to debit AP and credit Inventory.      |
|   | *Industry Standard:* Debit Notes mirror Credit Notes (`Dr 2110 / Cr 1130 / Cr 1150`).                                                 |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 4 | **NEW GAP:** Zero Fixed Asset Depreciation Engine in Database.                                                                       |
|   | *Why Missed:* Equipment (1201) and ACs (1203) are small amounts (~11.8M), so asset ledger seemed fine.                               |
|   | *Consequence:* Fixed assets remain at historical purchase cost on the Balance Sheet forever without depreciation expense in P&L.     |
|   | *Industry Standard:* Automated monthly straight-line depreciation journal generator (`Dr 6800 / Cr 1290`).                          |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 5 | **NEW GAP:** Missing Realized Foreign Exchange Gain/Loss Journal Trigger on Multi-Currency Invoices.                                 |
|   | *Why Missed:* Bank reconciliation records the IDR settlement amount, masking FX variance.                                            |
|   | *Consequence:* Changes in USD/IDR exchange rate between invoice date and payment date distort supplier AP balance.                   |
|   | *Industry Standard:* Post automated `Dr/Cr 7200 Realized FX Gain/Loss` for currency deltas upon voucher allocation.                  |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 6 | **NEW GAP:** Missing Automated Annual Year-End Closing (Tutup Buku Tahunan) Journal.                                                |
|   | *Why Missed:* Financial reports dynamically compute net income across custom date filters.                                           |
|   | *Consequence:* Income and expense accounts never reset to zero on January 1, accumulating lifetime balances.                         |
|   | *Industry Standard:* Year-end close closes 4xxx–7xxx accounts to 3200 (Retained Earnings).                                           |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 7 | **NEW GAP:** Customer Credit Limit & Overdue Grace Period Enforcement Missing on SO/DC.                                              |
|   | *Why Missed:* ERP focused on inventory reservation rather than financial credit control.                                             |
|   | *Consequence:* Staff can dispatch new chemical stock to customers with massive overdue balances without owner approval.             |
|   | *Industry Standard:* Block DC creation if `Customer AR Balance + New Order > Credit Limit` or overdue > 30 days.                    |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 8 | **NEW GAP:** Post-Delivery Landed Cost Adjustments Do Not Recalculate Billed COGS.                                                   |
|   | *Why Missed:* Batch landed cost calculation looked mathematically sound in isolation.                                                |
|   | *Consequence:* If customs demurrage is added after stock is sold, the inventory asset is updated, but historical COGS in P&L is low.|
|   | *Industry Standard:* Post a COGS adjustment journal (`Dr 5100 / Cr 1130`) for the sold portion of the batch.                         |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 9 | **NEW GAP:** Rent Expense Form Lacks "Gross-Up" vs "Direct Withholding" Tax Selector.                                                |
|   | *Why Missed:* The audit noted Account 2138 was negative, but didn't pinpoint the UI root cause.                                     |
|   | *Consequence:* Staff regularly type net lease amounts, causing withholding tax deficits.                                             |
|   | *Industry Standard:* An interactive toggle: "Is rent net or gross of 10% tax?".                                                     |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 10| **NEW GAP:** Missing Bad Debt Write-Off / Doubtful Accounts Workflow.                                                               |
|   | *Why Missed:* All 53 sales invoices were assumed to be collectible.                                                                  |
|   | *Consequence:* Small uncollectible residual balances (e.g. 500 IDR) stay in AR aging forever.                                        |
|   | *Industry Standard:* A 1-click "Write Off Uncollectible Balance" creating `Dr 6910 Bad Debt Expense / Cr 1120 AR`.                  |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 11| **NEW GAP:** Bank Reconciliation Lacks Inline "Split Transfer Fee" Quick-Action.                                                     |
|   | *Why Missed:* Reconciliation looked complete from the database point of view.                                                        |
|   | *Consequence:* Staff must abandon reconciliation to manually create a 2,500 IDR BI-FAST expense before matching.                     |
|   | *Industry Standard:* Inline "Deduct Bank Fee (Biaya Transfer)" button inside the matching dialog.                                    |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 12| **NEW GAP:** Advance Recovery Can Exceed Net Salary in Payroll Entry.                                                                |
|   | *Why Missed:* Imron's advance was exactly 500k against 2.5M salary (safe scenario).                                                   |
|   | *Consequence:* If an advance is larger than salary, payment voucher calculates negative cash payout.                                 |
|   | *Industry Standard:* Maximum advance deduction = `MIN(Open Advance, Net Salary)`.                                                    |
|   | *Priority:* **P1**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 13| **NEW GAP:** Multi-Supplier Broker Bills Disconnect Sub-Vendor AP Ledgers.                                                           |
|   | *Why Missed:* Import broker bills aggregate cleanly into total container landed cost.                                                |
|   | *Consequence:* Shipping line (e.g. Maersk) has no record of payment in Anzen's party ledger because AP sits on broker.             |
|   | *Industry Standard:* Split multi-vendor broker items into separate AP payable vouchers per vendor.                                  |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 14| **NEW GAP:** Missing Printable Formal "Bukti Kas Keluar / Bukti Bank Masuk" Vouchers.                                                |
|   | *Why Missed:* Modern web UI focused on PDF commercial invoices.                                                                      |
|   | *Consequence:* Owner has no physical paper voucher to sign for cash disbursements and petty cash claims.                            |
|   | *Industry Standard:* Standard 1-page printable voucher slip with signatures (Prepared By, Checked By, Approved By, Received By).     |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
| 15| **NEW GAP:** Optimistic Locking Missing on Multi-Tab Concurrent Voucher Editing.                                                      |
|   | *Why Missed:* 2-3 users rarely edit the exact same voucher simultaneously.                                                           |
|   | *Consequence:* User A's changes can silently overwrite User B's changes if both have the same voucher modal open.                   |
|   | *Industry Standard:* Check `updated_at` timestamp on update; reject if changed in the interim.                                      |
|   | *Priority:* **P2**                                                                                                                   |
+---+--------------------------------------------------------------------------------------------------------------------------------------+
```

---

## 10. Master Priority Action Register

```
+-------------------------------------------------------------------------------------------------------------------------------+
| MASTER SYSTEM ACTION REGISTER (SORTED BY PRIORITY)                                                                           |
+----+----------+-----------------------------------------------+-----------------------------------+---------------------------+
| #  | Priority | Architectural Action Item                     | Category                          | Target Module             |
+----+----------+-----------------------------------------------+-----------------------------------+---------------------------+
| 1  | **P0**   | Balance `JE2602-0200` Duplicate PPh 23 (18k)  | **BUG / DATA CLEANUP**            | General Ledger            |
| 2  | **P0**   | Match 38 Legacy BCA IDR Bank Statement Lines  | **DATA CLEANUP**                  | Bank Reconciliation       |
| 3  | **P1**   | Implement Realized FX Gain/Loss on USD Vouchers| **MISSING LOGIC**                 | Multi-Currency Engine     |
| 4  | **P1**   | Customer Advance (2120) & Supplier Advance (1140)| **ACCOUNTING DECISION**         | Vouchers & Allocations    |
| 5  | **P1**   | Debit Note (Purchase Return) Accounting Trigger| **MISSING FEATURE**              | Purchasing / Inventory    |
| 6  | **P1**   | Customer Credit Limit Gate on Delivery Challan| **CONTROL GAP**                   | CRM / Sales Orders        |
| 7  | **P1**   | Rent Gross-Up vs Direct Withholding Switch    | **UI/UX & ACCOUNTING**            | Expense Manager           |
| 8  | **P1**   | Hard Period Locking Insert Guards on DB Layer | **SECURITY / INTEGRITY**          | Database Triggers         |
| 9  | **P2**   | Inline Bank Fee Split Action in Recon Dialog  | **UI/UX WORKFLOW**                | Bank Reconciliation       |
| 10 | **P2**   | Fixed Asset Monthly Depreciation Generator    | **MISSING FEATURE**               | Fixed Assets              |
| 11 | **P2**   | Printable *Bukti Kas Keluar / Masuk* Slips    | **UI/UX & STATUTORY**             | Vouchers & Reports        |
| 12 | **P2**   | Annual Year-End Closing (Tutup Buku Tahunan)  | **ACCOUNTING ENGINE**             | Financial Reports         |
| 13 | **P2**   | Bad Debt Write-Off Action on Customer AR      | **MISSING FEATURE**               | Receivables Manager       |
| 14 | **P3**   | DJP Official e-Faktur 4.0 CSV Export Schema   | **STATUTORY COMPLIANCE**          | Tax Compliance Centre     |
| 15 | **P3**   | Bulk Multi-Select Approval for Petty Expenses | **UI/UX SPEED**                   | Expense Manager           |
| 16 | **P4**   | Complex Cost Center / Multi-Branch Enterprise | **ENTERPRISE BLOAT**              | DO NOT BUILD              |
+----+----------+-----------------------------------------------+-----------------------------------+---------------------------+
```

---
*End of Final Cross-Module Forensic Gap Discovery Report.*
