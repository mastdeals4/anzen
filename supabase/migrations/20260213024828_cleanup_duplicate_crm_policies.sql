/*
  # Clean Up Duplicate CRM Policies

  1. Changes
    - Remove old duplicate policies on crm_contacts and crm_leads
    - Keep only the newer, properly named policies
    
  2. Security
    - Maintains same access control
    - Just removes duplicates that cause conflicts
*/

-- =============================================
-- CRM CONTACTS: Remove old duplicate policies
-- =============================================
DROP POLICY IF EXISTS "Authenticated users can view contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can insert contacts" ON crm_contacts;
DROP POLICY IF EXISTS "Sales and admin can update contacts" ON crm_contacts;

-- =============================================
-- CRM LEADS: Remove old duplicate policies
-- =============================================
DROP POLICY IF EXISTS "Admin and sales can view all leads" ON crm_leads;
DROP POLICY IF EXISTS "Admin and sales can insert leads" ON crm_leads;
DROP POLICY IF EXISTS "Admin and sales can update leads" ON crm_leads;
