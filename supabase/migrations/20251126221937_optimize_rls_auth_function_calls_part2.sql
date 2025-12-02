/*
  # Optimize RLS Policies - Part 2 (Email Templates, Automation, Pipelines, Quotations)

  1. Performance Improvements
    - Wrap auth.uid() calls with SELECT to cache the value
    - Prevents re-evaluation for each row
    
  2. Tables Optimized
    - crm_email_templates
    - crm_automation_rules
    - crm_pipeline_stages
    - crm_quotation_items
*/

-- CRM Email Templates
DROP POLICY IF EXISTS "Admins can insert email templates" ON crm_email_templates;
DROP POLICY IF EXISTS "Admins can delete email templates" ON crm_email_templates;

CREATE POLICY "Admins can insert email templates"
  ON crm_email_templates FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admins can delete email templates"
  ON crm_email_templates FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- CRM Automation Rules
DROP POLICY IF EXISTS "Admin can insert automation rules" ON crm_automation_rules;
DROP POLICY IF EXISTS "Admin can update automation rules" ON crm_automation_rules;
DROP POLICY IF EXISTS "Admin can delete automation rules" ON crm_automation_rules;

CREATE POLICY "Admin can insert automation rules"
  ON crm_automation_rules FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admin can update automation rules"
  ON crm_automation_rules FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admin can delete automation rules"
  ON crm_automation_rules FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- CRM Pipeline Stages
DROP POLICY IF EXISTS "Admin can insert pipeline stages" ON crm_pipeline_stages;
DROP POLICY IF EXISTS "Admin can update pipeline stages" ON crm_pipeline_stages;
DROP POLICY IF EXISTS "Admin can delete pipeline stages" ON crm_pipeline_stages;

CREATE POLICY "Admin can insert pipeline stages"
  ON crm_pipeline_stages FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admin can update pipeline stages"
  ON crm_pipeline_stages FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

CREATE POLICY "Admin can delete pipeline stages"
  ON crm_pipeline_stages FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- CRM Quotation Items
DROP POLICY IF EXISTS "Admin and sales can insert quotation items" ON crm_quotation_items;
DROP POLICY IF EXISTS "Admin and sales can update quotation items" ON crm_quotation_items;
DROP POLICY IF EXISTS "Admin and sales can delete quotation items" ON crm_quotation_items;

CREATE POLICY "Admin and sales can insert quotation items"
  ON crm_quotation_items FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin and sales can update quotation items"
  ON crm_quotation_items FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Admin and sales can delete quotation items"
  ON crm_quotation_items FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );