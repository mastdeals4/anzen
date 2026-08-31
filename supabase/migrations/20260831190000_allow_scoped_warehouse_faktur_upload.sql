-- Permit official Faktur Pajak recording for explicitly authorized warehouse
-- users without granting access to the rest of Finance.
DROP POLICY IF EXISTS "faktur_pajak_write" ON public.faktur_pajak;
CREATE POLICY "faktur_pajak_write" ON public.faktur_pajak
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND (
          up.role IN ('admin', 'manager', 'accounts')
          OR (
            up.role = 'warehouse'
            AND EXISTS (
              SELECT 1 FROM public.user_permissions permission
              WHERE permission.user_id = up.id
                AND permission.module = 'tax-compliance'
                AND permission.can_access = true
            )
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND (
          up.role IN ('admin', 'manager', 'accounts')
          OR (
            up.role = 'warehouse'
            AND EXISTS (
              SELECT 1 FROM public.user_permissions permission
              WHERE permission.user_id = up.id
                AND permission.module = 'tax-compliance'
                AND permission.can_access = true
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "faktur_pajak_files_write" ON public.faktur_pajak_files;
CREATE POLICY "faktur_pajak_files_write" ON public.faktur_pajak_files
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND (
          up.role IN ('admin', 'manager', 'accounts')
          OR (
            up.role = 'warehouse'
            AND EXISTS (
              SELECT 1 FROM public.user_permissions permission
              WHERE permission.user_id = up.id
                AND permission.module = 'tax-compliance'
                AND permission.can_access = true
            )
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_profiles up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND (
          up.role IN ('admin', 'manager', 'accounts')
          OR (
            up.role = 'warehouse'
            AND EXISTS (
              SELECT 1 FROM public.user_permissions permission
              WHERE permission.user_id = up.id
                AND permission.module = 'tax-compliance'
                AND permission.can_access = true
            )
          )
        )
    )
  );
