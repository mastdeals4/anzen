/*
  # CRM product documents — sourcing certificate types

  The existing crm_product_documents table is reused for Anvi AI Mail Review.
  This widens document_type safely so Gmail-sourced certificates can keep
  their business label instead of being forced into OTHER.

  Idempotent. No data is deleted.
*/

DO $$
BEGIN
  IF to_regclass('public.crm_product_documents') IS NOT NULL THEN
    ALTER TABLE crm_product_documents
      DROP CONSTRAINT IF EXISTS crm_product_documents_document_type_check;

    ALTER TABLE crm_product_documents
      ADD CONSTRAINT crm_product_documents_document_type_check
      CHECK (document_type IN ('COA', 'MSDS', 'MHD', 'TDS', 'SPEC', 'COC', 'GMP', 'ISO', 'DMF', 'OTHER'));
  END IF;
END $$;
