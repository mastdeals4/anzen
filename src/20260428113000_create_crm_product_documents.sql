/*
  # Create CRM Product Documents table

  Tracks versioned product documents uploaded from CRM email/doc workflows.
*/

CREATE TABLE IF NOT EXISTS crm_product_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES crm_inquiries(id) ON DELETE CASCADE,
  email_activity_id uuid REFERENCES crm_email_activities(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  supplier_name text,
  document_type text NOT NULL CHECK (document_type IN ('COA', 'MSDS', 'MHD', 'TDS', 'SPEC', 'OTHER')),
  storage_path text NOT NULL,
  display_name text NOT NULL,
  normalized_key text NOT NULL,
  version_no integer NOT NULL,
  uploaded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_product_documents_key_version
  ON crm_product_documents(normalized_key, version_no);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_inquiry_id
  ON crm_product_documents(inquiry_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_email_activity_id
  ON crm_product_documents(email_activity_id);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_product_name
  ON crm_product_documents(product_name);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_supplier_name
  ON crm_product_documents(supplier_name);

CREATE INDEX IF NOT EXISTS idx_crm_product_documents_document_type
  ON crm_product_documents(document_type);

CREATE OR REPLACE FUNCTION set_crm_product_document_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_version integer;
BEGIN
  IF NEW.normalized_key IS NULL OR btrim(NEW.normalized_key) = '' THEN
    RAISE EXCEPTION 'normalized_key cannot be empty';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.normalized_key));

  IF NEW.version_no IS NULL OR NEW.version_no <= 0 THEN
    SELECT COALESCE(MAX(version_no), 0) + 1
    INTO next_version
    FROM crm_product_documents
    WHERE normalized_key = NEW.normalized_key;

    NEW.version_no := next_version;
  END IF;

  IF NEW.uploaded_at IS NULL THEN
    NEW.uploaded_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_crm_product_document_version ON crm_product_documents;

CREATE TRIGGER trg_set_crm_product_document_version
BEFORE INSERT ON crm_product_documents
FOR EACH ROW
EXECUTE FUNCTION set_crm_product_document_version();

ALTER TABLE crm_product_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read crm product documents" ON crm_product_documents;
CREATE POLICY "Authenticated users can read crm product documents"
  ON crm_product_documents
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Authenticated users can insert crm product documents" ON crm_product_documents;
CREATE POLICY "Authenticated users can insert crm product documents"
  ON crm_product_documents
  FOR INSERT
  TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

DROP POLICY IF EXISTS "Authenticated users can update crm product documents" ON crm_product_documents;
CREATE POLICY "Authenticated users can update crm product documents"
  ON crm_product_documents
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can delete crm product documents" ON crm_product_documents;
CREATE POLICY "Authenticated users can delete crm product documents"
  ON crm_product_documents
  FOR DELETE
  TO authenticated
  USING (true);
