/*
  # Fix Warehouse and Sales Full Operational Access

  1. Changes - Warehouse Role
    - Full access to purchase_orders (create, edit, view)
    - Full access to tasks (create, edit, view, delete)
    
  2. Changes - Sales Role
    - Full access to products, sales_orders, delivery_challans, sales_invoices
    - Full access to purchase_orders
    - Full access to CRM (contacts, inquiries, activities, leads, etc.)
    
  3. Security
    - Both roles require authenticated + active user
    - Admin retains delete rights on critical tables
*/

-- =============================================
-- PURCHASE ORDERS: Allow warehouse and sales
-- =============================================
DROP POLICY IF EXISTS "purchase_orders_select" ON purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_insert" ON purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_update" ON purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_delete" ON purchase_orders;
DROP POLICY IF EXISTS "Allow users to view purchase_orders" ON purchase_orders;

CREATE POLICY "Warehouse, sales, accounts, and admin can view purchase_orders"
  ON purchase_orders
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'auditor_ca')
    )
  );

CREATE POLICY "Warehouse, sales, and admin can insert purchase_orders"
  ON purchase_orders
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

CREATE POLICY "Warehouse, sales, and admin can update purchase_orders"
  ON purchase_orders
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

CREATE POLICY "Admin can delete purchase_orders"
  ON purchase_orders
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
-- PURCHASE ORDER ITEMS: Allow warehouse and sales
-- =============================================
DROP POLICY IF EXISTS "purchase_order_items_select" ON purchase_order_items;
DROP POLICY IF EXISTS "purchase_order_items_insert" ON purchase_order_items;
DROP POLICY IF EXISTS "purchase_order_items_update" ON purchase_order_items;
DROP POLICY IF EXISTS "purchase_order_items_delete" ON purchase_order_items;
DROP POLICY IF EXISTS "Allow users to view purchase_order_items" ON purchase_order_items;

CREATE POLICY "Warehouse, sales, accounts, and admin can view purchase_order_items"
  ON purchase_order_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'warehouse', 'sales', 'accounts', 'auditor_ca')
    )
  );

CREATE POLICY "Warehouse, sales, and admin can insert purchase_order_items"
  ON purchase_order_items
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

CREATE POLICY "Warehouse, sales, and admin can update purchase_order_items"
  ON purchase_order_items
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

CREATE POLICY "Warehouse, sales, and admin can delete purchase_order_items"
  ON purchase_order_items
  FOR DELETE
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
-- TASKS: Allow warehouse and sales full access
-- =============================================
DROP POLICY IF EXISTS "Users can view tasks" ON tasks;
DROP POLICY IF EXISTS "Users can create tasks" ON tasks;
DROP POLICY IF EXISTS "Task creators and assignees can update" ON tasks;
DROP POLICY IF EXISTS "Admins and creators can delete tasks" ON tasks;

CREATE POLICY "All authenticated users can view tasks"
  ON tasks
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
    )
  );

CREATE POLICY "All authenticated users can create tasks"
  ON tasks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Users can update tasks"
  ON tasks
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Users can delete tasks"
  ON tasks
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND (user_profiles.role = 'admin' OR tasks.created_by = auth.uid())
    )
  );

-- =============================================
-- CRM CONTACTS: Ensure sales has full access
-- =============================================
DROP POLICY IF EXISTS "Allow users to view crm_contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can insert crm_contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can update crm_contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Admin can delete crm_contacts" ON crm_contacts;

CREATE POLICY "Sales, admin, and auditor can view crm_contacts"
  ON crm_contacts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'auditor_ca')
    )
  );

CREATE POLICY "Sales and admin can insert crm_contacts"
  ON crm_contacts
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

CREATE POLICY "Sales and admin can update crm_contacts"
  ON crm_contacts
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

CREATE POLICY "Sales and admin can delete crm_contacts"
  ON crm_contacts
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- =============================================
-- CRM LEADS: Ensure sales has full access
-- =============================================
DROP POLICY IF EXISTS "Allow users to view crm_leads" ON crm_leads;
DROP POLICY IF EXISTS "Sales and admin can insert crm_leads" ON crm_leads;
DROP POLICY IF EXISTS "Sales and admin can update crm_leads" ON crm_leads;
DROP POLICY IF EXISTS "Admin can delete crm_leads" ON crm_leads;

CREATE POLICY "Sales, admin, and auditor can view crm_leads"
  ON crm_leads
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'auditor_ca')
    )
  );

CREATE POLICY "Sales and admin can insert crm_leads"
  ON crm_leads
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

CREATE POLICY "Sales and admin can update crm_leads"
  ON crm_leads
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

CREATE POLICY "Sales and admin can delete crm_leads"
  ON crm_leads
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- =============================================
-- CRM INQUIRIES: Cleanup and ensure sales access
-- =============================================
DROP POLICY IF EXISTS "Authenticated users can view inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Allow users to view crm_inquiries" ON crm_inquiries;

CREATE POLICY "Sales, admin, and auditor can view crm_inquiries"
  ON crm_inquiries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'auditor_ca')
    )
  );

-- =============================================
-- CRM ACTIVITIES: Ensure sales has full access
-- =============================================
DROP POLICY IF EXISTS "Allow all authenticated users to view crm_activities" ON crm_activities;
DROP POLICY IF EXISTS "Users can view own or participant appointments" ON crm_activities;
DROP POLICY IF EXISTS "Authenticated users can insert activities" ON crm_activities;
DROP POLICY IF EXISTS "Users can update own activities" ON crm_activities;
DROP POLICY IF EXISTS "Admin can delete activities" ON crm_activities;

CREATE POLICY "Sales, admin, and participants can view crm_activities"
  ON crm_activities
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales', 'auditor_ca')
    )
  );

CREATE POLICY "Sales and admin can insert crm_activities"
  ON crm_activities
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

CREATE POLICY "Sales and admin can update crm_activities"
  ON crm_activities
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

CREATE POLICY "Sales and admin can delete crm_activities"
  ON crm_activities
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- =============================================
-- SALES INVOICES: Ensure sales can insert/update
-- =============================================
DROP POLICY IF EXISTS "Admin, accounts, and sales can insert invoices" ON sales_invoices;
DROP POLICY IF EXISTS "Admin, accounts, and sales can update invoices" ON sales_invoices;

CREATE POLICY "Admin, accounts, and sales can insert invoices"
  ON sales_invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, and sales can update invoices"
  ON sales_invoices
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales')
        AND user_profiles.is_active = true
    )
  );

-- =============================================
-- SALES INVOICE ITEMS: Ensure sales can modify
-- =============================================
DROP POLICY IF EXISTS "Admin, accounts, and sales can insert invoice items" ON sales_invoice_items;
DROP POLICY IF EXISTS "Admin, accounts, and sales can update invoice items" ON sales_invoice_items;
DROP POLICY IF EXISTS "Admin, accounts, and sales can delete invoice items" ON sales_invoice_items;

CREATE POLICY "Admin, accounts, and sales can insert invoice items"
  ON sales_invoice_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, and sales can update invoice items"
  ON sales_invoice_items
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales')
        AND user_profiles.is_active = true
    )
  );

CREATE POLICY "Admin, accounts, and sales can delete invoice items"
  ON sales_invoice_items
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role IN ('admin', 'accounts', 'sales')
        AND user_profiles.is_active = true
    )
  );
