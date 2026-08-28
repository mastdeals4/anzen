/*
  Fix CRM quotation post-send workflow RLS.

  The Gmail send itself happens in send-bulk-email, but workflow completion
  writes are performed by the browser client with the authenticated user's JWT:
    - bulk_email_campaigns
    - bulk_email_recipients
    - crm_email_activities
    - crm_inquiries quote/status fields

  Existing crm_email_activities policies only allowed admin/sales, which blocks
  active managers even though the send Edge Function allows them. This migration
  adds targeted CRM role policies without disabling RLS globally.
*/

-- Ensure managers can read CRM inquiries they operate on.
DROP POLICY IF EXISTS "Sales, admin, and auditor can view crm_inquiries" ON public.crm_inquiries;
CREATE POLICY "CRM roles can view crm_inquiries"
  ON public.crm_inquiries
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager', 'sales', 'auditor_ca')
    )
  );

-- Preserve existing admin/sales write access and include managers for CRM workflow completion.
DROP POLICY IF EXISTS "Sales and admin can update inquiries" ON public.crm_inquiries;
DROP POLICY IF EXISTS "CRM roles can update crm_inquiries" ON public.crm_inquiries;
CREATE POLICY "CRM roles can update crm_inquiries"
  ON public.crm_inquiries
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager', 'sales')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager', 'sales')
    )
  );

-- Existing broad manage policy is still valid for admin/sales. Add a narrower
-- insert policy for active CRM sender roles and accessible inquiries.
DROP POLICY IF EXISTS "CRM roles can insert email activities for accessible inquiries" ON public.crm_email_activities;
CREATE POLICY "CRM roles can insert email activities for accessible inquiries"
  ON public.crm_email_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager', 'sales')
    )
    AND (
      inquiry_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.crm_inquiries ci
        WHERE ci.id = crm_email_activities.inquiry_id
      )
    )
  );

-- Keep team visibility but ensure active CRM roles can read the activity rows
-- they create and the inquiry-linked rows they can access.
DROP POLICY IF EXISTS "CRM roles can view email activities" ON public.crm_email_activities;
CREATE POLICY "CRM roles can view email activities"
  ON public.crm_email_activities
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager', 'sales', 'auditor_ca')
    )
  );
