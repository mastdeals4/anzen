-- Migration: 20261108120000_crm_document_bank_bulk_cleanup_and_storage_visibility.sql
-- Description: Add file_size & mime_type to crm_product_documents, backfill from storage.objects,
--              and provide RPCs for Document Bank statistics and Storage Audit inspection.

-- 1. Add file_size and mime_type columns if not present
ALTER TABLE public.crm_product_documents 
  ADD COLUMN IF NOT EXISTS file_size bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mime_type text;

-- 2. Backfill existing file_size and mime_type from storage.objects
UPDATE public.crm_product_documents cpd
SET 
  file_size = COALESCE((so.metadata->>'size')::bigint, 0),
  mime_type = COALESCE(so.metadata->>'mimetype', 'application/octet-stream')
FROM storage.objects so
WHERE so.bucket_id = 'crm-documents' 
  AND so.name = cpd.storage_path;

-- 3. Document Bank Storage & Cleanup Statistics RPC
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
    'junk_other_count', (
      SELECT COUNT(*) 
      FROM crm_product_documents 
      WHERE document_type = 'OTHER' 
        AND (is_permanent = false OR is_permanent IS NULL) 
        AND inquiry_id IS NULL 
        AND pricing_option_id IS NULL
    ),
    'junk_other_bytes', (
      SELECT COALESCE(SUM(file_size), 0) 
      FROM crm_product_documents 
      WHERE document_type = 'OTHER' 
        AND (is_permanent = false OR is_permanent IS NULL) 
        AND inquiry_id IS NULL 
        AND pricing_option_id IS NULL
    ),
    'permanent_count', (SELECT COUNT(*) FROM crm_product_documents WHERE is_permanent = true),
    'linked_inquiry_count', (SELECT COUNT(*) FROM crm_product_documents WHERE inquiry_id IS NOT NULL),
    'linked_pricing_option_count', (SELECT COUNT(*) FROM crm_product_documents WHERE pricing_option_id IS NOT NULL)
  ) INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_crm_document_bank_stats() TO authenticated;

-- 4. Storage Audit: Inspection of unlinked storage objects in crm-documents bucket
CREATE OR REPLACE FUNCTION public.get_crm_unlinked_storage_objects()
RETURNS TABLE (
  id text,
  name text,
  size_bytes bigint,
  mime_type text,
  created_at timestamptz,
  folder text,
  detected_reference text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    so.id::text,
    so.name,
    COALESCE((so.metadata->>'size')::bigint, 0) AS size_bytes,
    COALESCE(so.metadata->>'mimetype', 'unknown') AS mime_type,
    so.created_at,
    split_part(so.name, '/', 1) AS folder,
    CASE
      WHEN so.name LIKE 'bulk-email/%' THEN 'bulk_email_campaigns'
      WHEN so.name LIKE 'requirement-documents/%' THEN 'import_requirements'
      WHEN so.name LIKE 'whatsapp/%' THEN 'whatsapp_messaging'
      ELSE 'unreferenced'
    END AS detected_reference
  FROM storage.objects so
  LEFT JOIN crm_product_documents cpd 
    ON so.bucket_id = 'crm-documents' AND so.name = cpd.storage_path
  WHERE so.bucket_id = 'crm-documents'
    AND cpd.id IS NULL
  ORDER BY size_bytes DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_crm_unlinked_storage_objects() TO authenticated;

