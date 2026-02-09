# ✅ Advance Payment Workflow Guide

## The System is Already Working!

Your advance payment system is **fully functional**. The issue is likely that invoices are being created **without linking them to the Sales Order** that received the advance payment.

---

## 📋 Correct Workflow

### Step 1: Receive Advance Payment
1. Go to **Finance** → **Receipt Vouchers**
2. Click **+ New Receipt Voucher**
3. Fill in:
   - Customer
   - Payment Method
   - Amount
4. **IMPORTANT:** In the "Allocate to Invoice/Sales Order" section:
   - Find the Sales Order in the dropdown
   - Enter the advance amount
   - Click **Allocate**
5. Save the receipt voucher

✅ **Result:** Sales Order now shows advance payment status

---

### Step 2: Create Sales Invoice from Sales Order
1. Go to **Sales Invoices** → **+ New Invoice**
2. Select the **Customer**
3. **🚨 CRITICAL STEP:**
   - You'll see a **blue highlighted box** that says:
   - **"Link to Sales Order (for advance payment tracking)"**
   - **SELECT THE SALES ORDER** from the dropdown
   - If the SO has an advance, you'll see:
     - "💰 ADVANCE PAID: Rp XXX"
4. Add invoice items as normal
5. Click **Save Invoice**

✅ **Result:**
- Advance payment is **automatically transferred** from SO to Invoice
- Invoice shows correct **Paid Amount**
- Invoice shows correct **Payment Status** (Partial/Paid)
- Balance is calculated correctly

---

## 🔍 Why Invoice Still Shows "Pending Payment"

### Most Common Reason:
**You created the invoice WITHOUT selecting the Sales Order!**

When you create an invoice and skip the "Link to Sales Order" dropdown, the system has no way to know which advance payment to apply.

---

## 🛠️ How to Fix Existing Invoices

### Option 1: Link Invoice to Sales Order (Recommended)

```sql
-- Find the invoice and sales order
SELECT
  si.invoice_number,
  si.sales_order_id,
  so.so_number,
  so.advance_payment_amount
FROM sales_invoices si
LEFT JOIN sales_orders so ON so.id = si.sales_order_id
WHERE si.invoice_number = 'YOUR-INVOICE-NUMBER';

-- If sales_order_id is NULL, update it
UPDATE sales_invoices
SET sales_order_id = (
  SELECT id FROM sales_orders
  WHERE so_number = 'YOUR-SO-NUMBER'
)
WHERE invoice_number = 'YOUR-INVOICE-NUMBER';

-- The trigger will automatically apply the advance!
```

### Option 2: Manually Allocate Receipt to Invoice

1. Go to **Finance** → **Receipt Vouchers**
2. Find the advance receipt voucher
3. Click **Edit**
4. Remove the Sales Order allocation
5. Add the Invoice allocation instead
6. Save

---

## 📊 How to Check Current Status

### Check which invoices have linked SOs:
```sql
SELECT
  si.invoice_number,
  si.total_amount,
  si.paid_amount,
  si.payment_status,
  so.so_number,
  so.advance_payment_amount
FROM sales_invoices si
LEFT JOIN sales_orders so ON so.id = si.sales_order_id
WHERE si.sales_order_id IS NOT NULL
ORDER BY si.created_at DESC;
```

### Check advance payments on Sales Orders:
```sql
SELECT
  so.so_number,
  so.total_amount,
  so.advance_payment_amount,
  so.advance_payment_status,
  COUNT(va.id) as advance_count,
  STRING_AGG(rv.voucher_number, ', ') as receipt_vouchers
FROM sales_orders so
LEFT JOIN voucher_allocations va ON va.sales_order_id = so.id
LEFT JOIN receipt_vouchers rv ON rv.id = va.receipt_voucher_id
WHERE so.advance_payment_amount > 0
GROUP BY so.id, so.so_number, so.total_amount,
         so.advance_payment_amount, so.advance_payment_status
ORDER BY so.created_at DESC;
```

---

## 🎯 Key Points to Remember

1. **Advance payments are linked to Sales Orders, NOT directly to Invoices**
2. **When creating an invoice, you MUST select the SO** to transfer the advance
3. The system **automatically** transfers the advance when you link the SO
4. The **blue highlighted box** in the invoice form is your reminder!
5. If you see a warning "⚠️ This customer has Sales Orders with advance payments" - **READ IT!**

---

## 🔄 What Happens Automatically

When you save an invoice with `sales_order_id` set:

1. ✅ System finds all advance payments on that Sales Order
2. ✅ Transfers them to the new Invoice
3. ✅ Updates Invoice `paid_amount`
4. ✅ Updates Invoice `payment_status` (pending/partial/paid)
5. ✅ Removes/reduces advance from Sales Order
6. ✅ Creates accounting journal entries

**All of this is 100% automatic!** You just need to select the SO.

---

## 💡 Pro Tips

### For Staff Training:
- **Always look for the blue box** when creating invoices
- **Read warning messages** - they're there to help!
- When in doubt, check if the customer has pending Sales Orders with advances

### For Better Workflow:
- Create Sales Order first
- Receive advance payment → Link to SO
- When ready to invoice → Create invoice → Link to same SO
- System handles the rest!

---

## ❌ Common Mistakes

1. ❌ Creating invoice without selecting Sales Order
2. ❌ Linking receipt voucher to invoice instead of Sales Order
3. ❌ Creating multiple invoices from same SO without checking advance balance
4. ❌ Ignoring the warning messages in the UI

---

## ✅ System is Working If:

- Receipt voucher shows: "SO-2025-XXXX (Advance)"
- Sales Order shows: advance_payment_amount > 0
- Invoice form shows: Blue box with SO selector
- After saving invoice: paid_amount is updated
- Invoice list shows: Correct payment status

If all above are true, your system is perfect! Just remember to **select the Sales Order** when creating invoices.
