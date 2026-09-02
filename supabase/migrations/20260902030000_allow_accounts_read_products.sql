-- Finance users must be able to resolve valid product IDs on purchase
-- documents. Keep product-master writes restricted by the existing policies;
-- this migration changes SELECT access only.
DROP POLICY IF EXISTS "Allow users to view products" ON public.products;
DROP POLICY IF EXISTS "All authenticated users can view products" ON public.products;

CREATE POLICY "Allow users to view products"
  ON public.products
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles AS up
      WHERE up.id = (SELECT auth.uid())
        AND up.is_active = true
        AND up.role IN ('admin', 'accounts', 'sales', 'warehouse', 'auditor_ca')
    )
  );
