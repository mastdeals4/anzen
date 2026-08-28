/*
  # Create Storage Bucket for Expense Documents

  1. Storage Bucket
    - Create `expense-documents` storage bucket for expense invoices
    - Public bucket for easy access
    - Same policies as other document buckets

  2. Storage Policies
    - Authenticated users can upload
    - Authenticated users can read
    - Authenticated users can delete

  3. Important
    - The `document_urls` column already exists in finance_expenses table
    - This migration only creates the storage bucket
*/

-- =====================================================
-- 1. CREATE STORAGE BUCKET
-- =====================================================

-- Create storage bucket for expense documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('expense-documents', 'expense-documents', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- 2. STORAGE POLICIES
-- =====================================================

DO $$
BEGIN
  -- Policy for authenticated users to upload files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can upload expense documents'
  ) THEN
    CREATE POLICY "Authenticated users can upload expense documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'expense-documents');
  END IF;

  -- Policy for authenticated users to read files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can read expense documents'
  ) THEN
    CREATE POLICY "Authenticated users can read expense documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'expense-documents');
  END IF;

  -- Policy for authenticated users to delete files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can delete expense documents'
  ) THEN
    CREATE POLICY "Users can delete expense documents"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'expense-documents');
  END IF;
END $$;

-- =====================================================
-- 3. COMMENTS
-- =====================================================

COMMENT ON COLUMN finance_expenses.document_urls IS 
'Array of URLs to expense supporting documents (invoices, receipts, bills, etc.) stored in expense-documents bucket';
