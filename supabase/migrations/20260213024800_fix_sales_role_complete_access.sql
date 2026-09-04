/*
  # Fix Sales Role - Complete Operational Access

  1. Changes - Sales Role
    - Add sales to batches (INSERT, UPDATE) - need to add new stock
    - Add sales to stock operations
    - Ensure sales can create/edit sales orders
    
  2. Security
    - Sales needs operational access to inventory and stock
    - Still requires authenticated + active user
*/

-- =============================================
-- BATCHES: Add sales role for INSERT and UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin and warehouse can insert batches" ON batches;
DROP POLICY IF EXISTS "Admin and warehouse can update batches" ON batches;

CREATE POLICY "Admin, warehouse, and sales can insert batches"
  ON batches
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, warehouse, and sales can update batches"
  ON batches
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- BATCH DOCUMENTS: Add sales role
-- =============================================
DROP POLICY IF EXISTS "Users can view batch documents" ON batch_documents;
DROP POLICY IF EXISTS "Users can insert batch documents" ON batch_documents;
DROP POLICY IF EXISTS "Users can delete batch documents" ON batch_documents;

CREATE POLICY "Users can view batch documents"
  ON batch_documents
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'auditor_ca')
    )
  );

CREATE POLICY "Admin, warehouse, and sales can insert batch documents"
  ON batch_documents
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, warehouse, and sales can delete batch documents"
  ON batch_documents
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales')
    )
  );

-- =============================================
-- SALES ORDERS: Ensure sales can INSERT/UPDATE
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert sales_orders" ON sales_orders;
DROP POLICY IF EXISTS "Admin and sales can update sales_orders" ON sales_orders;
DROP POLICY IF EXISTS "Admin can delete sales_orders" ON sales_orders;

CREATE POLICY "Admin and sales can insert sales_orders"
  ON sales_orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can update sales_orders"
  ON sales_orders
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin can delete sales_orders"
  ON sales_orders
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role = 'admin'
    )
  );

-- =============================================
-- SALES ORDER ITEMS: Ensure sales can modify
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert sales_order_items" ON sales_order_items;
DROP POLICY IF EXISTS "Admin and sales can update sales_order_items" ON sales_order_items;
DROP POLICY IF EXISTS "Admin and sales can delete sales_order_items" ON sales_order_items;

CREATE POLICY "Admin and sales can insert sales_order_items"
  ON sales_order_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can update sales_order_items"
  ON sales_order_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can delete sales_order_items"
  ON sales_order_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- CREDIT NOTES: Ensure sales can create/edit
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert credit_notes" ON credit_notes;
DROP POLICY IF EXISTS "Admin and sales can update credit_notes" ON credit_notes;

CREATE POLICY "Admin and sales can insert credit_notes"
  ON credit_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can update credit_notes"
  ON credit_notes
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- CREDIT NOTE ITEMS: Ensure sales can modify
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can insert credit_note_items" ON credit_note_items;
DROP POLICY IF EXISTS "Admin and sales can update credit_note_items" ON credit_note_items;
DROP POLICY IF EXISTS "Admin and sales can delete credit_note_items" ON credit_note_items;

CREATE POLICY "Admin and sales can insert credit_note_items"
  ON credit_note_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can update credit_note_items"
  ON credit_note_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin and sales can delete credit_note_items"
  ON credit_note_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
        AND user_profiles.is_active = true
    )
  );
