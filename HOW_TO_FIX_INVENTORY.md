# How To Fix The Inventory System - Step by Step Guide

## Quick Summary

**Problem**: Ibuprofen BP batch shows 153kg stock, but it should be different. All batches might have incorrect stock.

**Cause**: The UI was manually setting stock values instead of letting the database calculate them from transactions.

**Solution**:
1. ✅ Fixed the UI code (already done)
2. ⚠️ Run SQL script to fix existing data (YOU need to do this)
3. ✅ System will work correctly going forward

---

## Step 1: Run The Audit (5 minutes)

### What This Does
Checks all batches to find which ones have incorrect stock values.

### How To Do It

1. **Open Supabase Dashboard**
   - Go to your Supabase project
   - Click on "SQL Editor" in the left sidebar

2. **Copy The Audit SQL**
   - Open file: `audit_and_fix_inventory.sql`
   - Copy the ENTIRE file content

3. **Run The Audit**
   - Paste into Supabase SQL Editor
   - Click "Run" button
   - Wait 10-30 seconds

4. **Review Results**
   - You'll see a list of ALL batches with problems
   - Look for your Ibuprofen batch (4001/1101/25/A-3147)
   - Note which batches have issues

### What The Output Looks Like

```
NOTICE: Found issues in 15 batches:

Batch: 4001/1101/25/A-3147 (Ibuprofen BP)
  Issue: STOCK_MISMATCH
  Expected: 847 | Actual: 153 | Diff: -694
  Details: {...}

Batch: BATCH-002 (Paracetamol)
  Issue: PURCHASE_MISMATCH
  Expected: 1000 | Actual: 0 | Diff: -1000
  Details: {...}
```

---

## Step 2: Preview The Fixes (2 minutes)

### What This Does
Shows you what changes will be made WITHOUT actually making them (dry run).

### How To Do It

In Supabase SQL Editor, run this command:

```sql
SELECT fn_repair_all_batches(true);
```

### What You'll See

```json
{
  "dry_run": true,
  "total_batches": 50,
  "batches_fixed": 15,
  "errors": 0,
  "details": [
    {
      "batch_number": "4001/1101/25/A-3147",
      "import_quantity": 1000,
      "old_stock": 153,
      "new_stock": 847,
      "actions_taken": [
        {
          "action": "UPDATE_CURRENT_STOCK",
          "old_value": 153,
          "new_value": 847,
          "difference": 694
        }
      ]
    }
  ]
}
```

### Review This Carefully!

- Check if the "new_stock" values make sense
- Verify "import_quantity" matches your records
- If anything looks wrong, STOP and report it

---

## Step 3: Apply The Fixes (2 minutes)

### ⚠️ WARNING: This Will Modify Your Database!

Make sure you:
- ✅ Reviewed the dry run results
- ✅ The fixes look correct
- ✅ Have a backup (Supabase does automatic backups)
- ✅ No users are actively using the system

### How To Do It

In Supabase SQL Editor, run this command:

```sql
SELECT fn_repair_all_batches(false);
```

**Note**: `false` means "really do it" (not a dry run)

### What Happens

- Missing purchase transactions will be created
- All `current_stock` values will be recalculated
- System will be consistent again

### Verification

After running, check a few batches:

```sql
-- Check Ibuprofen batch specifically
SELECT
  b.batch_number,
  p.product_name,
  b.import_quantity,
  b.current_stock,
  (SELECT SUM(quantity) FROM inventory_transactions WHERE batch_id = b.id) as calculated_stock
FROM batches b
JOIN products p ON b.product_id = p.id
WHERE b.batch_number LIKE '%A-3147%';
```

The `current_stock` and `calculated_stock` should match!

---

## Step 4: Verify In The App (2 minutes)

1. **Refresh Your Browser**
   - Press Ctrl+F5 (Windows) or Cmd+Shift+R (Mac)
   - This clears the cache

2. **Check The Batches Page**
   - Go to Batches in your app
   - Find Ibuprofen batch
   - Verify the stock looks correct

3. **Check Inventory Page**
   - Go to Inventory/Stock page
   - Verify all totals look correct

4. **Test Creating A New Batch**
   - Create a test batch with 100kg
   - Check that current_stock shows 100kg
   - Delete the test batch

---

## What If Something Goes Wrong?

### Issue: Audit shows too many errors

**Solution**: Don't panic! This is expected if:
- You've been using the system for a while
- You edited batches multiple times
- You had historical data migrations

Just review a few samples to ensure the fixes make sense.

### Issue: New stock values look wrong

**Possible Causes**:
1. Double deductions (DC + Invoice for same items)
2. Missing transactions
3. Manual adjustments made in the past

**Solution**:
1. Check the specific batch's transactions:
```sql
SELECT * FROM inventory_transactions
WHERE batch_id = 'batch-id-here'
ORDER BY created_at;
```

2. Look for duplicates or missing entries
3. If needed, manually add adjustment transaction:
```sql
INSERT INTO inventory_transactions (
  product_id, batch_id, transaction_type, quantity,
  transaction_date, reference_number, notes, created_by
) VALUES (
  'product-id', 'batch-id', 'adjustment', 100.000,
  CURRENT_DATE, 'MANUAL-ADJ-001',
  'Manual correction: explain what and why',
  (SELECT id FROM user_profiles LIMIT 1)
);
```

### Issue: Can't find Ibuprofen batch

**Solution**: Search for it:
```sql
SELECT b.id, b.batch_number, p.product_name, b.import_quantity, b.current_stock
FROM batches b
JOIN products p ON b.product_id = p.id
WHERE p.product_name ILIKE '%ibuprofen%'
OR b.batch_number LIKE '%3147%'
ORDER BY b.created_at DESC;
```

### Issue: Batch shows negative stock

**This should NOT happen after the fix!** If it does:

1. Check all transactions for that batch
2. Look for double deductions
3. Verify DC and Invoice aren't both deducting stock
4. Contact support with batch ID

---

## Understanding The Fix

### What Was Fixed In The Code

**File**: `src/pages/Batches.tsx`

**Before (WRONG)**:
```typescript
// UI manually calculated stock
const finalCurrentStock = formData.import_quantity - soldQuantity;
const batchData = {
  current_stock: finalCurrentStock,  // ❌ Manual override
  // ...
};
```

**After (CORRECT)**:
```typescript
// UI does NOT set current_stock
const batchData = {
  // current_stock removed!  ✓
  // Database triggers calculate it automatically
  // ...
};

// If import_quantity changes, update the transaction
if (formData.import_quantity !== editingBatch.import_quantity) {
  await supabase
    .from('inventory_transactions')
    .update({ quantity: formData.import_quantity })
    .eq('batch_id', editingBatch.id)
    .eq('transaction_type', 'purchase');
}
```

### How The System Works Now

```
Create Batch:
  1. UI inserts batch with import_quantity
  2. Database trigger creates purchase transaction (+import_quantity)
  3. Database trigger updates current_stock = SUM(transactions)
  4. Result: current_stock = import_quantity ✓

Create Delivery Challan:
  1. DC created with items
  2. Database trigger creates delivery_challan transactions (-quantity)
  3. Database trigger updates current_stock for affected batches
  4. Result: current_stock automatically reduced ✓

Create Sales Invoice (not linked to DC):
  1. Invoice created with items
  2. Database trigger creates sale transactions (-quantity)
  3. Database trigger updates current_stock
  4. Result: current_stock automatically reduced ✓

Create Sales Invoice (linked to DC):
  1. Invoice created with items marked as from DC
  2. Database trigger sees delivery_challan_item_id IS NOT NULL
  3. Database trigger SKIPS stock deduction (DC already did it)
  4. Result: NO double deduction ✓
```

---

## Preventing Future Issues

### For Users

1. **DON'T** edit `import_quantity` after creating a batch
   - If you made a mistake, delete and recreate
   - Or contact admin to fix it

2. **DON'T** delete delivery challans or invoices
   - Mark as void/cancelled instead
   - Deletions can break stock tracking

3. **DO** follow proper workflow:
   - Import Batch → Create DC → Create Invoice
   - Don't skip steps

4. **DO** report discrepancies immediately
   - Don't try to "fix" stock manually
   - Report to admin for proper correction

### For Admins

1. **Monitor** stock regularly:
   ```sql
   -- Run this weekly
   SELECT COUNT(*) as issues
   FROM fn_audit_all_batches();
   ```

2. **Backup** before major operations
   - Supabase has automatic backups
   - But manual backup before bulk operations is smart

3. **Validate** after bulk imports
   - Run audit after importing many batches
   - Fix issues immediately

4. **Document** any manual adjustments
   - Always include reason in transaction notes
   - Keep log of manual fixes

---

## Support

### Files Created

1. `INVENTORY_BUG_ANALYSIS.md` - Detailed technical analysis
2. `audit_and_fix_inventory.sql` - SQL script to fix data
3. `HOW_TO_FIX_INVENTORY.md` - This guide (step-by-step)
4. `FIX_GMAIL_AND_CHALLAN.md` - Gmail OAuth and DC fixes

### Need Help?

If you have issues:

1. **Take screenshots** of:
   - Audit results
   - Error messages
   - Batch details showing wrong stock

2. **Run diagnostic query**:
```sql
SELECT
  b.batch_number,
  p.product_name,
  b.import_quantity,
  b.current_stock,
  (SELECT COUNT(*) FROM inventory_transactions WHERE batch_id = b.id) as transaction_count,
  (SELECT SUM(quantity) FROM inventory_transactions WHERE batch_id = b.id) as calculated_stock,
  (SELECT SUM(quantity) FROM inventory_transactions WHERE batch_id = b.id AND transaction_type = 'purchase') as purchases,
  (SELECT SUM(quantity) FROM inventory_transactions WHERE batch_id = b.id AND transaction_type = 'delivery_challan') as dc_sales
FROM batches b
JOIN products p ON b.product_id = p.id
WHERE b.batch_number = 'YOUR-BATCH-NUMBER-HERE';
```

3. **Share the results** with details of what's wrong

---

## Success Checklist

After completing all steps, verify:

- ✅ Audit shows 0 issues (or acceptable explainable issues)
- ✅ Ibuprofen batch shows correct stock
- ✅ New batches calculate stock correctly
- ✅ Delivery challans deduct stock properly
- ✅ Invoices don't double-deduct when linked to DCs
- ✅ Editing batches doesn't break stock
- ✅ Stock totals match expectations

**If all checked ✅, you're done!** The system is fixed and will stay correct going forward.