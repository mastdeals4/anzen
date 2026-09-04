DROP POLICY IF EXISTS "Admin and manager can update any campaign" ON public.bulk_email_campaigns;
CREATE POLICY "Admin and manager can update any campaign"
  ON public.bulk_email_campaigns
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "Admin and manager can update any recipient" ON public.bulk_email_recipients;
CREATE POLICY "Admin and manager can update any recipient"
  ON public.bulk_email_recipients
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'manager')
    )
  );
