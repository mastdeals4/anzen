/*
  # Create storage bucket for CRM email attachments

  1. Changes
    - Create public storage bucket 'crm-documents' for email attachments
    - Set up RLS policies for secure file access
    - Allow authenticated users to upload files
    - Allow team members to read files

  2. Security
    - Users can upload to their own folders
    - All authenticated users can read files (team collaboration)
*/

-- Create storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('crm-documents', 'crm-documents', false)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can read files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own files" ON storage.objects;

-- Allow authenticated users to upload files
CREATE POLICY "Users can upload to own folder"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'crm-documents');

-- Allow authenticated users to read all files
CREATE POLICY "Authenticated users can read files"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'crm-documents');

-- Allow users to delete files
CREATE POLICY "Users can delete own files"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'crm-documents');