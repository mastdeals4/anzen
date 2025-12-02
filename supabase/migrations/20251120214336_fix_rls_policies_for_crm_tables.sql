/*
  # Fix RLS Policies for CRM Tables

  1. Changes
    - Drop problematic policies that reference auth.users directly
    - Create new policies that use user_profiles table
    - Allow authenticated users to INSERT and UPDATE

  2. Security
    - Policies check user_profiles instead of auth.users
    - Only sales and admin roles can manage CRM data
*/

-- Drop old problematic policies for crm_inquiries
DROP POLICY IF EXISTS "Sales and admin can insert inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Sales and admin can update inquiries" ON crm_inquiries;
DROP POLICY IF EXISTS "Sales and admin can delete inquiries" ON crm_inquiries;

-- Drop old problematic policies for crm_email_inbox
DROP POLICY IF EXISTS "Sales and admin can insert emails" ON crm_email_inbox;
DROP POLICY IF EXISTS "Sales and admin can update emails" ON crm_email_inbox;
DROP POLICY IF EXISTS "Sales and admin can delete emails" ON crm_email_inbox;

-- Create new policies for crm_inquiries using user_profiles
CREATE POLICY "Authenticated users can view inquiries"
  ON crm_inquiries FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
    )
  );

CREATE POLICY "Sales and admin can insert inquiries"
  ON crm_inquiries FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update inquiries"
  ON crm_inquiries FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete inquiries"
  ON crm_inquiries FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

-- Create new policies for crm_email_inbox using user_profiles
CREATE POLICY "Authenticated users can view emails"
  ON crm_email_inbox FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
    )
  );

CREATE POLICY "Sales and admin can insert emails"
  ON crm_email_inbox FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can update emails"
  ON crm_email_inbox FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );

CREATE POLICY "Sales and admin can delete emails"
  ON crm_email_inbox FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
      AND user_profiles.role IN ('admin', 'sales')
    )
  );
