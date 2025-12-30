/*
  # Remove Duplicate Permissive Policies

  This migration removes duplicate permissive RLS policies that can cause conflicts and performance issues.
  Multiple permissive policies for the same action should be consolidated into a single policy.

  ## Changes
  
  Removes duplicate SELECT policies from:
  - accounting_periods
  - bank_reconciliation_items
  - bank_reconciliations
  - chart_of_accounts
  - journal_entries
  - journal_entry_lines
  - organization_tax_settings
  - payment_vouchers
  - petty_cash_books
  - petty_cash_files
  - petty_cash_vouchers
  - purchase_invoice_items
  - purchase_invoices
  - receipt_vouchers
  - suppliers
  - tax_codes
  - voucher_allocations
  
  Removes duplicate policies from:
  - approval_thresholds (SELECT)
  - import_requirements (SELECT)
  - material_return_items (SELECT)
  - material_returns (UPDATE)
  - sales_order_items (SELECT)
  - sales_orders (UPDATE)
  - stock_rejections (UPDATE)
  - stock_reservations (SELECT)
  - tasks (SELECT)
*/

-- Accounting & Finance Tables - Keep "Allow read for authenticated" and remove duplicates
DROP POLICY IF EXISTS "Allow write for authenticated" ON accounting_periods;
DROP POLICY IF EXISTS "Allow write for authenticated" ON bank_reconciliation_items;
DROP POLICY IF EXISTS "Allow write for authenticated" ON bank_reconciliations;
DROP POLICY IF EXISTS "Allow write for authenticated" ON chart_of_accounts;
DROP POLICY IF EXISTS "Allow write for authenticated" ON journal_entries;
DROP POLICY IF EXISTS "Allow write for authenticated" ON journal_entry_lines;
DROP POLICY IF EXISTS "Allow write for authenticated" ON organization_tax_settings;
DROP POLICY IF EXISTS "Allow write for authenticated" ON payment_vouchers;
DROP POLICY IF EXISTS "Allow write for authenticated" ON petty_cash_books;
DROP POLICY IF EXISTS "Allow write for authenticated" ON petty_cash_files;
DROP POLICY IF EXISTS "Allow write for authenticated" ON petty_cash_vouchers;
DROP POLICY IF EXISTS "Allow write for authenticated" ON purchase_invoice_items;
DROP POLICY IF EXISTS "Allow write for authenticated" ON purchase_invoices;
DROP POLICY IF EXISTS "Allow write for authenticated" ON receipt_vouchers;
DROP POLICY IF EXISTS "Allow write for authenticated" ON suppliers;
DROP POLICY IF EXISTS "Allow write for authenticated" ON tax_codes;
DROP POLICY IF EXISTS "Allow write for authenticated" ON voucher_allocations;

-- Approval thresholds - Keep specific role-based policy
DROP POLICY IF EXISTS "Users can view approval thresholds" ON approval_thresholds;

-- Import requirements - Keep specific role-based policy
DROP POLICY IF EXISTS "Admins can manage import requirements" ON import_requirements;

-- Material return items - Keep the more permissive one
DROP POLICY IF EXISTS "Users can view material return items" ON material_return_items;

-- Material returns - Already fixed in previous migration, but ensure duplicates removed
DROP POLICY IF EXISTS "Managers can update material returns" ON material_returns;

-- Sales order items - Keep the more permissive one
DROP POLICY IF EXISTS "Users can view sales order items" ON sales_order_items;

-- Sales orders - Already fixed in previous migration
DROP POLICY IF EXISTS "Admins and sales can update all sales orders" ON sales_orders;

-- Stock rejections - Already fixed in previous migration
DROP POLICY IF EXISTS "Managers can update stock rejections" ON stock_rejections;

-- Stock reservations - Keep specific one
DROP POLICY IF EXISTS "System can manage stock reservations" ON stock_reservations;

-- Tasks - Keep admin policy as it's more comprehensive
DROP POLICY IF EXISTS "Users can view assigned tasks" ON tasks;
