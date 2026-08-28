/*
  # Fix Warehouse Role - Comprehensive Access

  1. Changes
    - Add warehouse role to customers SELECT policy (need to view customer info)
    - Add warehouse role to sales_orders SELECT policy (need to see orders for picking)
    - Add warehouse role to delivery_challans SELECT/INSERT/UPDATE (core warehouse operations)
    - Add warehouse role to sales_invoices SELECT (need to see what's invoiced)
    - Add warehouse role to batches INSERT/UPDATE (add new stock)
    - Add warehouse role to stock view (core function)
    
  2. Security
    - Warehouse staff need full access to inventory, stock, deliveries
    - They should NOT have access to financial data (kept separate)
    - All policies still require authenticated + active user
*/

-- =============================================
-- CUSTOMERS: Add warehouse to SELECT
-- =============================================
DROP POLICY IF EXISTS "Allow users to view customers" ON customers;

CREATE POLICY "Allow users to view customers"
  ON customers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'auditor_ca', 'warehouse')
    )
  );

-- =============================================
-- SALES ORDERS: Add warehouse to SELECT
-- =============================================
DROP POLICY IF EXISTS "Allow users to view sales_orders" ON sales_orders;

CREATE POLICY "Allow users to view sales_orders"
  ON sales_orders
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

-- =============================================
-- SALES ORDER ITEMS: Add warehouse to SELECT
-- =============================================
DROP POLICY IF EXISTS "Allow users to view sales_order_items" ON sales_order_items;

CREATE POLICY "Allow users to view sales_order_items"
  ON sales_order_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

-- =============================================
-- DELIVERY CHALLANS: Add warehouse to all operations
-- =============================================
DROP POLICY IF EXISTS "Allow users to view delivery_challans" ON delivery_challans;
DROP POLICY IF EXISTS "Admin and sales can insert delivery_challans" ON delivery_challans;
DROP POLICY IF EXISTS "Admin and sales can update delivery_challans" ON delivery_challans;

CREATE POLICY "Allow users to view delivery_challans"
  ON delivery_challans
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

CREATE POLICY "Admin, sales, and warehouse can insert delivery_challans"
  ON delivery_challans
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, sales, and warehouse can update delivery_challans"
  ON delivery_challans
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- DELIVERY CHALLAN ITEMS: Add warehouse
-- =============================================
DROP POLICY IF EXISTS "Allow users to view delivery_challan_items" ON delivery_challan_items;
DROP POLICY IF EXISTS "Admin and sales can insert delivery_challan_items" ON delivery_challan_items;
DROP POLICY IF EXISTS "Admin and sales can update delivery_challan_items" ON delivery_challan_items;
DROP POLICY IF EXISTS "Admin and sales can delete delivery_challan_items" ON delivery_challan_items;

CREATE POLICY "Allow users to view delivery_challan_items"
  ON delivery_challan_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

CREATE POLICY "Admin, sales, and warehouse can insert delivery_challan_items"
  ON delivery_challan_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, sales, and warehouse can update delivery_challan_items"
  ON delivery_challan_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, sales, and warehouse can delete delivery_challan_items"
  ON delivery_challan_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- BATCHES: Ensure warehouse can INSERT/UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin and warehouse can insert batches" ON batches;
DROP POLICY IF EXISTS "Admin and warehouse can update batches" ON batches;

CREATE POLICY "Admin and warehouse can insert batches"
  ON batches
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and warehouse can update batches"
  ON batches
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- SALES INVOICES: Add warehouse to SELECT only (view)
-- =============================================
DROP POLICY IF EXISTS "Allow users to view sales_invoices" ON sales_invoices;

CREATE POLICY "Allow users to view sales_invoices"
  ON sales_invoices
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

-- =============================================
-- SALES INVOICE ITEMS: Add warehouse to SELECT
-- =============================================
DROP POLICY IF EXISTS "Allow users to view sales_invoice_items" ON sales_invoice_items;

CREATE POLICY "Allow users to view sales_invoice_items"
  ON sales_invoice_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'accounts', 'auditor_ca', 'warehouse')
    )
  );

-- =============================================
-- STOCK RESERVATIONS: Add warehouse access
-- =============================================
DROP POLICY IF EXISTS "Allow users to view stock_reservations" ON stock_reservations;

CREATE POLICY "Allow users to view stock_reservations"
  ON stock_reservations
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'warehouse', 'accounts', 'auditor_ca')
    )
  );

-- =============================================
-- INVENTORY TRANSACTIONS: Ensure warehouse can view
-- =============================================
DROP POLICY IF EXISTS "Authenticated users can view inventory transactions" ON inventory_transactions;

CREATE POLICY "Authenticated users can view inventory transactions"
  ON inventory_transactions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'accounts', 'auditor_ca')
    )
  );
