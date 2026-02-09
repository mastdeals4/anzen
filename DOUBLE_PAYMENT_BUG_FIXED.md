# ✅ Double Payment Counting Bug - FIXED

## 🐛 The Problem

Invoices were showing **negative balances** because payments were being counted **TWICE**:

### Example: SAPJ-006
- **Total:** Rp 3,716,946
- **Paid Amount (before fix):** Rp 7,433,892 ❌ (DOUBLE!)
- **Balance (before fix):** Rp -3,716,946 ❌ (NEGATIVE!)

### Root Cause

The system had **TWO payment tracking tables**:

1. ✅ **`voucher_allocations`** - NEW system (correct)
2. ❌ **`invoice_payment_allocations`** - OLD system (deprecated)

When payments were recorded, they somehow ended up in **BOTH tables**, and the system was **adding them together**:

```
paid_amount = voucher_allocations + invoice_payment_allocations
paid_amount = Rp 3,716,946 + Rp 3,716,946 = Rp 7,433,892 ❌
```

This caused the balance to be:
```
balance = total - paid_amount
balance = Rp 3,716,946 - Rp 7,433,892 = -Rp 3,716,946 ❌
```

---

## 🔧 The Fix

### What Was Done

1. **Backed up old data** from `invoice_payment_allocations`
2. **Deleted all duplicate records** from the old table
3. **Updated 6 database functions** to ONLY use `voucher_allocations`:
   - `get_invoice_paid_amount()`
   - `get_invoices_with_balance()`
   - `recalculate_invoice_payment_status()`
   - Dashboard functions (3)
4. **Recalculated all invoice balances** system-wide
5. **Marked old table as deprecated** to prevent future use

### Result After Fix

**SAPJ-006:**
- ✅ Total: Rp 3,716,946
- ✅ Paid Amount: Rp 3,716,946
- ✅ Balance: Rp 0
- ✅ Status: Paid

**SAPJ-008:**
- ✅ Total: Rp 40,967,325
- ✅ Paid Amount: Rp 40,967,325
- ✅ Balance: Rp 0
- ✅ Status: Paid

**System-Wide Verification:**
- ✅ 12 total invoices checked
- ✅ 0 negative balances (was 2)
- ✅ All payment statuses correct
- ✅ 9 paid invoices
- ✅ 3 pending invoices
- ✅ 0 partial invoices

---

## 💡 Why This Happened

### Timeline of Events

1. **Old System** (before Dec 2025): Used `invoice_payment_allocations`
2. **New System** (after Dec 2025): Migrated to `voucher_allocations` (better design)
3. **Migration Issue**: Old table wasn't fully deprecated
4. **Bug Introduced**: Some code/migration accidentally wrote to BOTH tables
5. **Double Counting**: Functions were summing both tables together

### The Loophole

The key issue was in multiple functions like this:

```sql
-- OLD (WRONG) CODE
SELECT
  SUM(va.allocated_amount) +           -- New system
  SUM(ipa.allocated_amount)            -- Old system (duplicate!)
FROM voucher_allocations va
LEFT JOIN invoice_payment_allocations ipa ...
```

This was meant to support TRANSITION period, but some payments got recorded in BOTH, causing double counting.

---

## 🎯 What Was Fixed

### Database Functions Updated

All these functions now ONLY use `voucher_allocations`:

1. **`get_invoice_paid_amount()`**
   - Used by: Payment calculations throughout the system
   - Fix: Removed `invoice_payment_allocations` lookup

2. **`get_invoices_with_balance()`**
   - Used by: Receipt voucher manager, finance reports
   - Fix: Only queries `voucher_allocations` now

3. **`recalculate_invoice_payment_status()`**
   - Used by: Trigger when payments are added/removed
   - Fix: Removed old table from calculation

4. **Dashboard Functions**
   - `get_admin_dashboard_data()`
   - `get_accounts_dashboard_data()`
   - `get_sales_dashboard_data()`
   - Fix: All receivables/payables calculations now correct

---

## 🚀 Going Forward

### The Correct System

**ONLY use `voucher_allocations` table:**

```sql
-- Correct way to check invoice payments
SELECT
  si.invoice_number,
  si.total_amount,
  COALESCE(SUM(va.allocated_amount), 0) as paid_amount,
  si.total_amount - COALESCE(SUM(va.allocated_amount), 0) as balance
FROM sales_invoices si
LEFT JOIN voucher_allocations va
  ON va.sales_invoice_id = si.id
  AND va.voucher_type = 'receipt'
WHERE si.invoice_number = 'SAPJ-XXX'
GROUP BY si.id;
```

### Old Table Status

**`invoice_payment_allocations`:**
- ⛔ DEPRECATED (2026-02-09)
- ⚠️ DO NOT INSERT NEW RECORDS
- 📦 Kept for historical backup only
- 🔒 All triggers removed
- 💾 Backup table created: `invoice_payment_allocations_backup_20260209`

---

## ✅ Verification

Run this query anytime to check for issues:

```sql
-- Check for any invoices with incorrect balances
SELECT
  invoice_number,
  total_amount,
  paid_amount,
  (total_amount - paid_amount) as balance,
  payment_status,
  CASE
    WHEN (total_amount - paid_amount) < 0 THEN '❌ NEGATIVE BALANCE!'
    WHEN payment_status = 'paid' AND paid_amount < total_amount THEN '❌ WRONG STATUS!'
    WHEN payment_status = 'pending' AND paid_amount > 0 THEN '❌ SHOULD BE PARTIAL!'
    ELSE '✅ OK'
  END as status_check
FROM sales_invoices
ORDER BY invoice_date DESC;
```

Expected result: All rows should show "✅ OK"

---

## 📊 Summary

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| Negative Balances | 2 | 0 ✅ |
| SAPJ-006 Balance | -3.7M ❌ | 0 ✅ |
| SAPJ-008 Balance | Negative ❌ | 0 ✅ |
| Payment Tables Used | 2 ❌ | 1 ✅ |
| Duplicate Data | Yes ❌ | No ✅ |
| Functions Fixed | - | 6 ✅ |

---

## 🎓 Lessons Learned

1. **Complete deprecation**: When migrating systems, fully remove old code
2. **Data validation**: Should have caught negative balances sooner
3. **Single source of truth**: Never sum from multiple payment sources
4. **Better testing**: Need automated tests to catch calculation errors

---

## 🔒 Migration Files Applied

1. `fix_double_payment_drop_triggers_first.sql`
   - Dropped old triggers on deprecated table

2. `fix_double_payment_complete_final.sql`
   - Deleted duplicate data
   - Fixed all 6 functions
   - Recalculated all balances
   - System-wide verification

---

**Status: ✅ RESOLVED**
**Date: 2026-02-09**
**Affected Invoices: All invoices fixed**
**Future Risk: Low (old table deprecated and marked)**
