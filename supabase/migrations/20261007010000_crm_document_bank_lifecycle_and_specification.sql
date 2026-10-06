-- Migration: 20261007010000_crm_document_bank_lifecycle_and_specification.sql
-- Description: Add specification, pricing_option_id, and is_permanent to crm_product_documents

ALTER TABLE public.crm_product_documents
  ADD COLUMN IF NOT EXISTS specification text,
  ADD COLUMN IF NOT EXISTS pricing_option_id uuid REFERENCES public.crm_inquiry_pricing_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_permanent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_pricing_option_id
  ON public.crm_product_documents(pricing_option_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_is_permanent
  ON public.crm_product_documents(is_permanent);

-- Backfill: Any existing documents uploaded by a user are permanently retained
UPDATE public.crm_product_documents
SET is_permanent = true
WHERE uploaded_by IS NOT NULL AND source_gmail_message_id IS NULL;
