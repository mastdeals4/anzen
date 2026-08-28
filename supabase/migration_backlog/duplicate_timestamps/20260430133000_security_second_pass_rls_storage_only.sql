/*
  Second-pass security migration (RLS + storage only)
  - No business data modifications.
  - SECURITY DEFINER EXECUTE grant changes are intentionally excluded.
*/

-- 1) Fix remaining permissive RLS policies (exact live policy names)
DROP POLICY IF EXISTS "Authenticated users can insert import data" ON public.import_data;
DROP POLICY IF EXISTS "Authenticated users can delete import data" ON public.import_data;
DROP POLICY IF EXISTS "Authenticated users can insert pricing settings" ON public.pricing_settings;

CREATE POLICY "import_data_insert_accounts_admin"
ON public.import_data
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role IN ('admin', 'accounts')
  )
);

CREATE POLICY "import_data_delete_admin_only"
ON public.import_data
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role = 'admin'
  )
);

CREATE POLICY "pricing_settings_insert_admin_only"
ON public.pricing_settings
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.user_profiles up
    WHERE up.id = auth.uid()
      AND up.role = 'admin'
  )
);

-- 2) Fix public bucket listing warnings by exact policy names only (no wildcard matching)
DROP POLICY IF EXISTS "Authenticated users can read batch documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view documents" ON storage.objects;
DROP POLICY IF EXISTS "Public can read documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read access to sales order documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view PO documents" ON storage.objects;

CREATE POLICY "Authenticated read batch-documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'batch-documents');

CREATE POLICY "Authenticated read documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'documents');

CREATE POLICY "Authenticated read sales-order-documents"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'sales-order-documents');
