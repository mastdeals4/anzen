/*
  # Fix CRM RLS Policies - Add Missing SELECT Policies
  
  1. Problems Identified
    - crm_contacts: Missing SELECT policy - authenticated users cannot view any contacts
    - crm_pipeline_stages: Missing SELECT policy - stages cannot be displayed in kanban
  
  2. Solutions
    - Add SELECT policy to crm_contacts allowing authenticated users to view all contacts
    - Add SELECT policy to crm_pipeline_stages allowing authenticated users to view all stages
  
  3. Security
    - SELECT is permissive by default - authenticated users can view shared data
    - INSERT/UPDATE/DELETE remain restricted to sales and admin roles
*/

-- Add missing SELECT policy to crm_contacts
CREATE POLICY "Authenticated users can view contacts"
  ON crm_contacts FOR SELECT
  TO authenticated
  USING (true);

-- Add missing SELECT policy to crm_pipeline_stages
CREATE POLICY "Authenticated users can view pipeline stages"
  ON crm_pipeline_stages FOR SELECT
  TO authenticated
  USING (true);
