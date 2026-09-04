/*
  # Restore Warehouse Full Operational Access

  1. Changes
    - Restore warehouse access to sales_invoices, sales_invoice_items
    - Restore warehouse access to import_requirements, import_containers
    - Restore warehouse access to purchase_orders, purchase_order_items
  
  2. Context
    - Warehouse staff create invoices, upload import products/batches
    - They need full operational access to all non-finance modules
*/

-- Sales Invoices: Add warehouse back
DROP POLICY IF EXISTS "Allow users to view sales_invoices" ON sales_invoices;
CREATE POLICY "Allow users to view sales_invoices"
  ON sales_invoices FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales', 'warehouse', 'auditor_ca')
    )
  );

-- Sales Invoice Items: Add warehouse back
DROP POLICY IF EXISTS "Allow users to view sales_invoice_items" ON sales_invoice_items;
CREATE POLICY "Allow users to view sales_invoice_items"
  ON sales_invoice_items FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales', 'warehouse', 'auditor_ca')
    )
  );

-- Import Requirements: Add warehouse back
DROP POLICY IF EXISTS "Allow users to view import_requirements" ON import_requirements;
CREATE POLICY "Allow users to view import_requirements"
  ON import_requirements FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'sales', 'auditor_ca')
    )
  );

-- Import Containers: Add warehouse back
DROP POLICY IF EXISTS "Allow users to view import_containers" ON import_containers;
CREATE POLICY "Allow users to view import_containers"
  ON import_containers FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'accounts', 'auditor_ca')
    )
  );

-- Purchase Orders: Add warehouse back
DROP POLICY IF EXISTS "Allow users to view purchase_orders" ON purchase_orders;
CREATE POLICY "Allow users to view purchase_orders"
  ON purchase_orders FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'accounts', 'auditor_ca')
    )
  );

-- Purchase Order Items: Add warehouse back
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'purchase_order_items') THEN
    DROP POLICY IF EXISTS "Allow users to view purchase_order_items" ON purchase_order_items;
    CREATE POLICY "Allow users to view purchase_order_items"
      ON purchase_order_items FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM user_profiles
          WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'accounts', 'auditor_ca')
        )
      );
  END IF;
END $$;
