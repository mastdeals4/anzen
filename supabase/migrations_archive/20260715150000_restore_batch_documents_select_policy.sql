-- ============================================================================
-- Restore the missing SELECT policy on storage.objects for batch-documents
-- ============================================================================
-- Regression (found by auditing the batch-documents upload/view pipeline):
--   Viewing a Batch document returned:
--       POST /storage/v1/object/sign/batch-documents/... → 404 Object not found
--   The bucket exists, the objects exist, and the batch_documents.file_url
--   paths match the storage object names exactly. The failure is pure RLS:
--   createSignedUrl() on a PRIVATE bucket requires a SELECT policy on
--   storage.objects, and batch-documents had none.
--
-- How it broke:
--   • 20260501100000 dropped "Authenticated read batch-documents" — safe at
--     the time because the bucket was still public (public URLs need no
--     storage.objects SELECT access).
--   • 20260713120000 flipped batch-documents to public = false and re-added
--     only INSERT/DELETE policies, never a SELECT policy. Private bucket +
--     no SELECT policy → createSignedUrl returns 404 Object not found.
--   (The sibling bucket sales-order-documents hit the same regression and was
--    already fixed in 20260714240000 via so_docs_authenticated_read.)
--
-- Fix (smallest possible, additive only):
--   Re-create the SELECT read policy for batch-documents, mirroring the exact
--   style of every other document bucket (any authenticated user can read).
--
-- Does NOT touch bucket configuration, existing objects, other policies, or
-- any application code. Idempotent (IF NOT EXISTS guard; safe to re-run).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'Authenticated users can read batch documents'
  ) THEN
    CREATE POLICY "Authenticated users can read batch documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'batch-documents');
  END IF;
END $$;
