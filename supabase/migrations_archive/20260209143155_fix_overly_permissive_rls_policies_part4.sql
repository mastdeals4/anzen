/*
  # Fix Overly Permissive RLS Policies - Part 4: Purchase Orders & Imports

  1. Purchase Order and Import Tables (10 tables)
     - Restrict to non-read-only users
*/

-- 1. purchase_orders
DROP POLICY IF EXISTS "purchase_orders_insert" ON purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_update" ON purchase_orders;

CREATE POLICY "purchase_orders_insert"
  ON purchase_orders FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "purchase_orders_update"
  ON purchase_orders FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 2. purchase_order_items
DROP POLICY IF EXISTS "purchase_order_items_insert" ON purchase_order_items;
DROP POLICY IF EXISTS "purchase_order_items_update" ON purchase_order_items;
DROP POLICY IF EXISTS "purchase_order_items_delete" ON purchase_order_items;

CREATE POLICY "purchase_order_items_insert"
  ON purchase_order_items FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "purchase_order_items_update"
  ON purchase_order_items FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "purchase_order_items_delete"
  ON purchase_order_items FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 3. purchase_invoices
DROP POLICY IF EXISTS "Authenticated users can manage purchase invoices" ON purchase_invoices;
CREATE POLICY "Authenticated users can manage purchase invoices"
  ON purchase_invoices FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 4. purchase_invoice_items
DROP POLICY IF EXISTS "Authenticated users can manage purchase invoice items" ON purchase_invoice_items;
CREATE POLICY "Authenticated users can manage purchase invoice items"
  ON purchase_invoice_items FOR ALL
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 5. import_containers
DROP POLICY IF EXISTS "Users can create import containers" ON import_containers;
CREATE POLICY "Users can create import containers"
  ON import_containers FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

-- 6. import_cost_headers
DROP POLICY IF EXISTS "import_cost_headers_insert" ON import_cost_headers;
DROP POLICY IF EXISTS "import_cost_headers_update" ON import_cost_headers;

CREATE POLICY "import_cost_headers_insert"
  ON import_cost_headers FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "import_cost_headers_update"
  ON import_cost_headers FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

-- 7. import_cost_items
DROP POLICY IF EXISTS "import_cost_items_insert" ON import_cost_items;
DROP POLICY IF EXISTS "import_cost_items_update" ON import_cost_items;
DROP POLICY IF EXISTS "import_cost_items_delete" ON import_cost_items;

CREATE POLICY "import_cost_items_insert"
  ON import_cost_items FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "import_cost_items_update"
  ON import_cost_items FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "import_cost_items_delete"
  ON import_cost_items FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());
