# Finance Module Data Cleanup Guide for 2026

## Overview
This guide will help you clean up and organize all your financial data before starting fresh in 2026. The main goal is to properly categorize all expenses and move cash transactions to the Petty Cash system.

## Current Data Status

### Expenses Before 2026
- **Total Cash Expenses**: 166 transactions
- **Total Amount**: IDR 466,910,781
- **Date Range**: January 2025 - December 2025

### Expense Categories Found (15 categories):
1. **bank_charges** - 37 transactions
2. **bpom_ski_fees** - 19 transactions (BPOM/SKI license fees)
3. **clearing_forwarding** - 1 transaction (Import clearance)
4. **delivery_sales** - 4 transactions (Delivery expenses for sales)
5. **loading_import** - 2 transactions (Unloading import cargo)
6. **loading_sales** - 4 transactions (Loading cargo for sales)
7. **office_admin** - 30 transactions (Office admin expenses)
8. **office_shifting_renovation** - 55 transactions (Office renovation/setup)
9. **other** - 3 transactions (Miscellaneous)
10. **ppn_import** - 3 transactions (Import VAT)
11. **salary** - 65 transactions (Staff salaries)
12. **staff_welfare** - 13 transactions (Staff welfare/benefits)
13. **travel_conveyance** - 28 transactions (Travel/transport)
14. **utilities** - 32 transactions (Electricity, water, internet, phone)
15. **warehouse_rent** - 15 transactions (Warehouse/office rent)

## What Needs to Be Done

### 1. Move Cash Expenses to Petty Cash
All expenses marked as "cash" payment method should be recorded in the Petty Cash system instead of the main expense module. This gives you better cash management.

**Why?**
- Better tracking of cash on hand
- Proper petty cash reconciliation
- Clearer separation between bank and cash transactions

### 2. Update Journal Entry Descriptions
Currently journal entries show basic descriptions but don't prominently display the expense category. We'll add category prefixes like:
- `[SALARY] Salary Madhu Dec 25`
- `[UTILITIES] Telephone bill paid`
- `[TRAVEL] Transport Nia - BBPOM`

**Why?**
- Easier to scan and understand transactions
- Better for auditing and reporting
- CA Reports will show clear categorization

### 3. Fix Product Codes
Some products in inventory don't have product codes assigned, which causes the inventory movement report to show empty.

**Why?**
- Inventory reports need product codes to display properly
- Better tracking and identification of products
- Professional inventory management

## How to Execute the Cleanup

### Step 1: Review the SQL Script
Open the file `MANUAL_DATA_CLEANUP_2026.sql` and review each section to understand what will happen.

### Step 2: Backup Your Data (Recommended)
Before running any scripts, ensure you have a backup of your database.

### Step 3: Execute the Script
Run the SQL script in your Supabase SQL Editor or via the app interface.

### Step 4: Verify the Results
After running the script, check:
- ✅ Petty Cash transactions created (should have 166 new entries)
- ✅ Journal entries now show category prefixes
- ✅ All products have product codes
- ✅ Inventory movement report shows data

## Expected Results

### Petty Cash System
You'll see all cash expenses properly categorized in the Petty Cash module:
```
Transaction: PCMIG-2501-0001
Date: 2025-01-02
Type: Expense
Amount: 300,000
Description: [UTILITIES] telephone bill paid
Category: utilities
```

### Journal Register
Entries will show clear categories:
```
Date: 2025-12-31
Entry: JE2512-0122
Account: 6100 - Salaries & Wages
Narration: [SALARY] Salary Madhu Dec 25 (UNPAID)
```

### CA Reports
All reports (Cash Ledger, Journal Register, etc.) will display expense categories prominently, making it easy for your CA/tax consultant to review.

### Inventory Movement
The report will show all products with their codes:
```
Product Code: PROD-0001
Product Name: Ibuprofen BP
Opening: 1000
In: 500
Out: 300
Closing: 1200
```

## Post-Cleanup Actions

1. **Review Petty Cash Balance**: Ensure the petty cash balance matches your expectations
2. **Fund Transfers**: Create fund transfers from Bank to Petty Cash as needed
3. **2026 Start Fresh**: All new transactions from Jan 2026 onwards will be properly categorized
4. **Monthly Reconciliation**: Regularly reconcile petty cash with physical cash on hand

## Need Help?

If you encounter any issues:
1. Check the summary reports at the end of the SQL script
2. Review individual transactions to ensure categories are correct
3. Adjust any miscategorized expenses manually if needed

## Benefits After Cleanup

✅ **Clear Financial Picture**: See exactly where your money goes by category
✅ **Better Cash Management**: Track petty cash separately from bank transactions
✅ **Professional Reports**: CA Reports ready for your accountant/auditor
✅ **Accurate Inventory**: All products properly tracked with codes
✅ **Audit Ready**: Clear audit trail with categorized descriptions
✅ **Clean 2026 Start**: Begin the new year with organized, categorized data

---

**Last Updated**: January 2026
**Total Expenses to Migrate**: 166 transactions (IDR 466,910,781)
