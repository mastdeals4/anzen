ALTER TABLE IF EXISTS product_source_documents
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS storage_path text;

CREATE INDEX IF NOT EXISTS idx_product_source_documents_storage_path
  ON product_source_documents(storage_path);
