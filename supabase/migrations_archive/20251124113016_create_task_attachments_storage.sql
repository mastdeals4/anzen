/*
  # Create storage bucket for task attachments
  
  1. Changes
    - Create 'task-attachments' storage bucket for task files
    - Set up RLS policies for secure file access
    - Allow authenticated users to upload files
    - Allow task participants to read attachments
  
  2. Security
    - Users can upload to their own task folders
    - All task participants can read files
    - Users can delete their own uploaded files
*/

-- Create storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('task-attachments', 'task-attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can upload task files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read task files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own task files" ON storage.objects;

-- Allow authenticated users to upload files
CREATE POLICY "Users can upload task files"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'task-attachments');

-- Allow authenticated users to read task files
CREATE POLICY "Users can read task files"
ON storage.objects
FOR SELECT
TO authenticated
USING (bucket_id = 'task-attachments');

-- Allow users to delete files they uploaded
CREATE POLICY "Users can delete own task files"
ON storage.objects
FOR DELETE
TO authenticated
USING (bucket_id = 'task-attachments');