/*
  # Add Foreign Key Indexes and Security Fixes

  1. Performance Improvements
    - Add indexes on all foreign key columns for optimal query performance
    - Remove unused indexes that are not being utilized
    
  2. Security Improvements
    - Drop and recreate the product_stock_summary view without SECURITY DEFINER
    - This prevents potential privilege escalation issues

  ## New Indexes Added (Foreign Keys)
    - audit_logs: user_id
    - batches: product_id
    - crm_activities: customer_id, lead_id
    - crm_emails: customer_id, lead_id
    - crm_leads: assigned_to
    - customer_documents: customer_id
    - delivery_challan_items: batch_id, challan_id, product_id
    - delivery_challans: customer_id
    - finance_expenses: batch_id
    - inventory_transactions: batch_id, product_id
    - product_files: product_id
    - sales_invoice_items: product_id
    - sales_invoices: customer_id

  ## Removed Indexes (Unused)
    - All indexes on created_by, uploaded_by, sent_by fields
    - idx_customers_company_name (unused)
    - idx_crm_leads_converted_to_customer (unused)

  Note: The Leaked Password Protection must be enabled manually in Supabase Auth settings
*/

-- Drop unused indexes
DROP INDEX IF EXISTS idx_products_created_by;
DROP INDEX IF EXISTS idx_product_files_uploaded_by;
DROP INDEX IF EXISTS idx_batch_documents_uploaded_by;
DROP INDEX IF EXISTS idx_customer_documents_uploaded_by;
DROP INDEX IF EXISTS idx_crm_leads_converted_to_customer;
DROP INDEX IF EXISTS idx_crm_leads_created_by;
DROP INDEX IF EXISTS idx_crm_activities_created_by;
DROP INDEX IF EXISTS idx_crm_emails_sent_by;
DROP INDEX IF EXISTS idx_finance_expenses_created_by;
DROP INDEX IF EXISTS idx_inventory_transactions_created_by;
DROP INDEX IF EXISTS idx_customers_company_name;
DROP INDEX IF EXISTS idx_customers_created_by;
DROP INDEX IF EXISTS idx_delivery_challans_created_by;
DROP INDEX IF EXISTS idx_sales_invoices_created_by;
DROP INDEX IF EXISTS idx_batches_created_by;

-- Add indexes for foreign keys to improve query performance

-- audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- batches
CREATE INDEX IF NOT EXISTS idx_batches_product_id ON batches(product_id);

-- crm_activities
CREATE INDEX IF NOT EXISTS idx_crm_activities_customer_id ON crm_activities(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_lead_id ON crm_activities(lead_id);

-- crm_emails
CREATE INDEX IF NOT EXISTS idx_crm_emails_customer_id ON crm_emails(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_emails_lead_id ON crm_emails(lead_id);

-- crm_leads
CREATE INDEX IF NOT EXISTS idx_crm_leads_assigned_to ON crm_leads(assigned_to);

-- customer_documents
CREATE INDEX IF NOT EXISTS idx_customer_documents_customer_id ON customer_documents(customer_id);

-- delivery_challan_items
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_batch_id ON delivery_challan_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_challan_id ON delivery_challan_items(challan_id);
CREATE INDEX IF NOT EXISTS idx_delivery_challan_items_product_id ON delivery_challan_items(product_id);

-- delivery_challans
CREATE INDEX IF NOT EXISTS idx_delivery_challans_customer_id ON delivery_challans(customer_id);

-- finance_expenses
CREATE INDEX IF NOT EXISTS idx_finance_expenses_batch_id ON finance_expenses(batch_id);

-- inventory_transactions
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_batch_id ON inventory_transactions(batch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_product_id ON inventory_transactions(product_id);

-- product_files
CREATE INDEX IF NOT EXISTS idx_product_files_product_id ON product_files(product_id);

-- sales_invoice_items
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_product_id ON sales_invoice_items(product_id);

-- sales_invoices
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer_id ON sales_invoices(customer_id);

-- Fix SECURITY DEFINER issue: Drop and recreate view without SECURITY DEFINER
DROP VIEW IF EXISTS product_stock_summary;

CREATE VIEW product_stock_summary AS
SELECT 
  p.id,
  p.product_name,
  p.product_code,
  COALESCE(SUM(b.current_stock), 0) as total_stock,
  COUNT(DISTINCT b.id) as batch_count,
  MIN(b.expiry_date) as earliest_expiry
FROM products p
LEFT JOIN batches b ON p.id = b.product_id
GROUP BY p.id, p.product_name, p.product_code;

-- Grant appropriate permissions to authenticated users
GRANT SELECT ON product_stock_summary TO authenticated;
