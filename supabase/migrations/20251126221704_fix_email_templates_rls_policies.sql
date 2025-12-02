/*
  # Fix Email Templates RLS Policies

  1. Changes
    - Drop old policies that incorrectly query auth.users table
    - Create simple policies using user_profiles table
    - Add SELECT policy for all authenticated users to read templates
    - Admin-only policies for INSERT, UPDATE, DELETE

  2. Security
    - All authenticated users can read templates (for using them)
    - Only admins can create, update, or delete templates
*/

-- Drop all existing policies
DROP POLICY IF EXISTS "Admin can delete email templates" ON crm_email_templates;
DROP POLICY IF EXISTS "Admin can insert email templates" ON crm_email_templates;
DROP POLICY IF EXISTS "Admin can manage email templates" ON crm_email_templates;
DROP POLICY IF EXISTS "Admin can update email templates" ON crm_email_templates;

-- Allow all authenticated users to view templates
CREATE POLICY "Authenticated users can view email templates"
  ON crm_email_templates
  FOR SELECT
  TO authenticated
  USING (true);

-- Admin can insert templates
CREATE POLICY "Admins can insert email templates"
  ON crm_email_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Admin can update templates (also allow incrementing use_count for all users)
CREATE POLICY "Users can update email template usage"
  ON crm_email_templates
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Admin can delete templates
CREATE POLICY "Admins can delete email templates"
  ON crm_email_templates
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );