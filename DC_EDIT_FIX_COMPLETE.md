# Delivery Challan Edit System - Complete Fix

## Problems Identified

### Problem 1: Stock Corruption During DC Edit
**Issue:** When editing a delivery challan, stock values would become incorrect (e.g., batch A-3145 jumping from 850kg to 1450kg to 2100kg).

**Root Cause:** The old edit flow used a DELETE-then-INSERT approach:
1. DELETE all DC items → triggers fire → releases reservations/adds stock back
2. INSERT new DC items → triggers fire → creates new reservations
3. If step 2 failed, step 1 already corrupted the stock
4. Even when successful, multiple trigger firings caused confusion and incorrect calculations

### Problem 2: Cannot Add Items When Editing DC
**Issue:** Error message: "Insufficient available stock for batch X" even though the batch had stock.

**Root Cause:** The validation didn't account for the fact that the DC being edited already had reservations. Example:
- Batch has 200kg available + 400kg reserved by DC-009
- When editing DC-009, system only saw 200kg available
- System didn't know the 400kg reservation belonged to the DC being edited

### Problem 3: Invalid Batch Selection Error
**Issue:** When trying to update DC, getting "Invalid product or batch selection" error.

**Root Cause:** DC-009 was deleted during failed edit attempts, leaving zero items. The delete-insert logic corrupted the database state.

## Solutions Implemented

### 1. Atomic DC Edit RPC Function
Created `edit_delivery_challan()` PostgreSQL function that handles edits atomically:

**How It Works:**
1. Calculates NET changes in reservations (old items vs new items)
2. Temporarily disables triggers
3. Deletes all old items WITHOUT triggering inventory changes
4. Inserts all new items WITHOUT triggering inventory changes
5. Re-enables triggers
6. Applies ONLY the net reservation changes to batches
7. Creates single inventory transaction for the net change

**Benefits:**
- No stock corruption if edit fails (atomic operation)
- Only net changes affect inventory (no double-counting)
- Single clean transaction log entry
- Much simpler and safer

### 2. Fixed DC Item Delete Trigger
Updated `trg_delivery_challan_item_inventory()` to check DC approval status:

**Old Logic:**
- Always added stock back to current_stock when deleting items

**New Logic:**
- If DC is PENDING: Only release reservations (don't touch current_stock)
- If DC is APPROVED: Restore both current_stock AND release reservations

**Why:** Pending DCs only RESERVE stock, they don't deduct it. Approved DCs deduct stock. So deletes must handle each case differently.

### 3. Updated Frontend Edit Logic
**Old Flow:**
```
1. Update DC header
2. DELETE all items → triggers fire
3. INSERT new items → triggers fire
```

**New Flow:**
```
1. Update DC header
2. Call RPC function edit_delivery_challan()
   - RPC handles all item changes atomically
   - No manual delete/insert
   - All inventory calculations done correctly
```

### 4. Fixed Stock Validation During Edit
Added logic to include current DC's reservations when calculating available stock:

```typescript
if (editingChallan) {
  const originalQtyInThisBatch = originalItems
    .filter(oi => oi.batch_id === batchId)
    .reduce((sum, oi) => sum + oi.quantity, 0);
  availableStock += originalQtyInThisBatch;
}
```

**Why:** When editing DC-009 which has 400kg reserved from batch X, we should allow using that 400kg again since we're just modifying the same DC.

### 5. Fixed Corrupted Stock Data
Manually corrected batch A-3145:
- Was: 2100kg (incorrect from multiple failed edits)
- Corrected to: 850kg (1000kg purchase - 150kg in approved DC-005)

## How DC System Works Now

### Creating New DC (Pending Status)
1. Insert DC header
2. Insert DC items → triggers fire
3. Triggers UPDATE batches:
   - `reserved_stock` increases
   - `current_stock` stays same
4. Creates inventory transaction with type 'adjustment'

### Editing Pending DC
1. Update DC header
2. Call `edit_delivery_challan()` RPC:
   - Calculates net reservation changes
   - Updates items without triggering
   - Applies only net changes to batch reservations
3. Single transaction log entry for net change

### Approving DC
1. Update DC status to 'approved'
2. Trigger fires on approval
3. Updates batches:
   - `current_stock` decreases
   - `reserved_stock` decreases
4. Creates inventory transaction with type 'delivery_challan'

### Deleting DC
- If PENDING: Only releases reservations
- If APPROVED: Restores current_stock AND releases reservations

## Stock Calculation Logic

For any batch:
```
Total Stock = current_stock
Reserved = reserved_stock
Available = current_stock - reserved_stock
```

**Important Rules:**
1. Pending DCs only affect `reserved_stock`
2. Approved DCs affect both `current_stock` and `reserved_stock`
3. Deleting pending DC items only releases reservations
4. Deleting approved DC items restores stock

## Current Stock Status

### Ibuprofen BP Batches
- **A-3145:** 850kg total, 0kg reserved, 850kg available
- **A-3146:** 450kg total, 0kg reserved, 450kg available
- **A-3147:** 1000kg total, 0kg reserved, 1000kg available

### Existing DCs
- DC-009 was deleted during failed edit attempts
- All other DCs (001-008) are approved and working correctly

## Testing
1. Create new DC → Stock reserved correctly ✓
2. Edit pending DC → Net changes applied, no corruption ✓
3. Approve DC → Stock deducted correctly ✓
4. Delete pending DC → Reservations released ✓
5. Delete approved DC → Stock restored ✓

## Next Steps
The DC system is now solid and will not corrupt stock during edits. You can:
1. Create new delivery challans
2. Edit pending delivery challans without worrying about stock corruption
3. Stock calculations are now accurate and consistent
