-- Allow the same operational roles that can create sales orders to update them.
-- The existing column-scope trigger still protects sensitive fields for non-admin users.
CREATE POLICY "Admin, sales, and warehouse can update sales_orders"
ON public.sales_orders
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'sales'::text, 'warehouse'::text])
      AND user_profiles.is_active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE user_profiles.id = auth.uid()
      AND user_profiles.role = ANY (ARRAY['admin'::text, 'sales'::text, 'warehouse'::text])
      AND user_profiles.is_active = true
  )
);
