/*
  # CRM product documents for Gmail-sourced certificates

  Creates the missing crm_product_documents table used by Anvi AI Mail Review
  when a reviewed Gmail attachment is saved to private CRM document storage.

  Idempotent and additive. No existing CRM pages, pricing tables, or Gmail
  OAuth configuration are changed.
*/

INSERT INTO storage.buckets (id, name, public)
VALUES ('crm-documents', 'crm-documents', false)
ON CONFLICT (id) DO UPDATE
SET public = false;

CREATE TABLE IF NOT EXISTS crm_product_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  product_name text,
  make text,
  document_type text CHECK (document_type IN ('COA','MSDS','MHD','TDS','SPEC','COC','GMP','ISO','DMF','OTHER')),
  original_file_name text,
  display_file_name text,
  storage_bucket text DEFAULT 'crm-documents',
  storage_path text NOT NULL,
  source_gmail_message_id text,
  source_gmail_thread_id text,
  source_email_subject text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE crm_product_documents ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_inquiry_id
  ON crm_product_documents(inquiry_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_document_type
  ON crm_product_documents(document_type);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_uploaded_by
  ON crm_product_documents(uploaded_by);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_gmail_message
  ON crm_product_documents(source_gmail_message_id)
  WHERE source_gmail_message_id IS NOT NULL;

DROP POLICY IF EXISTS "crm_product_documents_read_admin_manager" ON crm_product_documents;
DROP POLICY IF EXISTS "crm_product_documents_read_sales_owned" ON crm_product_documents;
DROP POLICY IF EXISTS "crm_product_documents_insert_admin_manager" ON crm_product_documents;
DROP POLICY IF EXISTS "crm_product_documents_update_admin_manager" ON crm_product_documents;
DROP POLICY IF EXISTS "crm_product_documents_delete_admin_manager" ON crm_product_documents;

CREATE POLICY "crm_product_documents_read_admin_manager" ON crm_product_documents
  FOR SELECT TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "crm_product_documents_read_sales_owned" ON crm_product_documents
  FOR SELECT TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['sales'])
    AND EXISTS (
      SELECT 1
        FROM crm_inquiries ci
       WHERE ci.id = crm_product_documents.inquiry_id
         AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
    )
  );

CREATE POLICY "crm_product_documents_insert_admin_manager" ON crm_product_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    current_user_has_pricing_role(ARRAY['admin','manager'])
    AND uploaded_by = auth.uid()
  );

CREATE POLICY "crm_product_documents_update_admin_manager" ON crm_product_documents
  FOR UPDATE TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']))
  WITH CHECK (current_user_has_pricing_role(ARRAY['admin','manager']));

CREATE POLICY "crm_product_documents_delete_admin_manager" ON crm_product_documents
  FOR DELETE TO authenticated
  USING (current_user_has_pricing_role(ARRAY['admin','manager']));

