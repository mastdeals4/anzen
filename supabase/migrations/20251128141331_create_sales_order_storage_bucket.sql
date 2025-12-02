/*
  # Create Storage Bucket for Sales Order Documents

  1. Changes
    - Create `sales-order-documents` storage bucket
    - Set bucket as public for easy access
    - Add RLS policies for authenticated users to upload files
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('sales-order-documents', 'sales-order-documents', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Allow authenticated users to upload sales order documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'sales-order-documents');

CREATE POLICY "Allow public read access to sales order documents"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'sales-order-documents');

CREATE POLICY "Allow authenticated users to update their sales order documents"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'sales-order-documents')
WITH CHECK (bucket_id = 'sales-order-documents');

CREATE POLICY "Allow authenticated users to delete sales order documents"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'sales-order-documents');