# ANZEN ERP — PAYROLL & STAFF LEDGER FORENSIC AUDIT

**Target Enterprise Profile:** Small Indonesian Pharmaceutical Raw-Material Trading Company (2–3 Staff)  
**Audit Phase:** MODULE-BY-MODULE DEEP FORENSIC AUDIT — STAGE 6: PAYROLL, ADVANCES & STAFF LEDGERS  
**Audit Mode:** STRICTLY DISCOVERY / READ-ONLY (No Code Edits, No DB Mutations, No Period Locks)  
**Audited Subsystems:** Staff Master, Monthly Payroll Calculations, PPh 21 Deductions, Salary Advance Recovery (FIFO), and GL Account 1160 Tie-Out  
**Audit Date:** September 1, 2026  
**Audited By:** Senior ERP Solution Architect, Senior Payroll Accounting Architect, Forensic Auditor  

---

## 1. Executive Summary & Staff Ledger Truth

Anzen's payroll and staff ledger engine manages **8 active employees**, **120 salary records** totaling **IDR 422,044,000.00**, and **IDR 1,150,000.00** in staff advances.

```
+---------------------------------------------------------------------------------------------------------------+
| STAFF MASTER & ADVANCE RECONCILIATION SUMMARY (GL ACCOUNT 1160)                                               |
+-----------------------+-------------------+---------------+-------------------+---------------+---------------+
| Employee Name         | Department        | Base Salary   | Advances Issued   | Recovered     | Open Advance  |
+-----------------------+-------------------+---------------+-------------------+---------------+---------------+
| Muhamad Imron Hanifah | Driver            | IDR 2,500,000 | IDR 500,000.00    | IDR 500,000.00| **IDR 0.00**  |
| Sandi Prasetyo        | Office Boy        | IDR 2,500,000 | IDR 650,000.00    | IDR 0.00      | **IDR 650K**  |
| Nia Delisma Nasution  | Pharmacist (Apot.)| IDR 8,120,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
| Nuraenun Jariah       | Pharmacist (Apot.)| IDR 7,000,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
| Chintia Benazir W.    | Kepala Gudang     | IDR 3,800,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
| Dwi Zahra Restiningrum| Marketing         | IDR 3,000,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
| LUTFI PRATAMA HURA    | Office Boy        | IDR 2,500,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
| Ranti Tri Mulyani     | Finance           | IDR 2,000,000 | IDR 0.00          | IDR 0.00      | IDR 0.00      |
+-----------------------+-------------------+---------------+-------------------+---------------+---------------+
| **TOTALS**            |                   |               | **IDR 1,150,000** | **IDR 500K**  | **IDR 650K**  |
| **GL 1160 TIE-OUT**   |                   |               |                   |               | **EXACT 100%**|
+-----------------------+-------------------+---------------+-------------------+---------------+---------------+
```

---

## 2. Payroll Subsystem Lifecycles & Controls

### 1. Salary Expense Booking & Approval:
- Recorded via `finance_expenses` with `expense_category = 'salary'`.
- Upon manager approval, the system fires `Dr 6100 (Salaries & Wages) / Cr 2110 (AP) / Cr 2131 (PPh 21)`.
- Total historical gross salaries: **IDR 422,044,000.00**; Total PPh 21 withheld: **IDR 927,500.00**.

### 2. Salary Advance Issuance & Payday Deduction:
- Advances are issued via Payment Vouchers (`payment_purpose = 'salary_advance'`) debiting Account 1160 (`Dr 1160 / Cr 111101`).
- When the monthly salary payment voucher is created, the system auto-calculates open advances and applies the recovery amount (`salary_advance_applied_amount`), debiting AP (2110), crediting Bank (111101) for net cash, and crediting Staff Advances (1160) for the recovered amount.
- **Proof:** Muhamad Imron Hanifah received IDR 500,000 advance on June 18, 2026, which was automatically deducted on July 31, 2026 payroll, bringing his open advance balance to exactly **IDR 0.00**.

---

## 3. Gaps & Recommendations for Payroll

```
+------------------------------------------------------------------------------------------------------------------------------------------+
| PAYROLL & STAFF LEDGER GAPS & RECOMMENDATIONS                                                                                            |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| # | Architectural Gap                         | Severity  | Forensic Description & Real-World ERP Benchmark                              |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
| 1 | **Monthly Batch Payroll Slip Generator**  | **MEDIUM**| Salaries are currently booked employee-by-employee. Real ERPs allow a 1-click|
|   |                                           |           | "Generate Monthly Payroll Batch" creating payslips for all active staff.     |
| 2 | **BPJS Ketenagakerjaan & Kesehatan Split**| **MEDIUM**| BPJS contributions (JKK, JKM, JHT, JP, BPJS Kes) are currently embedded in  |
|   |                                           |           | net salaries rather than split into employer vs employee statutory lines.    |
| 3 | **Employee Individual Ledger Card UI**    | **LOW**   | Provide a dedicated 1-page printable employee card showing year-to-date      |
|   |                                           |           | earnings, advances, tax deductions, and net payouts.                         |
+---+-------------------------------------------+-----------+------------------------------------------------------------------------------+
```

---

## 4. Stage 6 Verdict: **GREEN**
The Staff Master and Advance Recovery engine is **mathematically sound, robust, and reconciles with 100% precision to General Ledger Account 1160**.

---
*End of Stage 6: Payroll & Staff Ledger Forensic Audit.*
