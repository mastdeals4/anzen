/*
  # Fix Security Issues - Optimize RLS Policies Part 1

  1. Purpose
    - Replace auth.uid() with (select auth.uid()) in RLS policies
    - Improves performance by evaluating once per query instead of per row
    - Follows Supabase best practices for RLS optimization

  2. Changes
    - Recreate policies for: batches, products, inventory_transactions
    - Recreate policies for: batch_documents, finance_expenses, product_files
    - Recreate policies for: delivery_challan_items, sales_invoice_items
*/

-- Batches
DROP POLICY IF EXISTS "Admin can delete batches" ON batches;
CREATE POLICY "Admin can delete batches"
  ON batches FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Products
DROP POLICY IF EXISTS "Admin can delete products" ON products;
CREATE POLICY "Admin can delete products"
  ON products FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Inventory Transactions
DROP POLICY IF EXISTS "Admin can delete inventory_transactions" ON inventory_transactions;
CREATE POLICY "Admin can delete inventory_transactions"
  ON inventory_transactions FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Batch Documents
DROP POLICY IF EXISTS "Admins can delete batch documents" ON batch_documents;
CREATE POLICY "Admins can delete batch documents"
  ON batch_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Finance Expenses
DROP POLICY IF EXISTS "Admin can delete finance_expenses" ON finance_expenses;
CREATE POLICY "Admin can delete finance_expenses"
  ON finance_expenses FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Product Files
DROP POLICY IF EXISTS "Admin can delete product_files" ON product_files;
CREATE POLICY "Admin can delete product_files"
  ON product_files FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Delivery Challan Items
DROP POLICY IF EXISTS "Admin can delete delivery_challan_items" ON delivery_challan_items;
CREATE POLICY "Admin can delete delivery_challan_items"
  ON delivery_challan_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- Sales Invoice Items
DROP POLICY IF EXISTS "Admin can delete sales_invoice_items" ON sales_invoice_items;
CREATE POLICY "Admin can delete sales_invoice_items"
  ON sales_invoice_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );
