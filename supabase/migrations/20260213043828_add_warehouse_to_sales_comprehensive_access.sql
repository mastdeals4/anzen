/*
  # Add Warehouse to All Sales Operations

  1. Changes
    - Add warehouse to sales_orders (INSERT, UPDATE)
    - Add warehouse to customers (INSERT, UPDATE)
    - Add warehouse to sales_invoices (INSERT, UPDATE)
    - Add warehouse to all related item tables
    
  2. Security
    - Warehouse needs full operational access
    - Still requires authenticated + active user
*/

-- =============================================
-- SALES ORDERS: Add warehouse to INSERT/UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert sales_orders" ON sales_orders;
DROP POLICY IF EXISTS "Admin and sales can update sales_orders" ON sales_orders;

CREATE POLICY "Admin, sales, and warehouse can insert sales_orders"
  ON sales_orders
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

CREATE POLICY "Admin, sales, and warehouse can update sales_orders"
  ON sales_orders
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
-- SALES ORDER ITEMS: Add warehouse
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert sales_order_items" ON sales_order_items;
DROP POLICY IF EXISTS "Admin and sales can update sales_order_items" ON sales_order_items;
DROP POLICY IF EXISTS "Admin and sales can delete sales_order_items" ON sales_order_items;

CREATE POLICY "Admin, sales, and warehouse can insert sales_order_items"
  ON sales_order_items
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

CREATE POLICY "Admin, sales, and warehouse can update sales_order_items"
  ON sales_order_items
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

CREATE POLICY "Admin, sales, and warehouse can delete sales_order_items"
  ON sales_order_items
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
-- CUSTOMERS: Add warehouse to INSERT/UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin, accounts, and sales can insert customers" ON customers;
DROP POLICY IF EXISTS "Admin, accounts, and sales can update customers" ON customers;

CREATE POLICY "Admin, accounts, sales, and warehouse can insert customers"
  ON customers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, sales, and warehouse can update customers"
  ON customers
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- SALES INVOICES: Add warehouse to INSERT/UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin, accounts, and sales can insert invoices" ON sales_invoices;
DROP POLICY IF EXISTS "Admin, accounts, and sales can update invoices" ON sales_invoices;

CREATE POLICY "Admin, accounts, sales, and warehouse can insert invoices"
  ON sales_invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, sales, and warehouse can update invoices"
  ON sales_invoices
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- SALES INVOICE ITEMS: Add warehouse
-- =============================================
DROP POLICY IF EXISTS "Admin, accounts, and sales can insert invoice items" ON sales_invoice_items;
DROP POLICY IF EXISTS "Admin, accounts, and sales can update invoice items" ON sales_invoice_items;
DROP POLICY IF EXISTS "Admin, accounts, and sales can delete invoice items" ON sales_invoice_items;

CREATE POLICY "Admin, accounts, sales, and warehouse can insert invoice items"
  ON sales_invoice_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, sales, and warehouse can update invoice items"
  ON sales_invoice_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, sales, and warehouse can delete invoice items"
  ON sales_invoice_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales', 'warehouse')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- CREDIT NOTES: Add warehouse
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert credit_notes" ON credit_notes;
DROP POLICY IF EXISTS "Admin and sales can update credit_notes" ON credit_notes;

CREATE POLICY "Admin, sales, and warehouse can insert credit_notes"
  ON credit_notes
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

CREATE POLICY "Admin, sales, and warehouse can update credit_notes"
  ON credit_notes
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
-- CREDIT NOTE ITEMS: Add warehouse
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert credit_note_items" ON credit_note_items;
DROP POLICY IF EXISTS "Admin and sales can update credit_note_items" ON credit_note_items;
DROP POLICY IF EXISTS "Admin and sales can delete credit_note_items" ON credit_note_items;

CREATE POLICY "Admin, sales, and warehouse can insert credit_note_items"
  ON credit_note_items
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

CREATE POLICY "Admin, sales, and warehouse can update credit_note_items"
  ON credit_note_items
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

CREATE POLICY "Admin, sales, and warehouse can delete credit_note_items"
  ON credit_note_items
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
