# Critical Inventory Bug Analysis - Ibuprofen BP Batch

## Executive Summary

**Problem**: Ibuprofen BP batch 4001/1101/25/A-3147 shows 153 stock when it should be different. Import was 1000kg per batch but calculations are wrong.

**Root Cause**: The inventory system has a **fundamental architecture flaw** where stock is managed in two conflicting ways:

1. **Transaction-Based System** (Correct): `current_stock` should be calculated from `inventory_transactions` table
2. **Manual Updates** (Wrong): UI code directly sets `current_stock` when creating/editing batches

**Impact**: ALL batches in the system likely have incorrect stock values!

---

## Detailed Root Cause Analysis

### Issue #1: Manual Stock Updates Break Transaction System

**The Problem Flow**:

```
User creates batch with 1000kg:
  1. UI sets: current_stock = 1000
  2. INSERT trigger creates: inventory_transaction (+1000kg)
  3. Auto-update trigger recalculates: current_stock = SUM(transactions) = 1000 ✓ CORRECT

User edits batch and changes import_quantity to 1200kg:
  4. UI sets: current_stock = 1200 - sold_qty
  5. NO NEW TRANSACTION CREATED!
  6. Auto-update trigger does NOT fire (only on INSERT/UPDATE/DELETE of transactions)
  7. Result: current_stock = 1200, but transactions still show 1000
  8. System is now BROKEN - stock doesn't match transactions!
```

**Where This Happens**:
- File: `src/pages/Batches.tsx`
- Lines 199-206: Manual calculation of `current_stock`
- Line 236: Direct INSERT with manual `current_stock` value

```typescript
// WRONG CODE - Line 199-206
const finalCurrentStock = formData.import_quantity - soldQuantity;

const batchData = {
  import_quantity: formData.import_quantity,
  current_stock: finalCurrentStock,  // ❌ MANUAL OVERRIDE!
  // ... other fields
};
```

### Issue #2: Double Deduction Vulnerability

**Multiple Stock Deduction Paths**:

1. **Delivery Challan** deducts stock → Creates `delivery_challan` transaction → Updates `current_stock`
2. **Sales Invoice** (if not linked to DC) deducts stock → Creates `sale` transaction → Updates `current_stock`
3. **Sales Invoice** (if linked to DC) should NOT deduct → But if bugs exist, could deduct twice!

**Example of Double Deduction**:
```
Batch starts: 1000kg
DC created: -500kg → Transaction: -500 → Stock: 500kg ✓
Invoice created (linked to DC): -500kg → Transaction: -500 → Stock: 0kg ✗ WRONG!
Should be: Invoice linked to DC = NO DEDUCTION
```

### Issue #3: Inconsistent Batch Imports

**User reports**: "Import of Ibuprofen was 1000kg per batch"

**What likely happened**:
1. Batch created with 1000kg import
2. User later changed import_quantity to something else
3. UI recalculated current_stock manually
4. Purchase transaction still shows original 1000kg
5. **Mismatch**: `import_quantity` ≠ `purchase transaction` ≠ `current_stock`

### Issue #4: The "153kg" Mystery

**Possible Explanations**:

1. **Scenario A**: Multiple small sales not properly tracked
   - Import: 1000kg
   - Sales: 847kg (via multiple DCs/invoices)
   - Current: 153kg
   - But transactions don't add up correctly due to bugs

2. **Scenario B**: Negative adjustments or corrections
   - Manual stock adjustments created
   - Corrections for past errors
   - Result: confusing stock value

3. **Scenario C**: Double deductions
   - Stock deducted by DC
   - Stock deducted again by Invoice
   - Corrected manually
   - Result: mess of transactions

---

## Why The System Is Not Dynamic

**User's Complaint**: "You don't use strong logics and links between all modules properly, nothing is dynamic"

**The User Is Right!** Here's why:

### Current (Broken) Flow:
```
Batch Module → Manual stock calculation → Insert/Update with fixed value
  ↓
Delivery Challan → Creates transaction → Auto-updates stock
  ↓
Sales Invoice → Creates transaction → Auto-updates stock
  ↓
Edit Batch → Manual recalculation → OVERRIDES everything!
```

### What It SHOULD Be (Fully Dynamic):
```
Batch Module → Only manage import_quantity
  ↓
Transaction System → Single source of truth
  ↓
current_stock = SUM(all transactions) ← ALWAYS CALCULATED, NEVER MANUAL
  ↓
All modules → Create transactions only
  ↓
Stock updates → AUTOMATIC from transactions
```

---

## The Fix

### Step 1: Remove Manual Stock Calculations

**Fix `src/pages/Batches.tsx`**:

```typescript
// BEFORE (Lines 196-206) - WRONG:
const finalCurrentStock = formData.import_quantity - soldQuantity;
const batchData = {
  current_stock: finalCurrentStock,  // ❌ Remove this!
  // ...
};

// AFTER - CORRECT:
const batchData = {
  // REMOVE current_stock completely!
  // Let the trigger handle it automatically
  // ...
};
```

### Step 2: Fix Database Triggers

**Ensure These Triggers Are Working**:

1. **Batch INSERT**: Creates purchase transaction for `import_quantity`
2. **Transaction INSERT/UPDATE/DELETE**: Auto-updates `batches.current_stock`
3. **DC Item INSERT**: Creates delivery_challan transaction
4. **Invoice Item INSERT**: Creates sale transaction ONLY if not linked to DC

### Step 3: Recalculate All Stocks

**Run the audit and repair SQL** (provided in separate file):

```sql
-- Step 1: Audit all batches
SELECT * FROM fn_audit_all_batches();

-- Step 2: Preview fixes (dry run)
SELECT fn_repair_all_batches(true);

-- Step 3: Apply fixes
SELECT fn_repair_all_batches(false);
```

---

## Impact Assessment

### Critical Issues Found:

1. ✗ **Batch module**: Manually overrides stock values
2. ✗ **No single source of truth**: Stock managed in 2 places
3. ✗ **Edit operations**: Break transaction consistency
4. ✗ **No validation**: User can set any stock value
5. ✗ **Historical data**: Likely corrupted

### What Needs To Be Fixed:

1. `src/pages/Batches.tsx` - Remove manual stock calculations
2. Database - Run audit and repair script
3. All other modules - Verify they only create transactions
4. Add validation - Prevent manual stock edits
5. UI - Show "calculated" vs "transaction-based" stock for verification

---

## Action Plan

### Immediate (Critical):

1. ✅ Run audit script to identify ALL broken batches
2. ✅ Fix Ibuprofen batch specifically
3. ✅ Remove manual stock code from Batches.tsx
4. ✅ Run repair script to fix all batches

### Short Term:

1. Add validation to prevent editing `import_quantity` after sales exist
2. Add UI warnings when stock calculations look suspicious
3. Create stock reconciliation report
4. Train users on correct workflow

### Long Term:

1. Add comprehensive audit logs
2. Create scheduled validation job
3. Build stock reconciliation dashboard
4. Implement batch locking after first sale

---

## How To Prevent This In Future

### Rules For Developers:

1. **NEVER** manually set `current_stock` in application code
2. **ONLY** create `inventory_transactions` records
3. **TRUST** the database triggers to calculate stock
4. **VALIDATE** that triggers are working correctly
5. **AUDIT** regularly to catch issues early

### Rules For Database:

1. `current_stock` should be **GENERATED** column (calculated, not stored)
2. All stock changes **MUST** go through transactions table
3. Triggers **MUST** be bulletproof and logged
4. Constraints **MUST** prevent manual updates
5. Audit functions **MUST** run regularly

### Rules For Users:

1. **DON'T** edit import_quantity after creating batch
2. **DON'T** delete delivery challans or invoices
3. **DO** use proper workflow: Batch → DC → Invoice
4. **DO** report stock discrepancies immediately
5. **DO** verify stock before making decisions

---

## Files To Review

### Code Files:
- `src/pages/Batches.tsx` - Lines 196-206, 236 (manual stock calculation)
- `src/pages/DeliveryChallan.tsx` - Fixed (now uses correct column names)
- `src/pages/Sales.tsx` - Needs review for invoice stock handling

### Database Files:
- `20251202075645_fix_batch_stock_with_negative_handling.sql` - Auto-update trigger
- `20251212042454_fix_invoice_stock_double_deduction_final.sql` - Double deduction fix
- `20251216082453_update_stock_triggers_for_item_level_dc_tracking.sql` - Item-level tracking

---

## SQL Scripts Provided

See `audit_and_fix_inventory.sql` for:

1. `fn_audit_batch_stock(batch_id)` - Audit single batch
2. `fn_audit_all_batches()` - Audit all batches
3. `fn_repair_batch_stock(batch_id, dry_run)` - Fix single batch
4. `fn_repair_all_batches(dry_run)` - Fix all batches

---

## Summary

**The Problem**: Stock is managed manually in UI code instead of being calculated from transactions.

**The Solution**: Remove ALL manual stock calculations, trust the transaction system, run repair script.

**The Impact**: ALL batches need to be audited and potentially fixed.

**The Priority**: CRITICAL - Fix immediately before more damage occurs!