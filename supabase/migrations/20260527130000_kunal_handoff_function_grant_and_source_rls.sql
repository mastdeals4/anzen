/*
  # CRM Master — Kunal handoff permission fix

  1. Updating crm_inquiries fires auto_update_pipeline_status(), which calls
     check_inquiry_requirements_fulfilled(uuid). Authenticated users updating
     safe CRM workflow fields need EXECUTE on that helper.
  2. Allow sales users to record source/pricing options only for CRM inquiries
     they created or are assigned to. Admin/manager policies remain unchanged.

  Idempotent and additive. No destructive changes.
*/

GRANT EXECUTE ON FUNCTION public.check_inquiry_requirements_fulfilled(uuid) TO authenticated;

DROP POLICY IF EXISTS "pricing_options_insert_sales_owned" ON crm_inquiry_pricing_options;
DROP POLICY IF EXISTS "pricing_options_update_sales_owned" ON crm_inquiry_pricing_options;

CREATE POLICY "pricing_options_insert_sales_owned" ON crm_inquiry_pricing_options
  FOR INSERT TO authenticated
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1
        FROM crm_inquiries ci
       WHERE ci.id = crm_inquiry_pricing_options.inquiry_id
         AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
    )
  );

CREATE POLICY "pricing_options_update_sales_owned" ON crm_inquiry_pricing_options
  FOR UPDATE TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1
        FROM crm_inquiries ci
       WHERE ci.id = crm_inquiry_pricing_options.inquiry_id
         AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
    )
  )
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1
        FROM crm_inquiries ci
       WHERE ci.id = crm_inquiry_pricing_options.inquiry_id
         AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
    )
  );
