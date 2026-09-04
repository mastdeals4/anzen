/*
  Allow admin/manager to manage any bulk email campaign regardless of who
  created it. The original policies only allowed the campaign creator to UPDATE,
  which blocks an admin or manager from pausing, resuming, or cancelling a
  campaign started by a different user (e.g. a sales person).

  No schema changes. No data changes. RLS only.
*/

-- ===========================================================================
-- bulk_email_campaigns UPDATE — admin/manager override
-- ===========================================================================
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

-- ===========================================================================
-- bulk_email_recipients UPDATE — admin/manager override
-- ===========================================================================
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
