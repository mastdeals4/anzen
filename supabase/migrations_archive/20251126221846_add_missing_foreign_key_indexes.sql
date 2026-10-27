/*
  # Add Missing Foreign Key Indexes

  1. Performance Improvements
    - Add indexes on all unindexed foreign keys
    - Improves JOIN performance and referential integrity checks
    
  2. Tables Affected
    - audit_logs, crm_activities, crm_activity_logs, crm_email_activities
    - crm_email_inbox, crm_emails, crm_inquiries, crm_inquiry_timeline
    - crm_leads, crm_quick_actions_log, crm_quotations, crm_reminders
    - customer_documents, customer_payments, sales_invoices
    - task_status_history, tasks, vendor_payments
*/

-- Audit logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

-- CRM Activities
CREATE INDEX IF NOT EXISTS idx_crm_activities_customer_id ON crm_activities(customer_id);

-- CRM Activity Logs
CREATE INDEX IF NOT EXISTS idx_crm_activity_logs_inquiry_id ON crm_activity_logs(inquiry_id);

-- CRM Email Activities
CREATE INDEX IF NOT EXISTS idx_crm_email_activities_inquiry_id ON crm_email_activities(inquiry_id);

-- CRM Email Inbox
CREATE INDEX IF NOT EXISTS idx_crm_email_inbox_gmail_connection_id ON crm_email_inbox(gmail_connection_id);

-- CRM Emails
CREATE INDEX IF NOT EXISTS idx_crm_emails_customer_id ON crm_emails(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_emails_lead_id ON crm_emails(lead_id);

-- CRM Inquiries
CREATE INDEX IF NOT EXISTS idx_crm_inquiries_assigned_to ON crm_inquiries(assigned_to);

-- CRM Inquiry Timeline
CREATE INDEX IF NOT EXISTS idx_crm_inquiry_timeline_inquiry_id ON crm_inquiry_timeline(inquiry_id);

-- CRM Leads
CREATE INDEX IF NOT EXISTS idx_crm_leads_assigned_to ON crm_leads(assigned_to);

-- CRM Quick Actions Log
CREATE INDEX IF NOT EXISTS idx_crm_quick_actions_log_inquiry_id ON crm_quick_actions_log(inquiry_id);

-- CRM Quotations
CREATE INDEX IF NOT EXISTS idx_crm_quotations_customer_id ON crm_quotations(customer_id);

-- CRM Reminders
CREATE INDEX IF NOT EXISTS idx_crm_reminders_assigned_to ON crm_reminders(assigned_to);

-- Customer Documents
CREATE INDEX IF NOT EXISTS idx_customer_documents_customer_id ON customer_documents(customer_id);

-- Customer Payments
CREATE INDEX IF NOT EXISTS idx_customer_payments_customer_id ON customer_payments(customer_id);

-- Sales Invoices
CREATE INDEX IF NOT EXISTS idx_sales_invoices_customer_id ON sales_invoices(customer_id);

-- Task Status History
CREATE INDEX IF NOT EXISTS idx_task_status_history_changed_by ON task_status_history(changed_by);

-- Tasks
CREATE INDEX IF NOT EXISTS idx_tasks_completed_by ON tasks(completed_by);
CREATE INDEX IF NOT EXISTS idx_tasks_deleted_by ON tasks(deleted_by);

-- Vendor Payments
CREATE INDEX IF NOT EXISTS idx_vendor_payments_bill_id ON vendor_payments(bill_id);