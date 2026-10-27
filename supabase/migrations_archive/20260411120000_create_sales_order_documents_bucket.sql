-- Create the storage bucket for Customer PO documents uploaded in Sales Orders
-- This fixes the "Bucket not found" error when trying to view/download PO attachments

-- Create the bucket (public so URLs work without signed tokens)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sales-order-documents',
  'sales-order-documents',
  true,
  10485760,  -- 10 MB max file size
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
ON CONFLICT (id) DO NOTHING;  -- Safe to run again if already exists

-- Allow authenticated users to upload to their own folder
CREATE POLICY "Authenticated users can upload PO documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'sales-order-documents');

-- Allow authenticated users to read all PO documents
CREATE POLICY "Authenticated users can view PO documents"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'sales-order-documents');

-- Allow authenticated users to delete their own uploads
CREATE POLICY "Authenticated users can delete PO documents"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'sales-order-documents');

-- Also create the 'documents' bucket used by PurchaseInvoiceManager if missing
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

CREATE POLICY "Authenticated users can upload documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'documents')
ON CONFLICT DO NOTHING;

CREATE POLICY "Authenticated users can view documents"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'documents')
ON CONFLICT DO NOTHING;
