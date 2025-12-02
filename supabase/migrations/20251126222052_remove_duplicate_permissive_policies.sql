/*
  # Remove Duplicate Permissive Policies

  1. Changes
    - Remove redundant "manage" policies that overlap with specific INSERT/UPDATE/DELETE policies
    - Keep only the specific policies for better clarity and performance
    
  2. Tables Affected
    - crm_automation_rules
    - crm_company_domain_mapping
    - crm_contacts
    - crm_email_activities
    - crm_email_inbox
    - crm_inquiries
    - crm_pipeline_stages
    - crm_quotation_items
    - crm_reminders
*/

-- CRM Automation Rules - Remove general "manage" policy
DROP POLICY IF EXISTS "Admin can manage automation rules" ON crm_automation_rules;

-- CRM Company Domain Mapping - Remove general "manage" policy
DROP POLICY IF EXISTS "Sales and admin can manage domain mappings" ON crm_company_domain_mapping;

-- CRM Contacts - Remove general "manage" policy
DROP POLICY IF EXISTS "Sales and admin can manage contacts" ON crm_contacts;

-- CRM Email Activities - Remove general "manage" policy
DROP POLICY IF EXISTS "Sales and admin can manage email activities" ON crm_email_activities;

-- CRM Email Inbox - Remove general "manage" policy
DROP POLICY IF EXISTS "Sales and admin can manage emails" ON crm_email_inbox;

-- CRM Inquiries - Remove general "manage" policy
DROP POLICY IF EXISTS "Sales and admin can manage inquiries" ON crm_inquiries;

-- CRM Pipeline Stages - Remove general "manage" policy
DROP POLICY IF EXISTS "Admin can manage pipeline stages" ON crm_pipeline_stages;

-- CRM Quotation Items - Remove general "manage" policy
DROP POLICY IF EXISTS "Admin and sales can manage quotation items" ON crm_quotation_items;

-- CRM Reminders - Remove general "manage" policy
DROP POLICY IF EXISTS "Users can manage their reminders" ON crm_reminders;