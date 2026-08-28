-- Faktur PDFs are stored in the existing private documents bucket. The
-- attachment metadata is readable to authenticated Finance users, so the
-- corresponding Storage objects must also be readable for signed URLs/listing.
DROP POLICY IF EXISTS "faktur documents authenticated read" ON storage.objects;

CREATE POLICY "faktur documents authenticated read"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'documents' AND auth.uid() IS NOT NULL);
