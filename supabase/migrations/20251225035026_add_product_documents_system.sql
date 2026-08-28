/*
  # Add Product Documents System

  1. New Table
    - `product_documents` - Stores product-level documents (COA, MSDS, Specs)
      - `id` (uuid, primary key)
      - `product_id` (uuid, foreign key to products)
      - `file_url` (text, document URL)
      - `file_name` (text, original filename)
      - `document_type` (text, COA/MSDS/SPEC/OTHER)
      - `file_size` (bigint, file size in bytes)
      - `uploaded_by` (uuid, foreign key to user_profiles)
      - `uploaded_at` (timestamptz, upload timestamp)

  2. Storage
    - Create `product-documents` storage bucket
    - Same policies as batch-documents

  3. Security
    - Enable RLS on `product_documents` table
    - Authenticated users can view all product documents
    - Only authorized users can upload/delete

  4. Important Notes
    - This does NOT affect batch_documents table
    - Product documents are separate from batch documents
    - Same upload/view/download UX as batch documents
    - Product COA = generic/reference, Batch COA = actual supplied
*/

-- =====================================================
-- 1. CREATE PRODUCT DOCUMENTS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS product_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('coa', 'msds', 'specification', 'regulatory', 'other')),
  file_size bigint,
  uploaded_by uuid REFERENCES user_profiles(id),
  uploaded_at timestamptz DEFAULT now()
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_product_documents_product ON product_documents(product_id);
CREATE INDEX IF NOT EXISTS idx_product_documents_type ON product_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_product_documents_uploaded_at ON product_documents(uploaded_at);

-- =====================================================
-- 2. CREATE STORAGE BUCKET
-- =====================================================

-- Create storage bucket for product documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-documents', 'product-documents', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- 3. STORAGE POLICIES (Same as batch-documents)
-- =====================================================

DO $$
BEGIN
  -- Policy for authenticated users to upload files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can upload product documents'
  ) THEN
    CREATE POLICY "Authenticated users can upload product documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'product-documents');
  END IF;

  -- Policy for authenticated users to read files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can read product documents'
  ) THEN
    CREATE POLICY "Authenticated users can read product documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'product-documents');
  END IF;

  -- Policy for authenticated users to delete files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can delete product documents'
  ) THEN
    CREATE POLICY "Users can delete product documents"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'product-documents');
  END IF;
END $$;

-- =====================================================
-- 4. ENABLE ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE product_documents ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- 5. RLS POLICIES
-- =====================================================

-- All authenticated users can view product documents
CREATE POLICY "Authenticated users can view product documents"
  ON product_documents FOR SELECT
  TO authenticated
  USING (true);

-- Authenticated users can insert product documents
CREATE POLICY "Authenticated users can upload product documents"
  ON product_documents FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = uploaded_by);

-- Users can update their own uploaded documents
CREATE POLICY "Users can update own product documents"
  ON product_documents FOR UPDATE
  TO authenticated
  USING (auth.uid() = uploaded_by)
  WITH CHECK (auth.uid() = uploaded_by);

-- Users can delete their own uploaded documents
CREATE POLICY "Users can delete own product documents"
  ON product_documents FOR DELETE
  TO authenticated
  USING (auth.uid() = uploaded_by);

-- =====================================================
-- 6. COMMENTS
-- =====================================================

COMMENT ON TABLE product_documents IS 
'Stores product-level documents (COA, MSDS, specifications, etc.).
These are separate from batch_documents and represent generic/reference documents for the product.';

COMMENT ON COLUMN product_documents.document_type IS 
'Type of document: coa (generic COA template), msds (Material Safety Data Sheet), 
specification (Product specs), regulatory (Regulatory docs), other (Miscellaneous)';

COMMENT ON COLUMN product_documents.product_id IS 
'Foreign key to products table. Each product can have multiple documents.';
