/*
  # Pharma Raw Material Trading Management System - Complete Database Schema

  ## Overview
  This migration creates a comprehensive database schema for managing a pharma raw material trading business.
  
  ## New Tables Created

  ### 1. User Management
  - `user_profiles` - Extended user profile with role-based access control
    - Links to auth.users for authentication
    - Roles: admin, accounts, sales, warehouse
    - Language preference and active status

  ### 2. Product Management
  - `products` - Product master data
    - Product name, code, HSN code, category, unit, packaging type
    - Default supplier, description, created/updated timestamps
  - `product_files` - Multiple file attachments per product
    - File URL, name, type (MSDS, COA, test_report, other)
    - Uploaded date and file size

  ### 3. Batch & Inventory
  - `batches` - Import batch tracking
    - Batch number, linked product, import date, quantity
    - Packaging details, cost breakdown (import price, duty, freight, other charges)
    - Expiry date, warehouse location, current stock
  - `batch_documents` - Import documents per batch
    - File URL, name, type (invoice, bill_of_lading, coa, other)
  - `inventory_transactions` - Stock movement history
    - Transaction type (purchase, sale, adjustment)
    - Quantity change, reference (invoice/batch), notes

  ### 4. Customer Management
  - `customers` - Customer master data
    - Company name, NPWP (tax ID), address, contact details
    - GST/VAT type, payment terms, status
  - `customer_documents` - Customer file attachments

  ### 5. CRM System
  - `crm_leads` - Lead/prospect tracking
    - Company name, contact details, product interest, quantity, source
    - Status workflow (inquiry, quotation, negotiation, won, lost)
    - Assigned staff, expected close date
  - `crm_activities` - Activity log for leads/customers
    - Activity type (call, email, meeting, note)
    - Follow-up dates, completed status
  - `crm_emails` - Outbound email tracking
    - Recipient, subject, body, sent date, related lead/customer

  ### 6. Sales Management
  - `sales_invoices` - Sales invoice header
    - Invoice number, customer, invoice date, due date
    - Subtotal, tax, discount, total amount
    - Payment status (pending, partial, paid), delivery challan number
  - `sales_invoice_items` - Invoice line items
    - Product, batch, quantity, unit price, tax rate, total

  ### 7. Finance
  - `finance_expenses` - Operational expense tracking
    - Expense category (duty, freight, warehouse_rent, utilities, salary, other)
    - Amount, date, description, related batch

  ### 8. Configuration
  - `app_settings` - Application settings
    - Company profile, tax rates, invoice prefix, email settings
    - Low stock threshold, expiry alert days, default language

  ### 9. Audit Log
  - `audit_logs` - Track sensitive operations
    - User, table name, action type, record ID, old/new values

  ## Security
  - Enable RLS on all tables
  - Create role-based policies for each table
  - Admins have full access
  - Accounts can access finance, sales, invoices, customers
  - Sales can access CRM, customers, leads, products
  - Warehouse can access inventory, batches, products

  ## Storage Buckets
  - product_files - For MSDS, COA, test reports
  - batch_documents - For import paperwork
  - customer_documents - For customer files

  ## Indexes
  - Created on foreign keys and commonly queried fields
  - Full-text search indexes on product names, customer names
*/

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ======================
-- USER PROFILES
-- ======================
CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text UNIQUE NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'accounts', 'sales', 'warehouse')),
  language text DEFAULT 'en' CHECK (language IN ('en', 'id')),
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_is_active ON user_profiles(is_active);

-- ======================
-- PRODUCTS
-- ======================
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  product_code text UNIQUE NOT NULL,
  hsn_code text,
  category text NOT NULL CHECK (category IN ('api', 'excipient', 'solvent', 'other')),
  unit text NOT NULL CHECK (unit IN ('kg', 'litre', 'ton', 'piece')),
  packaging_type text,
  default_supplier text,
  description text,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_code ON products(product_code);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_name_search ON products USING gin(to_tsvector('english', product_name));

-- ======================
-- PRODUCT FILES
-- ======================
CREATE TABLE IF NOT EXISTS product_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('msds', 'coa', 'test_report', 'other')),
  file_size bigint,
  uploaded_by uuid REFERENCES user_profiles(id),
  uploaded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_files_product ON product_files(product_id);

-- ======================
-- BATCHES
-- ======================
CREATE TABLE IF NOT EXISTS batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number text UNIQUE NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  import_date date NOT NULL,
  import_quantity numeric(15,3) NOT NULL,
  current_stock numeric(15,3) NOT NULL,
  packaging_details text,
  import_price numeric(15,2) NOT NULL,
  duty_charges numeric(15,2) DEFAULT 0,
  freight_charges numeric(15,2) DEFAULT 0,
  other_charges numeric(15,2) DEFAULT 0,
  total_cost numeric(15,2) GENERATED ALWAYS AS (import_price + duty_charges + freight_charges + other_charges) STORED,
  cost_per_unit numeric(15,4) GENERATED ALWAYS AS ((import_price + duty_charges + freight_charges + other_charges) / NULLIF(import_quantity, 0)) STORED,
  expiry_date date,
  warehouse_location text,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_number ON batches(batch_number);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_batches_is_active ON batches(is_active);

-- ======================
-- BATCH DOCUMENTS
-- ======================
CREATE TABLE IF NOT EXISTS batch_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('invoice', 'bill_of_lading', 'coa', 'packing_list', 'other')),
  file_size bigint,
  uploaded_by uuid REFERENCES user_profiles(id),
  uploaded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_batch_documents_batch ON batch_documents(batch_id);

-- ======================
-- CUSTOMERS
-- ======================
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_name text NOT NULL,
  company_name text NOT NULL,
  npwp text,
  address text,
  city text,
  country text DEFAULT 'Indonesia',
  contact_person text,
  email text,
  phone text,
  gst_vat_type text,
  payment_terms text,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(customer_name);
CREATE INDEX IF NOT EXISTS idx_customers_company ON customers(company_name);
CREATE INDEX IF NOT EXISTS idx_customers_is_active ON customers(is_active);
CREATE INDEX IF NOT EXISTS idx_customers_name_search ON customers USING gin(to_tsvector('english', customer_name || ' ' || company_name));

-- ======================
-- CUSTOMER DOCUMENTS
-- ======================
CREATE TABLE IF NOT EXISTS customer_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text DEFAULT 'other',
  file_size bigint,
  uploaded_by uuid REFERENCES user_profiles(id),
  uploaded_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_documents_customer ON customer_documents(customer_id);

-- ======================
-- CRM LEADS
-- ======================
CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  contact_person text NOT NULL,
  email text,
  phone text,
  product_interest text,
  quantity_interest text,
  lead_source text CHECK (lead_source IN ('website', 'referral', 'trade_show', 'cold_call', 'email', 'other')),
  status text NOT NULL DEFAULT 'inquiry' CHECK (status IN ('inquiry', 'quotation', 'negotiation', 'won', 'lost')),
  assigned_to uuid REFERENCES user_profiles(id),
  expected_close_date date,
  estimated_value numeric(15,2),
  notes text,
  converted_to_customer uuid REFERENCES customers(id),
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status);
CREATE INDEX IF NOT EXISTS idx_crm_leads_assigned ON crm_leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_leads_company_search ON crm_leads USING gin(to_tsvector('english', company_name));

-- ======================
-- CRM ACTIVITIES
-- ======================
CREATE TABLE IF NOT EXISTS crm_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES crm_leads(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('call', 'email', 'meeting', 'note', 'follow_up')),
  subject text NOT NULL,
  description text,
  follow_up_date timestamptz,
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_lead ON crm_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_customer ON crm_activities(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_follow_up ON crm_activities(follow_up_date) WHERE is_completed = false;

-- ======================
-- CRM EMAILS
-- ======================
CREATE TABLE IF NOT EXISTS crm_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES crm_leads(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  sent_date timestamptz DEFAULT now(),
  sent_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_emails_lead ON crm_emails(lead_id);
CREATE INDEX IF NOT EXISTS idx_crm_emails_customer ON crm_emails(customer_id);

-- ======================
-- SALES INVOICES
-- ======================
CREATE TABLE IF NOT EXISTS sales_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text UNIQUE NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id),
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  subtotal numeric(15,2) NOT NULL DEFAULT 0,
  tax_amount numeric(15,2) NOT NULL DEFAULT 0,
  discount_amount numeric(15,2) DEFAULT 0,
  total_amount numeric(15,2) NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'partial', 'paid')),
  delivery_challan_number text,
  notes text,
  is_draft boolean DEFAULT false,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_number ON sales_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer ON sales_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_date ON sales_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_status ON sales_invoices(payment_status);

-- ======================
-- SALES INVOICE ITEMS
-- ======================
CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  quantity numeric(15,3) NOT NULL,
  unit_price numeric(15,2) NOT NULL,
  tax_rate numeric(5,2) DEFAULT 0,
  tax_amount numeric(15,2) GENERATED ALWAYS AS ((quantity * unit_price * tax_rate / 100)) STORED,
  line_total numeric(15,2) GENERATED ALWAYS AS ((quantity * unit_price) + (quantity * unit_price * tax_rate / 100)) STORED,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_invoice ON sales_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_product ON sales_invoice_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_batch ON sales_invoice_items(batch_id);

-- ======================
-- INVENTORY TRANSACTIONS
-- ======================
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  transaction_type text NOT NULL CHECK (transaction_type IN ('purchase', 'sale', 'adjustment', 'return')),
  quantity_change numeric(15,3) NOT NULL,
  reference_type text,
  reference_id uuid,
  notes text,
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_transactions_batch ON inventory_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_type ON inventory_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_date ON inventory_transactions(created_at);

-- ======================
-- FINANCE EXPENSES
-- ======================
CREATE TABLE IF NOT EXISTS finance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_category text NOT NULL CHECK (expense_category IN ('duty', 'freight', 'warehouse_rent', 'utilities', 'salary', 'office', 'other')),
  amount numeric(15,2) NOT NULL,
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  description text,
  batch_id uuid REFERENCES batches(id),
  created_by uuid REFERENCES user_profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_expenses_category ON finance_expenses(expense_category);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_date ON finance_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_finance_expenses_batch ON finance_expenses(batch_id);

-- ======================
-- APP SETTINGS
-- ======================
CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL DEFAULT 'Your Company Name',
  company_address text,
  company_phone text,
  company_email text,
  company_tax_id text,
  company_logo_url text,
  default_tax_rate numeric(5,2) DEFAULT 0,
  invoice_prefix text DEFAULT 'INV',
  default_language text DEFAULT 'en' CHECK (default_language IN ('en', 'id')),
  low_stock_threshold numeric(15,3) DEFAULT 100,
  expiry_alert_days integer DEFAULT 90,
  smtp_host text,
  smtp_port integer,
  smtp_username text,
  smtp_password text,
  smtp_from_email text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Insert default settings
INSERT INTO app_settings (company_name) VALUES ('Pharma Trading Company')
ON CONFLICT DO NOTHING;

-- ======================
-- AUDIT LOGS
-- ======================
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES user_profiles(id),
  table_name text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('insert', 'update', 'delete')),
  record_id uuid,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_table ON audit_logs(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_date ON audit_logs(created_at);

-- ======================
-- ROW LEVEL SECURITY
-- ======================

-- User Profiles
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Admins can view all profiles"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Admins can insert profiles"
  ON user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Admins can update profiles"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Products
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view products"
  ON products FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin and sales can insert products"
  ON products FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales', 'warehouse')
    )
  );

CREATE POLICY "Admin and sales can update products"
  ON products FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales', 'warehouse')
    )
  );

CREATE POLICY "Admin can delete products"
  ON products FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Product Files
ALTER TABLE product_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view product files"
  ON product_files FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert product files"
  ON product_files FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

CREATE POLICY "Admins can delete product files"
  ON product_files FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Batches
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view batches"
  ON batches FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin and warehouse can insert batches"
  ON batches FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'accounts')
    )
  );

CREATE POLICY "Admin and warehouse can update batches"
  ON batches FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'warehouse', 'accounts')
    )
  );

CREATE POLICY "Admin can delete batches"
  ON batches FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Batch Documents
ALTER TABLE batch_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view batch documents"
  ON batch_documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert batch documents"
  ON batch_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

CREATE POLICY "Admins can delete batch documents"
  ON batch_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Customers
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view customers"
  ON customers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin, accounts, and sales can insert customers"
  ON customers FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin, accounts, and sales can update customers"
  ON customers FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin can delete customers"
  ON customers FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Customer Documents
ALTER TABLE customer_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view customer documents"
  ON customer_documents FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert customer documents"
  ON customer_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

CREATE POLICY "Admins can delete customer documents"
  ON customer_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- CRM Leads
ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin and sales can view all leads"
  ON crm_leads FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin and sales can insert leads"
  ON crm_leads FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin and sales can update leads"
  ON crm_leads FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin can delete leads"
  ON crm_leads FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- CRM Activities
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin and sales can view activities"
  ON crm_activities FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales', 'accounts')
    )
  );

CREATE POLICY "Authenticated users can insert activities"
  ON crm_activities FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

CREATE POLICY "Users can update own activities"
  ON crm_activities FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid());

CREATE POLICY "Admin can delete activities"
  ON crm_activities FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- CRM Emails
ALTER TABLE crm_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin and sales can view emails"
  ON crm_emails FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'sales', 'accounts')
    )
  );

CREATE POLICY "Authenticated users can insert emails"
  ON crm_emails FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Sales Invoices
ALTER TABLE sales_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view invoices"
  ON sales_invoices FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin, accounts, and sales can insert invoices"
  ON sales_invoices FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin, accounts, and sales can update invoices"
  ON sales_invoices FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin can delete invoices"
  ON sales_invoices FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Sales Invoice Items
ALTER TABLE sales_invoice_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view invoice items"
  ON sales_invoice_items FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin, accounts, and sales can insert invoice items"
  ON sales_invoice_items FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin, accounts, and sales can update invoice items"
  ON sales_invoice_items FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts', 'sales')
    )
  );

CREATE POLICY "Admin can delete invoice items"
  ON sales_invoice_items FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Inventory Transactions
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view transactions"
  ON inventory_transactions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert transactions"
  ON inventory_transactions FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid()
    )
  );

-- Finance Expenses
ALTER TABLE finance_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin and accounts can view expenses"
  ON finance_expenses FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admin and accounts can insert expenses"
  ON finance_expenses FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admin and accounts can update expenses"
  ON finance_expenses FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts')
    )
  );

CREATE POLICY "Admin can delete expenses"
  ON finance_expenses FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- App Settings
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "All authenticated users can view settings"
  ON app_settings FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin can update settings"
  ON app_settings FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Audit Logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin can view audit logs"
  ON audit_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "System can insert audit logs"
  ON audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (true);
