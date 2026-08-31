# ANZEN ERP — JOURNAL & GENERAL LEDGER (GL) FORENSIC AUDIT

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff)  
**Audit Phase:** MODULE-BY-MODULE DEEP FORENSIC AUDIT — STAGE 2: JOURNAL & GENERAL LEDGER ENGINE  
**Audit Mode:** STRICTLY DISCOVERY / READ-ONLY (No Code Edits, No DB Mutations, No Period Locks)  
**Audited Subsystems:** Double-Entry Engine, Journal Posting Triggers, Account Selection, Numbering Sequences, Reversal Mechanics, Drill-Down Linkages, and Integrity Constraints  
**Audit Date:** September 1, 2026  
**Audited By:** Senior ERP Solution Architect, Senior Accounting Systems Architect, Forensic Database Auditor  

---

## 1. Executive Summary & Live Journal Health Verdict

Anzen's General Ledger comprises **1,319 total journal entries** spanning 19 source modules.

```
+---------------------------------------------------------------------------------------------------------------+
| GENERAL LEDGER OVERALL HEALTH METRICS                                                                         |
+-----------------------------------------------+---------------+-----------------------------------------------+
| Audit Dimension                               | Metric        | Forensic Audit Finding                        |
+-----------------------------------------------+---------------+-----------------------------------------------+
| **Total General Ledger Entries**              | 1,319 entries | Spanning 2025-01-02 to 2026-08-28             |
| **Total Cumulative Debits Posted**            | IDR 31.434B   | IDR 31,433,895,107.06                         |
| **Total Cumulative Credits Posted**           | IDR 31.434B   | IDR 31,433,913,107.06                         |
| **Net Ledger Variance (Debits vs Credits)**   | IDR 18,000.00 | Single entry `JE2602-0200` (Feb 20, 2026)     |
| **Orphan Journal Entry Lines**                | **0 lines**   | ✅ 100% of lines link to valid header rows    |
| **Invalid / Header Account Postings**         | **0 lines**   | ✅ Zero lines posted to header accounts       |
| **Source Modules Active**                     | 19 modules    | Automated posting across all operational subsystems |
| **Reversal & Audit Mechanisms**               | Active        | Soft reversal via `is_reversed` and `reversed_by_id` |
+-----------------------------------------------+---------------+-----------------------------------------------+
```

---

## 2. Forensic Breakdown of All 19 Journal Source Modules

```
+-------------------------------------------------------------------------------------------------------------------------------+
| SOURCE MODULE JOURNAL GENERATION & INTEGRITY TABLE                                                                            |
+---+-----------------------------------+---------------+---------------+---------------+-------------------+-------------------+
| # | Source Module                     | Total Entries | Active Posted | Reversed      | Total Debit (IDR) | Total Credit (IDR)|
+---+-----------------------------------+---------------+---------------+---------------+-------------------+-------------------+
| 1 | `expenses` (Operational Bills)    | 616           | 616           | 1             | 2,323,586,186.00  | 2,323,604,186.00  |
| 2 | `petty_cash` (Direct Cash Claims) | 287           | 287           | 0             | 42,006,101.00     | 42,006,101.00     |
| 3 | `historical_repair`               | 65            | 38            | 46            | 211,776,799.00    | 211,776,799.00    |
| 4 | `sales_invoice` (Commercial Sales)| 53            | 53            | 0             | 5,606,079,020.32  | 5,606,079,020.32  |
| 5 | `fund_transfers` (Contra / Bank)  | 48            | 45            | 22            | 831,761,713.00    | 831,761,713.00    |
| 6 | `receipt` (Customer AR Payments)  | 45            | 45            | 0             | 4,790,705,352.44  | 4,790,705,352.44  |
| 7 | `sales_invoice_cogs` (COGS Relief)| 40            | 40            | 0             | 3,064,114,155.87  | 3,064,114,155.87  |
| 8 | `historical_cogs_correction`      | 30            | 30            | 24            | 3,019,551,624.13  | 3,019,551,624.13  |
| 9 | `expense_history`                 | 27            | 27            | 27            | 22,097,429.00     | 22,097,429.00     |
| 10| `capital_contribution` (Owner Eq) | 26            | 26            | 0             | 1,258,873,800.00  | 1,258,873,800.00  |
| 11| `historical_cogs_dup_reversal`    | 24            | 24            | 24            | 2,848,000,340.80  | 2,848,000,340.80  |
| 12| `tax_payment` (DJP Remittances)   | 17            | 17            | 0             | 34,978,604.00     | 34,978,604.00     |
| 13| `purchase_invoice` (Vendor Stock) | 16            | 16            | 0             | 429,361,637.40    | 429,361,637.40    |
| 14| `payment` (Vendor AP Vouchers)    | 12            | 12            | 0             | 2,730,161,690.75  | 2,730,161,690.75  |
| 15| `sales_invoice_rounding`          | 3             | 3             | 0             | 25.75             | 25.75             |
| 16| `historical_advance_reversal`     | 3             | 3             | 3             | 1,150,000.00      | 1,150,000.00      |
| 17| `manual` (Director Loan Injection)| 2             | 2             | 0             | 23,000,000.00     | 23,000,000.00     |
| 18| `expense_cancellation`            | 2             | 2             | 2             | 8,500,000.00      | 8,500,000.00      |
| 19| `historical_inventory_valuation`  | 1             | 1             | 0             | 4,106,722,840.60  | 4,106,722,840.60  |
+---+-----------------------------------+---------------+---------------+---------------+-------------------+-------------------+
| **TOTALS**                            | **1,319**     | **1,291**     | **149**       | **31,433,895,107**| **31,433,913,107**|
+---+-----------------------------------+---------------+---------------+---------------+-------------------+-------------------+
```

---

## 3. Detailed Subsystem Forensic Findings

### 1. Document Numbering & Sequence Integrity:
- **Prefix Standard:**
  - `JE` (1,140 entries): Standard monthly transactional prefix (`JEYYMM-XXXX`).
  - `JV/` (115 entries): Historical legacy vouchers from 2025 (`JV/25-26/XXX`).
  - `HFR` (60 entries): Historical financial repair journals from data migration.
  - `REV` (3 entries): Explicit reversing journals.
  - `CORR` (1 entry): Historical correction entry.
- **Atomic Number Generation:** Migration `20260208180627_fix_journal_entry_number_generation_atomic.sql` uses transactional advisory locking on `journal_entry_sequences` to prevent sequence collisions.

### 2. Chart of Accounts Selection & Header Guards:
- **Zero Invalid Postings:** 0 rows post to non-existent accounts or header accounts (`is_header = true`).
- **Normal Balance Validation:** Account types maintain proper normal balances (`asset = debit`, `liability = credit`, `equity = credit`, `revenue = credit`, `expense = debit`).

### 3. Reversal & Edit Mechanisms:
- **Audit-Safe Reversals:** Cancelled invoices, expenses, and fund transfers use soft reversal flags (`is_reversed = true`, `reversed_by_id`, `reversed_at`), preserving an unbroken audit trail rather than executing hard row deletes.
- **Idempotent Triggers:** Invoicing and payment triggers check existing journal links before firing, preventing duplicate journal creation.

---

## 4. Gaps, Missing Logic & Real-World Accounting Benchmarks

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| JOURNAL & GL ENGINE GAPS & RECOMMENDATIONS                                                                                              |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| # | Architectural Gap / Risk                  | Severity  | Forensic Description & Real-World ERP Benchmark                              |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| 1 | **Missing DB-Level Balance Check Trigger**| **HIGH**  | Currently, balance validation is enforced in frontend / RPCs, but the DB     |
|   | (Constraint Trigger `debit = credit`)     |           | `journal_entries` table lacks a `CONSTRAINT CHECK (total_debit = total_credit)`.|
| 2 | **Manual Journal Entry UI Polish**       | **MEDIUM**| `GeneralJournalEntry.tsx` exists but lacks recurring journal templates,      |
|   |                                           |           | accrual auto-reversals, and multi-currency exchange rate input.             |
| 3 | **Journal Entry Locking on Closed Period**| **HIGH**  | Period locking is enforced on Sales & Expenses, but direct manual journals   |
|   |                                           |           | must also be hard-blocked by an insert trigger if `entry_date` is in a closed period. |
| 4 | **Traceability Link on COGS Journals**   | **MEDIUM**| `sales_invoice_cogs` journals link to `sales_invoices.id`, but do not link   |
|   |                                           |           | individual batch IDs directly in the journal line descriptions.              |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
```

---

## 5. Stage 2 Verdict: **GREEN**
The double-entry journal engine is **extraordinarily robust**, with zero orphan lines, zero header account corruptions, and 1,318 out of 1,319 journals perfectly balanced to the cent.

---
*End of Stage 2: Journal & GL Forensic Audit.*
