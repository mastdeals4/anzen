/*
  # Fix Security Issues - Optimize RLS Policies Part 3

  1. Purpose
    - Fix RLS policies for CRM tables
    - Replace auth.uid() with (select auth.uid())

  2. Changes
    - CRM quotations, inquiries, contacts, reminders
    - Email inbox, templates, activities
    - Gmail connections, domain mappings, automation
*/

-- CRM Quotations
DROP POLICY IF EXISTS "Admin and sales can insert quotations" ON crm_quotations;
CREATE POLICY "Admin and sales can insert quotations"
  ON crm_quotations FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

DROP POLICY IF EXISTS "Admin and sales can update quotations" ON crm_quotations;
CREATE POLICY "Admin and sales can update quotations"
  ON crm_quotations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

DROP POLICY IF EXISTS "Admin can delete quotations" ON crm_quotations;
CREATE POLICY "Admin can delete quotations"
  ON crm_quotations FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- CRM Quotation Items
DROP POLICY IF EXISTS "Admin and sales can manage quotation items" ON crm_quotation_items;
CREATE POLICY "Admin and sales can manage quotation items"
  ON crm_quotation_items FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- CRM Inquiries
DROP POLICY IF EXISTS "Sales and admin can manage inquiries" ON crm_inquiries;
CREATE POLICY "Sales and admin can manage inquiries"
  ON crm_inquiries FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- CRM Email Inbox
DROP POLICY IF EXISTS "Sales and admin can manage emails" ON crm_email_inbox;
CREATE POLICY "Sales and admin can manage emails"
  ON crm_email_inbox FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- CRM Email Templates
DROP POLICY IF EXISTS "Admin can manage email templates" ON crm_email_templates;
CREATE POLICY "Admin can manage email templates"
  ON crm_email_templates FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- CRM Reminders
DROP POLICY IF EXISTS "Users can manage their reminders" ON crm_reminders;
CREATE POLICY "Users can manage their reminders"
  ON crm_reminders FOR ALL
  TO authenticated
  USING (assigned_to = (select auth.uid()))
  WITH CHECK (assigned_to = (select auth.uid()));

-- CRM Contacts
DROP POLICY IF EXISTS "Sales and admin can manage contacts" ON crm_contacts;
CREATE POLICY "Sales and admin can manage contacts"
  ON crm_contacts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- CRM Pipeline Stages
DROP POLICY IF EXISTS "Admin can manage pipeline stages" ON crm_pipeline_stages;
CREATE POLICY "Admin can manage pipeline stages"
  ON crm_pipeline_stages FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- CRM Email Activities
DROP POLICY IF EXISTS "Sales and admin can manage email activities" ON crm_email_activities;
CREATE POLICY "Sales and admin can manage email activities"
  ON crm_email_activities FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- Gmail Connections
DROP POLICY IF EXISTS "Users can view own Gmail connections" ON gmail_connections;
CREATE POLICY "Users can view own Gmail connections"
  ON gmail_connections FOR SELECT
  TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can insert own Gmail connections" ON gmail_connections;
CREATE POLICY "Users can insert own Gmail connections"
  ON gmail_connections FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can update own Gmail connections" ON gmail_connections;
CREATE POLICY "Users can update own Gmail connections"
  ON gmail_connections FOR UPDATE
  TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS "Users can delete own Gmail connections" ON gmail_connections;
CREATE POLICY "Users can delete own Gmail connections"
  ON gmail_connections FOR DELETE
  TO authenticated
  USING (user_id = (select auth.uid()));

-- CRM Company Domain Mapping
DROP POLICY IF EXISTS "Sales and admin can manage domain mappings" ON crm_company_domain_mapping;
CREATE POLICY "Sales and admin can manage domain mappings"
  ON crm_company_domain_mapping FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- CRM Quick Actions Log
DROP POLICY IF EXISTS "Authenticated users can log actions" ON crm_quick_actions_log;
CREATE POLICY "Authenticated users can log actions"
  ON crm_quick_actions_log FOR INSERT
  TO authenticated
  WITH CHECK (performed_by = (select auth.uid()));

-- CRM Automation Rules
DROP POLICY IF EXISTS "Admin can manage automation rules" ON crm_automation_rules;
CREATE POLICY "Admin can manage automation rules"
  ON crm_automation_rules FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = (select auth.uid())
      AND user_profiles.role = 'admin'
    )
  );

-- CRM Activity Logs
DROP POLICY IF EXISTS "Authenticated users can create activity logs" ON crm_activity_logs;
CREATE POLICY "Authenticated users can create activity logs"
  ON crm_activity_logs FOR INSERT
  TO authenticated
  WITH CHECK (created_by = (select auth.uid()));
