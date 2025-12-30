/*
  # Fix Security Issues - Add Foreign Key Indexes

  1. Purpose
    - Add missing indexes on foreign key columns for performance
    - Improve query performance when joining tables
    - Prevent table scans on foreign key lookups

  2. Changes
    - Create indexes on all unindexed foreign key columns
    - Improves JOIN performance and foreign key constraint checks
*/

-- Bank Accounts
CREATE INDEX IF NOT EXISTS idx_bank_accounts_created_by ON bank_accounts(created_by);

-- Batch Documents
CREATE INDEX IF NOT EXISTS idx_batch_documents_uploaded_by ON batch_documents(uploaded_by);

-- Batches
CREATE INDEX IF NOT EXISTS idx_batches_created_by ON batches(created_by);

-- CRM Activities
CREATE INDEX IF NOT EXISTS idx_crm_activities_created_by ON crm_activities(created_by);

-- CRM Activity Logs
CREATE INDEX IF NOT EXISTS idx_crm_activity_logs_contact_id ON crm_activity_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_activity_logs_created_by ON crm_activity_logs(created_by);

-- CRM Automation Rules
CREATE INDEX IF NOT EXISTS idx_crm_automation_rules_created_by ON crm_automation_rules(created_by);

-- CRM Company Domain Mapping
CREATE INDEX IF NOT EXISTS idx_crm_company_domain_mapping_created_by ON crm_company_domain_mapping(created_by);
CREATE INDEX IF NOT EXISTS idx_crm_company_domain_mapping_primary_contact_id ON crm_company_domain_mapping(primary_contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_company_domain_mapping_verified_by ON crm_company_domain_mapping(verified_by);

-- CRM Contacts
CREATE INDEX IF NOT EXISTS idx_crm_contacts_created_by ON crm_contacts(created_by);

-- CRM Email Activities
CREATE INDEX IF NOT EXISTS idx_crm_email_activities_contact_id ON crm_email_activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_email_activities_created_by ON crm_email_activities(created_by);
CREATE INDEX IF NOT EXISTS idx_crm_email_activities_template_id ON crm_email_activities(template_id);

-- CRM Email Inbox
CREATE INDEX IF NOT EXISTS idx_crm_email_inbox_assigned_to ON crm_email_inbox(assigned_to);
CREATE INDEX IF NOT EXISTS idx_crm_email_inbox_converted_to_inquiry ON crm_email_inbox(converted_to_inquiry);

-- CRM Email Templates
CREATE INDEX IF NOT EXISTS idx_crm_email_templates_created_by ON crm_email_templates(created_by);

-- CRM Emails
CREATE INDEX IF NOT EXISTS idx_crm_emails_sent_by ON crm_emails(sent_by);

-- CRM Inquiries
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_created_by ON crm_inquiries(created_by);

-- CRM Inquiry Timeline
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_timeline_performed_by ON crm_inquiry_timeline(performed_by);
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_timeline_related_action_id ON crm_inquiry_timeline(related_action_id);
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_timeline_related_activity_id ON crm_inquiry_timeline(related_activity_id);
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_timeline_related_email_id ON crm_inquiry_timeline(related_email_id);

-- CRM Leads
CREATE INDEX IF NOT EXISTS idx_crm_leads_converted_to_customer ON crm_leads(converted_to_customer);
CREATE INDEX IF NOT EXISTS idx_crm_leads_created_by ON crm_leads(created_by);

-- CRM Quick Actions Log
CREATE INDEX IF NOT EXISTS idx_crm_quick_actions_log_contact_id ON crm_quick_actions_log(contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_quick_actions_log_follow_up_reminder_id ON crm_quick_actions_log(follow_up_reminder_id);
CREATE INDEX IF NOT EXISTS idx_crm_quick_actions_log_performed_by ON crm_quick_actions_log(performed_by);
CREATE INDEX IF NOT EXISTS idx_crm_quick_actions_log_template_used ON crm_quick_actions_log(template_used);

-- CRM Quotation Items
CREATE INDEX IF NOT EXISTS idx_crm_quotation_items_product_id ON crm_quotation_items(product_id);

-- CRM Quotations
CREATE INDEX IF NOT EXISTS idx_crm_quotations_created_by ON crm_quotations(created_by);

-- CRM Reminders
CREATE INDEX IF NOT EXISTS idx_crm_reminders_completed_by ON crm_reminders(completed_by);
CREATE INDEX IF NOT EXISTS idx_crm_reminders_created_by ON crm_reminders(created_by);
CREATE INDEX IF NOT EXISTS idx_crm_reminders_inquiry_id ON crm_reminders(inquiry_id);

-- Customer Documents
CREATE INDEX IF NOT EXISTS idx_customer_documents_uploaded_by ON customer_documents(uploaded_by);

-- Customer Payments
CREATE INDEX IF NOT EXISTS idx_customer_payments_bank_account_id ON customer_payments(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_customer_payments_created_by ON customer_payments(created_by);

-- Customers
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON customers(created_by);

-- Delivery Challans
CREATE INDEX IF NOT EXISTS idx_delivery_challans_created_by ON delivery_challans(created_by);

-- Finance Expenses
CREATE INDEX IF NOT EXISTS idx_finance_expenses_created_by ON finance_expenses(created_by);

-- Inventory Transactions
CREATE INDEX IF NOT EXISTS idx_inventory_transactions_created_by ON inventory_transactions(created_by);

-- Product Files
CREATE INDEX IF NOT EXISTS idx_product_files_uploaded_by ON product_files(uploaded_by);

-- Products
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);

-- Sales Invoices
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_by ON sales_invoices(created_by);

-- Vendor Bills
CREATE INDEX IF NOT EXISTS idx_vendor_bills_created_by ON vendor_bills(created_by);

-- Vendor Payments
CREATE INDEX IF NOT EXISTS idx_vendor_payments_bank_account_id ON vendor_payments(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_vendor_payments_created_by ON vendor_payments(created_by);
