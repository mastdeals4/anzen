/*
  # Optimize RLS Policies - Part 1 (CRM Tables)

  1. Performance Improvements
    - Wrap auth.uid() calls with SELECT to cache the value
    - Prevents re-evaluation for each row
    - Significantly improves query performance at scale
    
  2. Tables Optimized
    - crm_company_domain_mapping
    - crm_inquiries
    - crm_email_inbox
    - crm_contacts
    - crm_email_activities
*/

-- CRM Company Domain Mapping
DROP POLICY IF EXISTS "Sales and admin can insert domain mappings" ON crm_company_domain_mapping;
DROP POLICY IF EXISTS "Sales and admin can update domain mappings" ON crm_company_domain_mapping;
DROP POLICY IF EXISTS "Sales and admin can delete domain mappings" ON crm_company_domain_mapping;

CREATE POLICY "Sales and admin can insert domain mappings"
  ON crm_company_domain_mapping FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update domain mappings"
  ON crm_company_domain_mapping FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete domain mappings"
  ON crm_company_domain_mapping FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

-- CRM Inquiries
DROP POLICY IF EXISTS "Authenticated users can view inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Sales and admin can insert inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Sales and admin can update inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Sales and admin can delete inquiries" ON crm_inquiries;

CREATE POLICY "Authenticated users can view inquiries"
  ON crm_inquiries FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Sales and admin can insert inquiries"
  ON crm_inquiries FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update inquiries"
  ON crm_inquiries FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete inquiries"
  ON crm_inquiries FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

-- CRM Email Inbox
DROP POLICY IF EXISTS "Authenticated users can view emails" ON crm_email_inbox;
DROP POLICY IF EXISTS "Sales and admin can insert emails" ON crm_email_inbox;
DROP POLICY IF EXISTS "Sales and admin can update emails" ON crm_email_inbox;
DROP POLICY IF EXISTS "Sales and admin can delete emails" ON crm_email_inbox;

CREATE POLICY "Authenticated users can view emails"
  ON crm_email_inbox FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Sales and admin can insert emails"
  ON crm_email_inbox FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update emails"
  ON crm_email_inbox FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete emails"
  ON crm_email_inbox FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

-- CRM Contacts
DROP POLICY IF EXISTS "Sales and admin can insert contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can update contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can delete contacts" ON crm_contacts;

CREATE POLICY "Sales and admin can insert contacts"
  ON crm_contacts FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update contacts"
  ON crm_contacts FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete contacts"
  ON crm_contacts FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

-- CRM Email Activities
DROP POLICY IF EXISTS "Sales and admin can insert email activities" ON crm_email_activities;
DROP POLICY IF EXISTS "Sales and admin can update email activities" ON crm_email_activities;
DROP POLICY IF EXISTS "Sales and admin can delete email activities" ON crm_email_activities;

CREATE POLICY "Sales and admin can insert email activities"
  ON crm_email_activities FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update email activities"
  ON crm_email_activities FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete email activities"
  ON crm_email_activities FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'sales')
    )
  );