/*
  # Fix Settings Access for All Users
  
  1. Changes
    - Update extracted_contacts SELECT policy to allow all authenticated users to view
    - This allows sales team to access shared contact data from email extraction
  
  2. Rationale
    - Extracted contacts are shared CRM data, not private user data
    - All team members need visibility into customer contacts
    - Maintains insert/delete restrictions to original user
*/

-- Drop the restrictive SELECT policy
DROP POLICY IF EXISTS "Users can view own extracted contacts" ON extracted_contacts;

-- Create new policy allowing all authenticated users to view extracted contacts
CREATE POLICY "Authenticated users can view all extracted contacts"
  ON extracted_contacts
  FOR SELECT
  TO authenticated
  USING (true);

-- Add comment
COMMENT ON POLICY "Authenticated users can view all extracted contacts" ON extracted_contacts 
IS 'All authenticated users can view extracted contacts as they are shared CRM data';
