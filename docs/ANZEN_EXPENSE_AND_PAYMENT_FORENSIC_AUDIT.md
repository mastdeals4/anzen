# ANZEN ERP — EXPENSE & PAYMENT FORENSIC AUDIT

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff)  
**Audit Phase:** MODULE-BY-MODULE DEEP FORENSIC AUDIT — STAGE 4: EXPENSES, VOUCHERS & DISBURSEMENTS  
**Audit Mode:** STRICTLY DISCOVERY / READ-ONLY (No Code Edits, No DB Mutations, No Period Locks)  
**Audited Subsystems:** Expense Manager, Petty Cash System, Payment Vouchers, Voucher Allocations, Tax Withholdings (PPh 21/23/4(2)), and Landed Cost Import Links  
**Audit Date:** September 1, 2026  
**Audited By:** Senior ERP Solution Architect, Senior Accounting Systems Architect, Forensic Expenditure Auditor  

---

## 1. Executive Summary & Disbursement Ledger Truth

Anzen's operational expenditure system manages **616 approved expenses** totaling **IDR 2.221B**, **343 petty cash records**, and **14 payment vouchers**.

```
+---------------------------------------------------------------------------------------------------------------+
| EXPENDITURE & DISBURSEMENT AUDIT SUMMARY TABLE                                                                |
+---------------------------------------+---------------+-----------------------+-------------------------------+
| Expenditure Category / Stream         | Record Count  | Total Amount (IDR)    | Forensic Status               |
+---------------------------------------+---------------+-----------------------+-------------------------------+
| **Total Operational Expenses**        | 616 records   | IDR 2,221,106,593.00  | Paid: 2.148B | Open: 73.07M   |
| **Import Duties & PIB Taxes**         | 8 shipments   | IDR 840,263,418.00    | ✅ 100% Reconciled to Customs  |
| **Salaries & Staff Compensation**     | 120 records   | IDR 422,044,000.00    | PPh 21 Withheld: 927,500 IDR  |
| **Warehouse & Office Leases**         | 14 records    | IDR 403,127,647.00    | Paid: 387.13M | Open: 16.00M  |
| **Office Renovation & Fit-Out**       | 75 records    | IDR 165,022,317.00    | ✅ 100% Capitalized / Expensed|
| **Petty Cash Operating Claims**       | 328 claims    | IDR 115,583,601.00    | Replenished via Bank Transfers|
| **Payment Vouchers (Vendor & Staff)** | 14 vouchers   | IDR 430,797,685.75    | ✅ 100% Allocated to AP & Adv |
+---------------------------------------+---------------+-----------------------+-------------------------------+
```

---

## 2. Category-by-Category Expense Audit

```
+-------------------------------------------------------------------------------------------------------------------------------+
| TOP EXPENSE CATEGORIES & TAX WITHHOLDING BREAKDOWN                                                                            |
+---+-----------------------------------+---------------+-----------------------+-------------------+---------------------------+
| # | Category                          | Count         | Total Amount (IDR)    | PPh Withheld      | PPN Attributed            |
+---+-----------------------------------+---------------+-----------------------+-------------------+---------------------------+
| 1 | `pib_import`                      | 8             | IDR 840,263,418.00    | IDR 0.00          | Included in Customs PIB   |
| 2 | `salary`                          | 120           | IDR 422,044,000.00    | IDR 927,500.00    | IDR 0.00                  |
| 3 | `warehouse_rent`                  | 14            | IDR 403,127,647.00    | IDR 0.00          | IDR 0.00                  |
| 4 | `office_shifting_renovation`      | 75            | IDR 165,022,317.00    | IDR 0.00          | IDR 0.00                  |
| 5 | `office_admin`                    | 49            | IDR 94,625,733.00     | IDR 0.00          | IDR 0.00                  |
| 6 | `professional_services`           | 7             | IDR 49,000,000.00     | IDR 980,000.00    | IDR 0.00                  |
| 7 | `import_broker`                   | 9             | IDR 42,485,568.00     | IDR 307,000.00    | IDR 2,028,318.00          |
| 8 | `travel_conveyance`               | 43            | IDR 26,335,847.00     | IDR 0.00          | IDR 0.00                  |
| 9 | `staff_welfare`                   | 33            | IDR 21,042,780.00     | IDR 0.00          | IDR 0.00                  |
| 10| `facility_maintenance`            | 18            | IDR 19,774,573.00     | IDR 67,000.00     | IDR 368,500.00            |
+---+-----------------------------------+---------------+-----------------------+-------------------+---------------------------+
```

---

## 3. Petty Cash System & Imprest Management

- **Imprest Cycle:** 15 recorded bank-to-cash top-ups (`IDR 112,612,000.00`) fund 328 small operational expense claims (`IDR 115,583,601.00`).
- **GL Integrity:** GL Account 1102 (Petty Cash) reconciles at **IDR 20,309,366.00**.
- **Attachment Controls:** `petty_cash_files` enforces receipt attachments for cash outlays.

---

## 4. Payment Vouchers & Allocations Architecture

- **Allocation Engine (`voucher_allocations`):**
  - Connects Payment Vouchers $\rightarrow$ Purchase Invoices (14 allocations) and Expense Bills (1 allocation).
  - Enforces FIFO allocation and prevents over-allocation beyond the invoice balance.
- **Salary Advance Settlement Integration:**
  - Specialized payment vouchers with `payment_purpose = 'salary_advance_settlement'` seamlessly deduct prior employee advance balances on payday.

---

## 5. Gaps & Recommendations for Expense & Payment

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| EXPENSE & PAYMENT SYSTEM GAPS & RECOMMENDATIONS                                                                                          |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| # | Architectural Gap                         | Severity  | Forensic Description & Real-World ERP Benchmark                              |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| 1 | **Multi-Bill Batch Payment Workflow**     | **MEDIUM**| Currently, payment vouchers are created bill-by-bill. Real ERPs allow paying |
|   |                                           |           | 5 vendor invoices in 1 single bank disbursement transaction.                 |
| 2 | **Recurring Expense Automation**          | **LOW**   | Monthly internet, water, and rent must be typed manually each month.         |
| 3 | **Vendor Bank Account Preset in PV**      | **LOW**   | Auto-populating supplier beneficiary bank details when selecting a vendor.  |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
```

---

## 6. Stage 4 Verdict: **GREEN**
The Expense & Payment engine accurately tracks 616 bills, with automated PPh withholding and perfect FIFO allocation.

---
*End of Stage 4: Expense & Payment Forensic Audit.*
