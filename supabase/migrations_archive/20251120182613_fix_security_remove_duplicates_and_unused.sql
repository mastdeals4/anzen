/*
  # Fix Security Issues - Remove Duplicates and Unused Indexes

  1. Purpose
    - Remove duplicate indexes that waste storage
    - Remove duplicate RLS policies that cause confusion
    - Drop unused indexes to improve write performance

  2. Changes
    - Drop duplicate indexes
    - Drop duplicate RLS policies (keep the most specific ones)
    - Drop unused indexes identified by Supabase analyzer
*/

-- Remove duplicate index (keep idx_inventory_transactions_product_id, drop the other)
DROP INDEX IF EXISTS idx_inventory_transactions_product;

-- Remove unused indexes to improve write performance
DROP INDEX IF EXISTS idx_inventory_transactions_reference;
DROP INDEX IF EXISTS idx_customer_payments_customer;
DROP INDEX IF EXISTS idx_vendor_payments_bill;
DROP INDEX IF EXISTS idx_vendor_bills_status;
DROP INDEX IF EXISTS idx_reminders_assigned;
DROP INDEX IF EXISTS idx_contacts_email;
DROP INDEX IF EXISTS idx_crm_quotations_customer_id;
DROP INDEX IF EXISTS idx_crm_quotations_status;
DROP INDEX IF EXISTS idx_contacts_type;
DROP INDEX IF EXISTS idx_email_activities_inquiry;
DROP INDEX IF EXISTS idx_crm_inquiries_status;
DROP INDEX IF EXISTS idx_crm_inquiries_date;
DROP INDEX IF EXISTS idx_crm_inquiries_company;
DROP INDEX IF EXISTS idx_crm_inquiries_assigned;
DROP INDEX IF EXISTS idx_crm_inquiries_next_followup;
DROP INDEX IF EXISTS idx_audit_logs_user_id;
DROP INDEX IF EXISTS idx_crm_activities_customer_id;
DROP INDEX IF EXISTS idx_crm_emails_customer_id;
DROP INDEX IF EXISTS idx_crm_emails_lead_id;
DROP INDEX IF EXISTS idx_crm_leads_assigned_to;
DROP INDEX IF EXISTS idx_customer_documents_customer_id;
DROP INDEX IF EXISTS idx_sales_invoices_customer_id;
DROP INDEX IF EXISTS idx_email_inbox_processed;
DROP INDEX IF EXISTS idx_domain_mapping_domain;
DROP INDEX IF EXISTS idx_domain_mapping_company;
DROP INDEX IF EXISTS idx_gmail_connections_sync;
DROP INDEX IF EXISTS idx_email_inbox_gmail_connection;
DROP INDEX IF EXISTS idx_email_inbox_message_id;
DROP INDEX IF EXISTS idx_quick_actions_inquiry;
DROP INDEX IF EXISTS idx_quick_actions_type;
DROP INDEX IF EXISTS idx_quick_actions_date;
DROP INDEX IF EXISTS idx_automation_rules_active;
DROP INDEX IF EXISTS idx_activity_logs_inquiry;
DROP INDEX IF EXISTS idx_activity_logs_type;
DROP INDEX IF EXISTS idx_activity_logs_date;
DROP INDEX IF EXISTS idx_timeline_inquiry;
DROP INDEX IF EXISTS idx_timeline_timestamp;
DROP INDEX IF EXISTS idx_timeline_type;
DROP INDEX IF EXISTS idx_crm_inquiries_source;

-- Remove duplicate RLS policies (keep the more specific ones)
DROP POLICY IF EXISTS "Admin can delete batch_documents" ON batch_documents;
DROP POLICY IF EXISTS "All users can view automation rules" ON crm_automation_rules;
DROP POLICY IF EXISTS "All users can view domain mappings" ON crm_company_domain_mapping;
DROP POLICY IF EXISTS "Users can view all contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Users can view email activities" ON crm_email_activities;
DROP POLICY IF EXISTS "Users can view email inbox" ON crm_email_inbox;
DROP POLICY IF EXISTS "Users can view email templates" ON crm_email_templates;
DROP POLICY IF EXISTS "Users can view all inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Users can view pipeline stages" ON crm_pipeline_stages;
DROP POLICY IF EXISTS "Users can view quotation items" ON crm_quotation_items;
DROP POLICY IF EXISTS "Users can view their reminders" ON crm_reminders;
DROP POLICY IF EXISTS "Authenticated users can delete delivery challan items" ON delivery_challan_items;
DROP POLICY IF EXISTS "Admin can delete expenses" ON finance_expenses;
DROP POLICY IF EXISTS "Admins can delete product files" ON product_files;
DROP POLICY IF EXISTS "Admin can delete invoice items" ON sales_invoice_items;
