# Ibuprofen BP Stock Audit & Fix Guide

## Summary of Fixes Applied

✅ **All 3 pages are now fully functional:**
1. **Material Returns** - Complete with view/print, DC linking, financial impact calculation
2. **Stock Rejections** - New view component created with print/PDF, photo display
3. **Credit Notes** - Fixed PPN 11% tax calculation

✅ **Robust Logic Implemented:**
- Material Returns properly calculate financial impact
- Credit Notes calculate 11% VAT correctly
- Stock Rejections show complete details with photos
- All have professional print layouts with company branding

## How to Check & Fix Ibuprofen BP Stock

### Step 1: Check Current Stock Status

Run this query in Supabase SQL Editor:

```sql
-- Check Ibuprofen BP batches
SELECT
  b.batch_number,
  b.import_quantity as "Imported (Kg)",
  b.current_stock as "Current Stock (Kg)",
  b.reserved_stock as "Reserved (Kg)",
  (b.import_quantity - b.current_stock - b.reserved_stock) as "Sold/Used (Kg)"
FROM products p
JOIN batches b ON b.product_id = p.id
WHERE p.product_name = 'Ibuprofen BP'
ORDER BY b.batch_number;
```

### Step 2: Audit All Transactions

```sql
-- Check all Delivery Challans
SELECT
  dc.challan_number,
  dc.challan_date,
  c.company_name,
  b.batch_number,
  dci.quantity as "DC Qty"
FROM delivery_challans dc
JOIN delivery_challan_items dci ON dci.challan_id = dc.id
JOIN products p ON p.id = dci.product_id
JOIN batches b ON b.id = dci.batch_id
JOIN customers c ON c.id = dc.customer_id
WHERE p.product_name = 'Ibuprofen BP'
ORDER BY dc.challan_date;

-- Check all Sales Invoices
SELECT
  si.invoice_number,
  si.invoice_date,
  c.company_name,
  b.batch_number,
  sii.quantity as "Invoice Qty",
  sii.delivery_challan_item_id as "DC Item Link"
FROM sales_invoices si
JOIN sales_invoice_items sii ON sii.invoice_id = si.id
JOIN products p ON p.id = sii.product_id
LEFT JOIN batches b ON b.id = sii.batch_id
JOIN customers c ON c.id = si.customer_id
WHERE p.product_name = 'Ibuprofen BP'
ORDER BY si.invoice_date;

-- Check DC invoicing status
SELECT
  challan_number,
  batch_number,
  original_quantity as "DC Qty",
  invoiced_quantity as "Invoiced",
  remaining_quantity as "Remaining",
  status,
  invoice_numbers
FROM dc_item_invoice_status
WHERE product_name = 'Ibuprofen BP'
ORDER BY challan_date;
```

### Step 3: Calculate Expected Stock

```sql
-- Expected vs Actual Stock for Each Batch
WITH ibuprofen_batches AS (
  SELECT
    b.id,
    b.batch_number,
    b.import_quantity,
    b.current_stock
  FROM products p
  JOIN batches b ON b.product_id = p.id
  WHERE p.product_name = 'Ibuprofen BP'
),
dc_only AS (
  -- DC items NOT yet invoiced
  SELECT
    ib.id,
    COALESCE(SUM(
      CASE WHEN sii.id IS NULL THEN dci.quantity ELSE 0 END
    ), 0) as qty
  FROM ibuprofen_batches ib
  LEFT JOIN delivery_challan_items dci ON dci.batch_id = ib.id
  LEFT JOIN sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
  GROUP BY ib.id
),
invoiced AS (
  -- All invoiced quantities
  SELECT
    ib.id,
    COALESCE(SUM(sii.quantity), 0) as qty
  FROM ibuprofen_batches ib
  LEFT JOIN sales_invoice_items sii ON sii.batch_id = ib.id
  GROUP BY ib.id
)
SELECT
  ib.batch_number as "Batch",
  ib.import_quantity as "Imported",
  dco.qty as "DC Only",
  inv.qty as "Invoiced",
  (ib.import_quantity - dco.qty - inv.qty) as "Expected Stock",
  ib.current_stock as "Actual Stock",
  ((ib.import_quantity - dco.qty - inv.qty) - ib.current_stock) as "Difference"
FROM ibuprofen_batches ib
JOIN dc_only dco ON dco.id = ib.id
JOIN invoiced inv ON inv.id = ib.id
ORDER BY ib.batch_number;
```

### Step 4: Fix Stock Discrepancies

If you find differences, run this to fix:

```sql
-- Fix Ibuprofen BP stock for each batch
WITH ibuprofen_batches AS (
  SELECT
    b.id,
    b.batch_number,
    b.import_quantity,
    b.current_stock,
    b.product_id
  FROM products p
  JOIN batches b ON b.product_id = p.id
  WHERE p.product_name = 'Ibuprofen BP'
),
dc_only AS (
  SELECT
    ib.id,
    COALESCE(SUM(
      CASE WHEN sii.id IS NULL THEN dci.quantity ELSE 0 END
    ), 0) as qty
  FROM ibuprofen_batches ib
  LEFT JOIN delivery_challan_items dci ON dci.batch_id = ib.id
  LEFT JOIN sales_invoice_items sii ON sii.delivery_challan_item_id = dci.id
  GROUP BY ib.id
),
invoiced AS (
  SELECT
    ib.id,
    COALESCE(SUM(sii.quantity), 0) as qty
  FROM ibuprofen_batches ib
  LEFT JOIN sales_invoice_items sii ON sii.batch_id = ib.id
  GROUP BY ib.id
),
calculated AS (
  SELECT
    ib.id,
    ib.batch_number,
    ib.current_stock as old_stock,
    ib.product_id,
    (ib.import_quantity - dco.qty - inv.qty) as new_stock
  FROM ibuprofen_batches ib
  JOIN dc_only dco ON dco.id = ib.id
  JOIN invoiced inv ON inv.id = ib.id
  WHERE ib.current_stock != (ib.import_quantity - dco.qty - inv.qty)
)
UPDATE batches
SET current_stock = c.new_stock
FROM calculated c
WHERE batches.id = c.id
RETURNING
  c.batch_number as "Batch Fixed",
  c.old_stock as "Old Stock",
  c.new_stock as "New Stock",
  (c.new_stock - c.old_stock) as "Adjustment";
```

## System Protections Now in Place

### 1. **Item-Level DC Tracking** ✅
- Every DC item is tracked individually
- Invoices link to specific DC items via `delivery_challan_item_id`
- No double deduction: stock is only deducted once (at DC or Invoice, not both)

### 2. **DC Item Status Views** ✅
Three views track DC item invoicing:

```sql
-- View 1: Individual DC item status
SELECT * FROM dc_item_invoice_status;

-- View 2: Overall DC summary
SELECT * FROM dc_invoicing_summary;

-- View 3: Pending items available for invoicing
SELECT * FROM pending_dc_items_by_customer;
```

### 3. **Inventory Transaction Triggers** ✅
Automatic stock updates when:
- ✅ DC created → reduces stock
- ✅ DC deleted → restores stock
- ✅ Invoice created (DC-linked) → no stock change (already deducted at DC)
- ✅ Invoice created (direct) → reduces stock
- ✅ Invoice deleted → restores stock correctly
- ✅ Material Return approved → adds stock back
- ✅ Stock Rejection approved → removes stock
- ✅ Credit Note approved → adds stock back

### 4. **Proper DC-to-Invoice Linking** ✅
```sql
-- When creating invoice from DC:
INSERT INTO sales_invoice_items (
  invoice_id,
  delivery_challan_item_id,  -- ← This links to DC item
  product_id,
  batch_id,
  quantity,
  unit_price
) VALUES (...);
```

### 5. **Complete Views for All Documents** ✅
All three pages now have:
- Professional print layouts
- PDF download functionality
- Company branding
- Complete transaction details
- Proper calculations

## Testing Your System

### Test 1: Create DC and Check Stock
```sql
-- 1. Note current stock
SELECT current_stock FROM batches
WHERE batch_number = 'YOUR_BATCH_NUMBER';

-- 2. Create DC for 100 Kg
-- (Use the UI)

-- 3. Check stock reduced by 100
SELECT current_stock FROM batches
WHERE batch_number = 'YOUR_BATCH_NUMBER';
```

### Test 2: Create Invoice from DC
```sql
-- 1. Note current stock (should be reduced by DC already)
-- 2. Create invoice linked to DC
-- 3. Check stock is SAME (no double deduction)
```

### Test 3: Material Return
```sql
-- 1. Create material return for 20 Kg
-- 2. Approve it with disposition = 'restock'
-- 3. Check stock increased by 20
```

## Quick Status Check Commands

Run these anytime to check system health:

```sql
-- 1. All product stock status
SELECT
  p.product_name,
  COUNT(b.id) as batches,
  SUM(b.import_quantity) as imported,
  SUM(b.current_stock) as current,
  SUM(b.reserved_stock) as reserved
FROM products p
JOIN batches b ON b.product_id = p.id
WHERE b.is_active = true
GROUP BY p.product_name
ORDER BY p.product_name;

-- 2. Recent inventory transactions
SELECT
  it.transaction_date,
  p.product_name,
  b.batch_number,
  it.transaction_type,
  it.quantity_change,
  it.notes
FROM inventory_transactions it
JOIN products p ON p.id = it.product_id
JOIN batches b ON b.id = it.batch_id
ORDER BY it.transaction_date DESC
LIMIT 50;

-- 3. Pending approvals
SELECT 'Material Returns' as type, COUNT(*) as pending
FROM material_returns WHERE status = 'pending_approval'
UNION ALL
SELECT 'Stock Rejections', COUNT(*)
FROM stock_rejections WHERE status = 'pending_approval'
UNION ALL
SELECT 'Credit Notes', COUNT(*)
FROM credit_notes WHERE status = 'pending_approval';
```

## Root Cause of Previous Issues

The problem was:
1. **Double Deduction**: Stock deducted at both DC creation AND invoice creation
2. **Missing Links**: Invoices weren't properly linked to DC items
3. **No Tracking**: System didn't track which DC items were invoiced

Now fixed with:
✅ Item-level DC tracking
✅ Proper foreign key `delivery_challan_item_id`
✅ Triggers that respect DC-Invoice relationship
✅ Views to monitor status
✅ Validation to prevent overselling

## Important Notes

1. **Stock is deducted ONCE**:
   - For DC → Invoice flow: Deducted at DC, invoice just links
   - For direct invoices: Deducted at invoice (no DC)

2. **Always use DC-Invoice linking**:
   - When creating invoice from UI, select DC items
   - System automatically sets `delivery_challan_item_id`

3. **Returns add stock back**:
   - Material Returns: For pre-invoice returns
   - Credit Notes: For post-invoice returns
   - Both require approval to affect stock

4. **Check views regularly**:
   ```sql
   SELECT * FROM dc_item_invoice_status
   WHERE status != 'fully_invoiced';
   ```

Your system is now robust and tracks every transaction accurately! 🎉
