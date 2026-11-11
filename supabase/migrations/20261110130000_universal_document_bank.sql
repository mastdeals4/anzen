-- ====================================================================
-- MIGRATION: 20261110130000_universal_document_bank.sql
-- PURPOSE: Unified Universal Document Bank Across Entire ERP
-- ARCHITECTURE: One Physical File -> One Central Document Record -> Multiple Authorized References
-- ====================================================================

-- 1. Create universal_documents table (Logical document entity)
CREATE TABLE IF NOT EXISTS universal_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (
    document_type IN (
      'COA', 'MSDS', 'GMP', 'HALAL', 'SPECIFICATION', 'TDS', 'DMF',
      'MANUFACTURING LICENCE', 'PRODUCT CATALOGUE', 'PURCHASE ORDER',
      'SALES INVOICE', 'EXPENSE RECEIPT', 'OTHER TECHNICAL', 'OTHER'
    )
  ),
  specification TEXT,
  document_date DATE,
  valid_until DATE,
  lifecycle_status TEXT NOT NULL DEFAULT 'TEMP' CHECK (
    lifecycle_status IN ('TEMP', 'REVIEWED', 'BANKED', 'ARCHIVED')
  ),
  source_module TEXT NOT NULL DEFAULT 'crm' CHECK (
    source_module IN (
      'products', 'crm', 'pricing', 'sourcing', 'batches',
      'purchase', 'sales', 'finance', 'system'
    )
  ),
  notes TEXT,
  is_confidential BOOLEAN NOT NULL DEFAULT false,
  
  -- Master references
  primary_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  primary_product_source_id UUID REFERENCES product_sources(id) ON DELETE SET NULL,
  primary_batch_id UUID REFERENCES batches(id) ON DELETE SET NULL,
  batch_number TEXT,
  
  -- Current version pointer
  current_version_id UUID,
  
  -- Lineage / Audit
  legacy_source_table TEXT,
  legacy_source_id UUID,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ
);

-- 2. Create universal_document_versions table (Physical files & version history)
CREATE TABLE IF NOT EXISTS universal_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES universal_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL DEFAULT 1,
  storage_bucket TEXT NOT NULL DEFAULT 'documents',
  storage_path TEXT NOT NULL,
  file_url TEXT,
  original_file_name TEXT NOT NULL,
  file_size BIGINT NOT NULL DEFAULT 0,
  mime_type TEXT,
  sha256 TEXT,
  change_summary TEXT DEFAULT 'Initial version',
  is_current BOOLEAN NOT NULL DEFAULT true,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_universal_doc_version UNIQUE (document_id, version_number)
);

-- Circular constraint resolution for current_version_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'fk_universal_documents_current_version'
  ) THEN
    ALTER TABLE universal_documents
      ADD CONSTRAINT fk_universal_documents_current_version
      FOREIGN KEY (current_version_id)
      REFERENCES universal_document_versions(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- 3. Create universal_document_links table (Multi-entity associations)
CREATE TABLE IF NOT EXISTS universal_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES universal_documents(id) ON DELETE CASCADE,
  document_version_id UUID REFERENCES universal_document_versions(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'product', 'product_source', 'batch', 'crm_inquiry', 'crm_quote',
      'purchase_order', 'purchase_invoice', 'sales_order', 'sales_invoice',
      'expense', 'other'
    )
  ),
  entity_id UUID NOT NULL,
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  product_source_id UUID REFERENCES product_sources(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES batches(id) ON DELETE CASCADE,
  batch_number TEXT,
  notes TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Create Performance Indices
CREATE INDEX IF NOT EXISTS idx_universal_docs_lifecycle ON universal_documents(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_universal_docs_type ON universal_documents(document_type);
CREATE INDEX IF NOT EXISTS idx_universal_docs_prod ON universal_documents(primary_product_id);
CREATE INDEX IF NOT EXISTS idx_universal_docs_source ON universal_documents(primary_product_source_id);
CREATE INDEX IF NOT EXISTS idx_universal_docs_batch ON universal_documents(primary_batch_id);
CREATE INDEX IF NOT EXISTS idx_universal_docs_batch_num ON universal_documents(batch_number);
CREATE INDEX IF NOT EXISTS idx_universal_docs_expiry ON universal_documents(valid_until);
CREATE INDEX IF NOT EXISTS idx_universal_docs_module ON universal_documents(source_module);

CREATE INDEX IF NOT EXISTS idx_universal_doc_versions_doc_id ON universal_document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_universal_doc_versions_sha256 ON universal_document_versions(sha256);
CREATE INDEX IF NOT EXISTS idx_universal_doc_versions_storage ON universal_document_versions(storage_bucket, storage_path);

CREATE INDEX IF NOT EXISTS idx_universal_doc_links_doc ON universal_document_links(document_id);
CREATE INDEX IF NOT EXISTS idx_universal_doc_links_entity ON universal_document_links(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_universal_doc_links_prod ON universal_document_links(product_id);
CREATE INDEX IF NOT EXISTS idx_universal_doc_links_source ON universal_document_links(product_source_id);
CREATE INDEX IF NOT EXISTS idx_universal_doc_links_batch ON universal_document_links(batch_id);

-- 5. Row Level Security Policies
ALTER TABLE universal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE universal_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE universal_document_links ENABLE ROW LEVEL SECURITY;

-- Read policies
DROP POLICY IF EXISTS "universal_documents_read_policy" ON universal_documents;
CREATE POLICY "universal_documents_read_policy" ON universal_documents
  FOR SELECT TO authenticated
  USING (
    NOT is_confidential 
    OR (auth.uid() = created_by)
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "universal_document_versions_read_policy" ON universal_document_versions;
CREATE POLICY "universal_document_versions_read_policy" ON universal_document_versions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM universal_documents d
      WHERE d.id = universal_document_versions.document_id
        AND (
          NOT d.is_confidential 
          OR (auth.uid() = d.created_by)
          OR EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid() AND role IN ('admin', 'manager')
          )
        )
    )
  );

DROP POLICY IF EXISTS "universal_document_links_read_policy" ON universal_document_links;
CREATE POLICY "universal_document_links_read_policy" ON universal_document_links
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM universal_documents d
      WHERE d.id = universal_document_links.document_id
        AND (
          NOT d.is_confidential 
          OR (auth.uid() = d.created_by)
          OR EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid() AND role IN ('admin', 'manager')
          )
        )
    )
  );

-- Insert policies
DROP POLICY IF EXISTS "universal_documents_insert_policy" ON universal_documents;
CREATE POLICY "universal_documents_insert_policy" ON universal_documents
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "universal_document_versions_insert_policy" ON universal_document_versions;
CREATE POLICY "universal_document_versions_insert_policy" ON universal_document_versions
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "universal_document_links_insert_policy" ON universal_document_links;
CREATE POLICY "universal_document_links_insert_policy" ON universal_document_links
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Update policies
DROP POLICY IF EXISTS "universal_documents_update_policy" ON universal_documents;
CREATE POLICY "universal_documents_update_policy" ON universal_documents
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager', 'sales')
    )
  )
  WITH CHECK (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager', 'sales')
    )
  );

DROP POLICY IF EXISTS "universal_document_versions_update_policy" ON universal_document_versions;
CREATE POLICY "universal_document_versions_update_policy" ON universal_document_versions
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = uploaded_by
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "universal_document_links_update_policy" ON universal_document_links;
CREATE POLICY "universal_document_links_update_policy" ON universal_document_links
  FOR UPDATE TO authenticated
  USING (
    auth.uid() = created_by
    OR EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager', 'sales')
    )
  );

-- Delete policies
DROP POLICY IF EXISTS "universal_documents_delete_policy" ON universal_documents;
CREATE POLICY "universal_documents_delete_policy" ON universal_documents
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
    OR (auth.uid() = created_by AND lifecycle_status = 'TEMP')
  );

DROP POLICY IF EXISTS "universal_document_versions_delete_policy" ON universal_document_versions;
CREATE POLICY "universal_document_versions_delete_policy" ON universal_document_versions
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager')
    )
  );

DROP POLICY IF EXISTS "universal_document_links_delete_policy" ON universal_document_links;
CREATE POLICY "universal_document_links_delete_policy" ON universal_document_links
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'manager', 'sales')
    )
  );

-- 6. Unified Universal Document Bank View (Lightning fast queries)
DROP VIEW IF EXISTS vw_universal_document_bank;
CREATE OR REPLACE VIEW vw_universal_document_bank AS
SELECT 
  d.id,
  d.title,
  d.document_type,
  d.specification,
  d.document_date,
  d.valid_until,
  d.lifecycle_status,
  d.source_module,
  d.notes,
  d.is_confidential,
  d.primary_product_id,
  d.primary_product_source_id,
  d.primary_batch_id,
  d.batch_number,
  d.current_version_id,
  d.legacy_source_table,
  d.legacy_source_id,
  d.created_by,
  d.created_at,
  d.updated_at,
  d.reviewed_by,
  d.reviewed_at,
  -- Product details
  p.product_name,
  p.category AS product_category,
  p.hsn_code,
  -- Make / Manufacturer details
  ps.supplier_name AS make_name,
  ps.grade AS make_grade,
  ps.country AS make_country,
  -- Batch details
  b.batch_number AS linked_batch_number,
  -- Active Version details
  v.version_number,
  v.storage_bucket,
  v.storage_path,
  v.file_url,
  v.original_file_name,
  v.file_size,
  v.mime_type,
  v.sha256,
  v.change_summary,
  -- Aggregated Counts
  (
    SELECT count(*)::int 
    FROM universal_document_versions uv 
    WHERE uv.document_id = d.id
  ) AS version_count,
  (
    SELECT count(*)::int 
    FROM universal_document_links ul 
    WHERE ul.document_id = d.id
  ) AS link_count,
  -- Expiry indicator
  CASE 
    WHEN d.valid_until IS NOT NULL AND d.valid_until < CURRENT_DATE THEN true 
    ELSE false 
  END AS is_expired
FROM universal_documents d
LEFT JOIN universal_document_versions v ON d.current_version_id = v.id
LEFT JOIN products p ON d.primary_product_id = p.id
LEFT JOIN product_sources ps ON d.primary_product_source_id = ps.id
LEFT JOIN batches b ON d.primary_batch_id = b.id;
