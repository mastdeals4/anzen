-- Migration: Fix Tax Compliance RLS Policies for Accounts Role
-- Description: Grants write permissions on tax_payment_files, tax_payments, and tax_periods
--              to 'accounts' role (and warehouse with tax-compliance permission),
--              matching the permissions already configured on faktur_pajak and faktur_pajak_files.

-- 1. tax_payment_files --------------------------------------------------------
DROP POLICY IF EXISTS "tax_payment_files_write" ON public.tax_payment_files;

CREATE POLICY "tax_payment_files_write" ON public.tax_payment_files
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = (SELECT auth.uid())
      AND up.is_active = true
      AND (
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
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
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
              AND permission.can_access = true
          )
        )
      )
  )
);

-- 2. tax_payments -------------------------------------------------------------
DROP POLICY IF EXISTS "tax_payments_write" ON public.tax_payments;

CREATE POLICY "tax_payments_write" ON public.tax_payments
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = (SELECT auth.uid())
      AND up.is_active = true
      AND (
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
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
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
              AND permission.can_access = true
          )
        )
      )
  )
);

-- 3. tax_periods --------------------------------------------------------------
DROP POLICY IF EXISTS "tax_periods_write" ON public.tax_periods;

CREATE POLICY "tax_periods_write" ON public.tax_periods
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.user_profiles up
    WHERE up.id = (SELECT auth.uid())
      AND up.is_active = true
      AND (
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
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
        up.role = ANY (ARRAY['admin'::text, 'manager'::text, 'accounts'::text])
        OR (
          up.role = 'warehouse'::text AND EXISTS (
            SELECT 1 FROM public.user_permissions permission
            WHERE permission.user_id = up.id
              AND permission.module = 'tax-compliance'::text
              AND permission.can_access = true
          )
        )
      )
  )
);
