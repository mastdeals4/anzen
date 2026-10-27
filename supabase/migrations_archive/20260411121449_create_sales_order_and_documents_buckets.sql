/*
  # Create storage buckets for Sales Order documents and Purchase Invoice documents

  Creates:
  - 'sales-order-documents' bucket for Customer PO attachments in Sales Orders
  - 'documents' bucket used by Purchase Invoice Manager

  Safe to run multiple times - uses ON CONFLICT DO NOTHING for bucket creation.
  Policies are created with IF NOT EXISTS guards.
*/

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sales-order-documents',
  'sales-order-documents',
  true,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  true,
  10485760,
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can upload PO documents'
  ) THEN
    CREATE POLICY "Authenticated users can upload PO documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'sales-order-documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can view PO documents'
  ) THEN
    CREATE POLICY "Authenticated users can view PO documents"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'sales-order-documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can delete PO documents'
  ) THEN
    CREATE POLICY "Authenticated users can delete PO documents"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'sales-order-documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can upload documents'
  ) THEN
    CREATE POLICY "Authenticated users can upload documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can view documents'
  ) THEN
    CREATE POLICY "Authenticated users can view documents"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'documents');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
    AND policyname = 'Authenticated users can delete documents'
  ) THEN
    CREATE POLICY "Authenticated users can delete documents"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'documents');
  END IF;
END $$;
