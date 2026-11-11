-- Migration: 20261110120000_crm_document_bank_lifecycle_product_make_upgrade.sql
-- Description: Implement 4-state document lifecycle (TEMP, REVIEWED, BANKED, ARCHIVED),
--              Product + Make (product_sources) canonical normalization, batch link for COA,
--              SHA-256 deduplication indexing, and updated Document Bank statistics.

-- 1. Add lifecycle_status column with check constraint
ALTER TABLE public.crm_product_documents
  ADD COLUMN IF NOT EXISTS lifecycle_status text NOT NULL DEFAULT 'TEMP';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'crm_product_documents_lifecycle_status_check'
  ) THEN
    ALTER TABLE public.crm_product_documents
      ADD CONSTRAINT crm_product_documents_lifecycle_status_check
      CHECK (lifecycle_status IN ('TEMP', 'REVIEWED', 'BANKED', 'ARCHIVED'));
  END IF;
END $$;

-- 2. Add normalized Product and Make (Product Source) foreign keys
ALTER TABLE public.crm_product_documents
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_source_id uuid REFERENCES public.product_sources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS batch_number text,
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES public.batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sha256 text,
  ADD COLUMN IF NOT EXISTS valid_until date,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- 3. Create performance and lookup indices
CREATE INDEX IF NOT EXISTS idx_crm_product_documents_lifecycle_status
  ON public.crm_product_documents(lifecycle_status);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_product_id
  ON public.crm_product_documents(product_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_product_source_id
  ON public.crm_product_documents(product_source_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_sha256
  ON public.crm_product_documents(sha256);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_batch_number
  ON public.crm_product_documents(batch_number)
  WHERE batch_number IS NOT NULL;

-- 4. Initial Backfill:
-- Any document previously marked is_permanent = true becomes BANKED.
-- All other documents start as TEMP.
UPDATE public.crm_product_documents
SET lifecycle_status = 'BANKED'
WHERE is_permanent = true;

UPDATE public.crm_product_documents
SET lifecycle_status = 'TEMP'
WHERE is_permanent = false OR is_permanent IS NULL;

-- Backfill product_id where product_name matches master products table
UPDATE public.crm_product_documents d
SET product_id = p.id
FROM public.products p
WHERE d.product_id IS NULL
  AND d.product_name IS NOT NULL
  AND LOWER(TRIM(d.product_name)) = LOWER(TRIM(p.product_name));

-- Backfill product_source_id (Make) where product_id and make match product_sources
UPDATE public.crm_product_documents d
SET product_source_id = ps.id
FROM public.product_sources ps
WHERE d.product_source_id IS NULL
  AND d.product_id IS NOT NULL
  AND d.make IS NOT NULL
  AND ps.product_id = d.product_id
  AND LOWER(TRIM(ps.supplier_name)) = LOWER(TRIM(d.make));

-- 5. Updated Document Bank Statistics Function
CREATE OR REPLACE FUNCTION public.get_crm_document_bank_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_documents', (SELECT COUNT(*) FROM crm_product_documents),
    'total_document_bytes', (SELECT COALESCE(SUM(file_size), 0) FROM crm_product_documents),
    'temp_count', (SELECT COUNT(*) FROM crm_product_documents WHERE lifecycle_status = 'TEMP'),
    'reviewed_count', (SELECT COUNT(*) FROM crm_product_documents WHERE lifecycle_status = 'REVIEWED'),
    'banked_count', (SELECT COUNT(*) FROM crm_product_documents WHERE lifecycle_status = 'BANKED'),
    'archived_count', (SELECT COUNT(*) FROM crm_product_documents WHERE lifecycle_status = 'ARCHIVED'),
    'bucket_total_objects', (SELECT COUNT(*) FROM storage.objects WHERE bucket_id = 'crm-documents'),
    'bucket_total_bytes', (SELECT COALESCE(SUM((metadata->>'size')::bigint), 0) FROM storage.objects WHERE bucket_id = 'crm-documents'),
    'unlinked_objects_count', (
      SELECT COUNT(*) 
      FROM storage.objects so 
      LEFT JOIN crm_product_documents cpd ON so.bucket_id = 'crm-documents' AND so.name = cpd.storage_path 
      WHERE so.bucket_id = 'crm-documents' AND cpd.id IS NULL
    ),
    'unlinked_objects_bytes', (
      SELECT COALESCE(SUM((so.metadata->>'size')::bigint), 0) 
      FROM storage.objects so 
      LEFT JOIN crm_product_documents cpd ON so.bucket_id = 'crm-documents' AND so.name = cpd.storage_path 
      WHERE so.bucket_id = 'crm-documents' AND cpd.id IS NULL
    ),
    'permanent_count', (SELECT COUNT(*) FROM crm_product_documents WHERE lifecycle_status = 'BANKED'),
    'linked_inquiry_count', (SELECT COUNT(*) FROM crm_product_documents WHERE inquiry_id IS NOT NULL),
    'linked_pricing_option_count', (SELECT COUNT(*) FROM crm_product_documents WHERE pricing_option_id IS NOT NULL)
  ) INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_crm_document_bank_stats() TO authenticated;

