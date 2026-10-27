/*
  # Fix CRM Reminders SELECT Policy
  
  1. Security Issue
    - Missing SELECT policy on crm_reminders table
    - Users cannot view reminders even though data exists
  
  2. Changes
    - Add SELECT policy allowing authenticated users to view their assigned reminders
    - Policy checks: assigned_to = auth.uid()
*/

-- Add SELECT policy for crm_reminders
CREATE POLICY "Users can view their reminders"
  ON crm_reminders
  FOR SELECT
  TO authenticated
  USING (assigned_to = auth.uid());