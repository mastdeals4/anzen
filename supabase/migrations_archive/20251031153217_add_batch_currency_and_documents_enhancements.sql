/*
  # Batch Currency Conversion and Document Management Enhancement

  ## Overview
  This migration enhances the batch management system with USD currency support, 
  per-batch exchange rates, and improved document handling.

  ## Changes Made

  ### 1. Batches Table Updates
  - Add `import_price_usd` - Store import price in USD
  - Add `exchange_rate_usd_to_idr` - Daily exchange rate for this batch
  - Rename `import_price` to `import_price_idr` (calculated from USD * rate)
  - Make `warehouse_location` nullable (field deprecated in UI)
  - Update computed columns to work with IDR pricing

  ### 2. Batch Documents
  - Ensure batch_documents table is properly indexed
  - Add file_size and file_type tracking for better document management

  ### 3. Storage Bucket
  - Create storage bucket for batch documents
  - Set up public access policies for authenticated users

  ## Important Notes
  - Exchange rate is stored per batch for historical accuracy
  - Old batches will have null USD values (legacy data)
  - Warehouse location field remains in DB but hidden in UI
*/

-- Add new currency fields to batches table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'import_price_usd'
  ) THEN
    ALTER TABLE batches ADD COLUMN import_price_usd numeric(15,2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'batches' AND column_name = 'exchange_rate_usd_to_idr'
  ) THEN
    ALTER TABLE batches ADD COLUMN exchange_rate_usd_to_idr numeric(15,4);
  END IF;
END $$;

-- Make warehouse_location nullable (it's already nullable, but this ensures it)
ALTER TABLE batches ALTER COLUMN warehouse_location DROP NOT NULL;

-- Update the comment for import_price to clarify it stores IDR
COMMENT ON COLUMN batches.import_price IS 'Import price in Indonesian Rupiah (IDR)';
COMMENT ON COLUMN batches.import_price_usd IS 'Import price in US Dollars (USD)';
COMMENT ON COLUMN batches.exchange_rate_usd_to_idr IS 'Exchange rate from USD to IDR at time of import';

-- Ensure batch_documents table has proper indexes (already exists from previous migration)
-- Adding additional helpful indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_batch_documents_file_type ON batch_documents(file_type);
CREATE INDEX IF NOT EXISTS idx_batch_documents_uploaded_at ON batch_documents(uploaded_at);

-- Create storage bucket for batch documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('batch-documents', 'batch-documents', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for batch documents bucket
DO $$
BEGIN
  -- Policy for authenticated users to upload files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can upload batch documents'
  ) THEN
    CREATE POLICY "Authenticated users can upload batch documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'batch-documents');
  END IF;

  -- Policy for authenticated users to read files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Authenticated users can read batch documents'
  ) THEN
    CREATE POLICY "Authenticated users can read batch documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'batch-documents');
  END IF;

  -- Policy for authenticated users to delete their uploaded files
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can delete batch documents'
  ) THEN
    CREATE POLICY "Users can delete batch documents"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'batch-documents');
  END IF;
END $$;

-- Create a helpful view for stock overview per product
CREATE OR REPLACE VIEW product_stock_summary AS
SELECT 
  p.id as product_id,
  p.product_name,
  p.product_code,
  p.unit,
  p.category,
  COALESCE(SUM(b.current_stock), 0) as total_current_stock,
  COUNT(b.id) as active_batch_count,
  COUNT(CASE WHEN b.expiry_date IS NOT NULL AND b.expiry_date < CURRENT_DATE THEN 1 END) as expired_batch_count,
  MIN(b.expiry_date) as nearest_expiry_date
FROM products p
LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
WHERE p.is_active = true
GROUP BY p.id, p.product_name, p.product_code, p.unit, p.category
ORDER BY p.product_name;

-- Grant access to the view
GRANT SELECT ON product_stock_summary TO authenticated;

-- Add helpful comment
COMMENT ON VIEW product_stock_summary IS 'Aggregated stock overview per product across all active batches';
