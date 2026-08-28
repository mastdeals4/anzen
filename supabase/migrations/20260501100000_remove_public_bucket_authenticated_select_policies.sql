/*
  Remove broad authenticated SELECT policies on public buckets.
  Public object URLs do not require storage.objects listing access.
*/

DROP POLICY IF EXISTS "Authenticated read batch-documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated read documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated read sales-order-documents" ON storage.objects;
