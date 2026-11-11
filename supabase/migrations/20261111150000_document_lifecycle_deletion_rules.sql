-- Universal Document Bank: Exact Lifecycle Deletion Rules
-- Enforces:
-- 1. TEMP with no remaining references: delete Bank record
-- 2. TEMP with other references: remove only current reference
-- 3. BANKED: preserve permanent Bank record
-- 4. ARCHIVED: preserve history

-- 1. crm_product_documents sync trigger function
CREATE OR REPLACE FUNCTION fn_sync_crm_doc_to_universal()
RETURNS trigger AS $$
DECLARE
  v_doc_id UUID;
  v_ver_id UUID;
  v_doc_type TEXT;
  v_bucket TEXT;
  v_path TEXT;
  v_status TEXT;
  v_link_count INT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT id, lifecycle_status INTO v_doc_id, v_status FROM universal_documents 
    WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = OLD.id;

    IF v_doc_id IS NOT NULL THEN
      -- Unlink entity references for this specific legacy record
      IF OLD.inquiry_id IS NOT NULL THEN
        DELETE FROM universal_document_links 
        WHERE document_id = v_doc_id AND entity_type = 'crm_inquiry' AND entity_id = OLD.inquiry_id;
      END IF;
      IF OLD.pricing_option_id IS NOT NULL THEN
        DELETE FROM universal_document_links 
        WHERE document_id = v_doc_id AND entity_type = 'crm_quote' AND entity_id = OLD.pricing_option_id;
      END IF;

      -- LIFECYCLE CONTRACT:
      -- 1. BANKED: PRESERVE permanent Bank record!
      IF v_status = 'BANKED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;

      -- 2. ARCHIVED: PRESERVE history!
      ELSIF v_status = 'ARCHIVED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;

      -- 3. TEMP:
      ELSIF v_status = 'TEMP' THEN
        SELECT count(*) INTO v_link_count FROM universal_document_links WHERE document_id = v_doc_id;
        IF v_link_count = 0 THEN
          -- TEMP with no remaining references: delete Bank record
          DELETE FROM universal_document_versions WHERE document_id = v_doc_id;
          DELETE FROM universal_documents WHERE id = v_doc_id;
        ELSE
          -- TEMP with other references: remove only the current reference
          UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT id INTO v_doc_id FROM universal_documents 
    WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = NEW.id;

    IF v_doc_id IS NOT NULL THEN
      v_status := COALESCE(NEW.lifecycle_status, CASE WHEN NEW.is_permanent THEN 'BANKED' ELSE 'TEMP' END);
      
      UPDATE universal_documents 
      SET 
        lifecycle_status = v_status,
        specification = COALESCE(NEW.specification, universal_documents.specification),
        primary_product_id = COALESCE(NEW.product_id, universal_documents.primary_product_id),
        primary_product_source_id = COALESCE(NEW.product_source_id, universal_documents.primary_product_source_id),
        primary_batch_id = COALESCE(NEW.batch_id, universal_documents.primary_batch_id),
        batch_number = COALESCE(NEW.batch_number, universal_documents.batch_number),
        valid_until = COALESCE(NEW.valid_until, universal_documents.valid_until),
        reviewed_by = COALESCE(NEW.reviewed_by, universal_documents.reviewed_by),
        reviewed_at = COALESCE(NEW.reviewed_at, universal_documents.reviewed_at),
        updated_at = now()
      WHERE id = v_doc_id;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF EXISTS (SELECT 1 FROM universal_documents WHERE legacy_source_table = 'crm_product_documents' AND legacy_source_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  v_doc_type := COALESCE(NEW.document_type, 'OTHER TECHNICAL');
  IF v_doc_type = 'SPEC' THEN
    v_doc_type := 'SPECIFICATION';
  END IF;

  v_status := COALESCE(NEW.lifecycle_status, CASE WHEN NEW.is_permanent THEN 'BANKED' ELSE 'TEMP' END);

  v_bucket := COALESCE(NEW.storage_bucket, 'crm-documents');
  v_path := COALESCE(NEW.storage_path, '');

  INSERT INTO universal_documents (
    title, document_type, specification, lifecycle_status, source_module,
    primary_product_id, primary_product_source_id, primary_batch_id, batch_number,
    valid_until, reviewed_by, reviewed_at,
    legacy_source_table, legacy_source_id, created_by, created_at, updated_at
  ) VALUES (
    COALESCE(NEW.display_file_name, NEW.original_file_name, 'CRM Document'),
    v_doc_type,
    NEW.specification,
    v_status,
    'crm',
    NEW.product_id,
    NEW.product_source_id,
    NEW.batch_id,
    NEW.batch_number,
    NEW.valid_until,
    NEW.reviewed_by,
    NEW.reviewed_at,
    'crm_product_documents',
    NEW.id,
    NEW.uploaded_by,
    COALESCE(NEW.created_at, now()),
    now()
  ) RETURNING id INTO v_doc_id;

  INSERT INTO universal_document_versions (
    document_id, version_number, storage_bucket, storage_path, file_url,
    original_file_name, file_size, mime_type, sha256, change_summary, is_current, uploaded_by, created_at
  ) VALUES (
    v_doc_id, 1, v_bucket, v_path, NULL,
    COALESCE(NEW.original_file_name, 'CRM Document'),
    COALESCE(NEW.file_size, 0),
    NEW.mime_type,
    NEW.sha256,
    'Synced from crm_product_documents',
    true,
    NEW.uploaded_by,
    COALESCE(NEW.created_at, now())
  ) RETURNING id INTO v_ver_id;

  UPDATE universal_documents SET current_version_id = v_ver_id WHERE id = v_doc_id;

  IF NEW.inquiry_id IS NOT NULL THEN
    INSERT INTO universal_document_links (
      document_id, document_version_id, entity_type, entity_id,
      product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
    ) VALUES (
      v_doc_id, v_ver_id, 'crm_inquiry', NEW.inquiry_id,
      NEW.product_id, NEW.product_source_id, NEW.batch_id, NEW.batch_number, false, NEW.uploaded_by, COALESCE(NEW.created_at, now())
    );
  END IF;

  IF NEW.pricing_option_id IS NOT NULL THEN
    INSERT INTO universal_document_links (
      document_id, document_version_id, entity_type, entity_id,
      product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
    ) VALUES (
      v_doc_id, v_ver_id, 'crm_quote', NEW.pricing_option_id,
      NEW.product_id, NEW.product_source_id, NEW.batch_id, NEW.batch_number, false, NEW.uploaded_by, COALESCE(NEW.created_at, now())
    );
  END IF;

  IF NEW.product_id IS NOT NULL THEN
    INSERT INTO universal_document_links (
      document_id, document_version_id, entity_type, entity_id,
      product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
    ) VALUES (
      v_doc_id, v_ver_id, 'product', NEW.product_id,
      NEW.product_id, NEW.product_source_id, NEW.batch_id, NEW.batch_number, true, NEW.uploaded_by, COALESCE(NEW.created_at, now())
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. product_source_documents sync trigger function
CREATE OR REPLACE FUNCTION fn_sync_product_source_doc_to_universal()
RETURNS trigger AS $$
DECLARE
  v_source RECORD;
  v_doc_id UUID;
  v_ver_id UUID;
  v_doc_type TEXT;
  v_bucket TEXT;
  v_path TEXT;
  v_status TEXT;
  v_link_count INT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT id, lifecycle_status INTO v_doc_id, v_status FROM universal_documents 
    WHERE legacy_source_table = 'product_source_documents' AND legacy_source_id = OLD.id;

    IF v_doc_id IS NOT NULL THEN
      DELETE FROM universal_document_links 
      WHERE document_id = v_doc_id AND entity_type = 'product_source' AND entity_id = OLD.source_id;

      IF v_status = 'BANKED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'ARCHIVED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'TEMP' THEN
        SELECT count(*) INTO v_link_count FROM universal_document_links WHERE document_id = v_doc_id;
        IF v_link_count = 0 THEN
          DELETE FROM universal_document_versions WHERE document_id = v_doc_id;
          DELETE FROM universal_documents WHERE id = v_doc_id;
        ELSE
          UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT id INTO v_doc_id FROM universal_documents 
    WHERE legacy_source_table = 'product_source_documents' AND legacy_source_id = NEW.id;

    IF v_doc_id IS NOT NULL THEN
      UPDATE universal_documents 
      SET 
        title = COALESCE(NEW.original_filename, universal_documents.title),
        notes = NEW.notes,
        updated_at = now()
      WHERE id = v_doc_id;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF EXISTS (SELECT 1 FROM universal_documents WHERE legacy_source_table = 'product_source_documents' AND legacy_source_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT product_id, supplier_name, grade, country INTO v_source FROM product_sources WHERE id = NEW.source_id;

  IF NEW.doc_type ILIKE '%coa%' THEN
    v_doc_type := 'COA';
  ELSIF NEW.doc_type ILIKE '%msds%' THEN
    v_doc_type := 'MSDS';
  ELSIF NEW.doc_type ILIKE '%gmp%' THEN
    v_doc_type := 'GMP';
  ELSIF NEW.doc_type ILIKE '%halal%' THEN
    v_doc_type := 'HALAL';
  ELSIF NEW.doc_type ILIKE '%dmf%' THEN
    v_doc_type := 'DMF';
  ELSIF NEW.doc_type ILIKE '%tds%' THEN
    v_doc_type := 'TDS';
  ELSIF NEW.doc_type ILIKE '%spec%' THEN
    v_doc_type := 'SPECIFICATION';
  ELSE
    v_doc_type := 'OTHER TECHNICAL';
  END IF;

  v_bucket := 'product-source-documents';
  v_path := COALESCE(NEW.file_url, '');
  IF POSITION('/public/product-source-documents/' IN v_path) > 0 THEN
    v_path := SUBSTRING(v_path FROM POSITION('/public/product-source-documents/' IN v_path) + 33);
  END IF;

  INSERT INTO universal_documents (
    title, document_type, specification, lifecycle_status, source_module,
    primary_product_id, primary_product_source_id, notes,
    legacy_source_table, legacy_source_id, created_by, created_at, updated_at
  ) VALUES (
    COALESCE(NEW.original_filename, 'Product Source Document'),
    v_doc_type,
    v_source.grade,
    'BANKED',
    'products',
    v_source.product_id,
    NEW.source_id,
    NEW.notes,
    'product_source_documents',
    NEW.id,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now()),
    now()
  ) RETURNING id INTO v_doc_id;

  INSERT INTO universal_document_versions (
    document_id, version_number, storage_bucket, storage_path, file_url,
    original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
  ) VALUES (
    v_doc_id, 1, v_bucket, v_path, NEW.file_url,
    COALESCE(NEW.original_filename, 'Product Source Document'),
    COALESCE(NEW.file_size, 0),
    'Synced from product_source_documents',
    true,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now())
  ) RETURNING id INTO v_ver_id;

  UPDATE universal_documents SET current_version_id = v_ver_id WHERE id = v_doc_id;

  INSERT INTO universal_document_links (
    document_id, document_version_id, entity_type, entity_id,
    product_id, product_source_id, is_primary, created_by, created_at
  ) VALUES (
    v_doc_id, v_ver_id, 'product_source', NEW.source_id,
    v_source.product_id, NEW.source_id, true, NEW.uploaded_by, COALESCE(NEW.uploaded_at, now())
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. product_documents sync trigger function
CREATE OR REPLACE FUNCTION fn_sync_product_doc_to_universal()
RETURNS trigger AS $$
DECLARE
  v_doc_id UUID;
  v_ver_id UUID;
  v_doc_type TEXT;
  v_bucket TEXT;
  v_path TEXT;
  v_status TEXT;
  v_link_count INT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT id, lifecycle_status INTO v_doc_id, v_status FROM universal_documents 
    WHERE legacy_source_table = 'product_documents' AND legacy_source_id = OLD.id;

    IF v_doc_id IS NOT NULL THEN
      DELETE FROM universal_document_links 
      WHERE document_id = v_doc_id AND entity_type = 'product' AND entity_id = OLD.product_id;

      IF v_status = 'BANKED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'ARCHIVED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'TEMP' THEN
        SELECT count(*) INTO v_link_count FROM universal_document_links WHERE document_id = v_doc_id;
        IF v_link_count = 0 THEN
          DELETE FROM universal_document_versions WHERE document_id = v_doc_id;
          DELETE FROM universal_documents WHERE id = v_doc_id;
        ELSE
          UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT id INTO v_doc_id FROM universal_documents 
    WHERE legacy_source_table = 'product_documents' AND legacy_source_id = NEW.id;

    IF v_doc_id IS NOT NULL THEN
      UPDATE universal_documents 
      SET 
        title = COALESCE(NEW.file_name, universal_documents.title),
        updated_at = now()
      WHERE id = v_doc_id;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF EXISTS (SELECT 1 FROM universal_documents WHERE legacy_source_table = 'product_documents' AND legacy_source_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  IF NEW.document_type ILIKE '%coa%' THEN
    v_doc_type := 'COA';
  ELSIF NEW.document_type ILIKE '%msds%' THEN
    v_doc_type := 'MSDS';
  ELSIF NEW.document_type ILIKE '%gmp%' THEN
    v_doc_type := 'GMP';
  ELSE
    v_doc_type := 'OTHER TECHNICAL';
  END IF;

  v_bucket := 'product-documents';
  v_path := COALESCE(NEW.file_url, '');
  IF POSITION('/public/product-documents/' IN v_path) > 0 THEN
    v_path := SUBSTRING(v_path FROM POSITION('/public/product-documents/' IN v_path) + 26);
  END IF;

  INSERT INTO universal_documents (
    title, document_type, lifecycle_status, source_module,
    primary_product_id, legacy_source_table, legacy_source_id, created_by, created_at, updated_at
  ) VALUES (
    COALESCE(NEW.file_name, 'Product Document'),
    v_doc_type,
    'BANKED',
    'products',
    NEW.product_id,
    'product_documents',
    NEW.id,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now()),
    now()
  ) RETURNING id INTO v_doc_id;

  INSERT INTO universal_document_versions (
    document_id, version_number, storage_bucket, storage_path, file_url,
    original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
  ) VALUES (
    v_doc_id, 1, v_bucket, v_path, NEW.file_url,
    COALESCE(NEW.file_name, 'Product Document'),
    COALESCE(NEW.file_size, 0),
    'Synced from product_documents',
    true,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now())
  ) RETURNING id INTO v_ver_id;

  UPDATE universal_documents SET current_version_id = v_ver_id WHERE id = v_doc_id;

  INSERT INTO universal_document_links (
    document_id, document_version_id, entity_type, entity_id,
    product_id, is_primary, created_by, created_at
  ) VALUES (
    v_doc_id, v_ver_id, 'product', NEW.product_id,
    NEW.product_id, true, NEW.uploaded_by, COALESCE(NEW.uploaded_at, now())
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. batch_documents sync trigger function
CREATE OR REPLACE FUNCTION fn_sync_batch_doc_to_universal()
RETURNS trigger AS $$
DECLARE
  v_batch RECORD;
  v_doc_id UUID;
  v_ver_id UUID;
  v_doc_type TEXT;
  v_bucket TEXT;
  v_path TEXT;
  v_status TEXT;
  v_link_count INT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT id, lifecycle_status INTO v_doc_id, v_status FROM universal_documents 
    WHERE legacy_source_table = 'batch_documents' AND legacy_source_id = OLD.id;

    IF v_doc_id IS NOT NULL THEN
      DELETE FROM universal_document_links 
      WHERE document_id = v_doc_id AND entity_type = 'batch' AND entity_id = OLD.batch_id;

      IF v_status = 'BANKED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'ARCHIVED' THEN
        UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
      ELSIF v_status = 'TEMP' THEN
        SELECT count(*) INTO v_link_count FROM universal_document_links WHERE document_id = v_doc_id;
        IF v_link_count = 0 THEN
          DELETE FROM universal_document_versions WHERE document_id = v_doc_id;
          DELETE FROM universal_documents WHERE id = v_doc_id;
        ELSE
          UPDATE universal_documents SET legacy_source_id = NULL WHERE id = v_doc_id;
        END IF;
      END IF;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT id INTO v_doc_id FROM universal_documents 
    WHERE legacy_source_table = 'batch_documents' AND legacy_source_id = NEW.id;

    IF v_doc_id IS NOT NULL THEN
      UPDATE universal_documents 
      SET 
        title = COALESCE(NEW.file_name, universal_documents.title),
        updated_at = now()
      WHERE id = v_doc_id;
    END IF;
    RETURN NEW;
  END IF;

  -- TG_OP = 'INSERT'
  IF EXISTS (SELECT 1 FROM universal_documents WHERE legacy_source_table = 'batch_documents' AND legacy_source_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT batch_number, product_id, make_id INTO v_batch FROM batches WHERE id = NEW.batch_id;
  
  IF NEW.file_type ILIKE '%coa%' THEN
    v_doc_type := 'COA';
  ELSIF NEW.file_type ILIKE '%invoice%' THEN
    v_doc_type := 'PURCHASE INVOICE';
  ELSIF NEW.file_type ILIKE '%msds%' THEN
    v_doc_type := 'MSDS';
  ELSE
    v_doc_type := 'OTHER TECHNICAL';
  END IF;

  v_bucket := 'batch-documents';
  v_path := COALESCE(NEW.file_url, '');
  IF POSITION('/public/batch-documents/' IN v_path) > 0 THEN
    v_path := SUBSTRING(v_path FROM POSITION('/public/batch-documents/' IN v_path) + 24);
  END IF;

  INSERT INTO universal_documents (
    title, document_type, lifecycle_status, source_module,
    primary_product_id, primary_product_source_id, primary_batch_id, batch_number,
    legacy_source_table, legacy_source_id, created_by, created_at, updated_at
  ) VALUES (
    COALESCE(NEW.file_name, 'Batch Document'),
    v_doc_type,
    'BANKED',
    'batches',
    v_batch.product_id,
    v_batch.make_id,
    NEW.batch_id,
    v_batch.batch_number,
    'batch_documents',
    NEW.id,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now()),
    now()
  ) RETURNING id INTO v_doc_id;

  INSERT INTO universal_document_versions (
    document_id, version_number, storage_bucket, storage_path, file_url,
    original_file_name, file_size, change_summary, is_current, uploaded_by, created_at
  ) VALUES (
    v_doc_id, 1, v_bucket, v_path, NEW.file_url,
    COALESCE(NEW.file_name, 'Batch Document'),
    COALESCE(NEW.file_size, 0),
    'Synced from batch_documents',
    true,
    NEW.uploaded_by,
    COALESCE(NEW.uploaded_at, now())
  ) RETURNING id INTO v_ver_id;

  UPDATE universal_documents SET current_version_id = v_ver_id WHERE id = v_doc_id;

  INSERT INTO universal_document_links (
    document_id, document_version_id, entity_type, entity_id,
    product_id, product_source_id, batch_id, batch_number, is_primary, created_by, created_at
  ) VALUES (
    v_doc_id, v_ver_id, 'batch', NEW.batch_id,
    v_batch.product_id, v_batch.make_id, NEW.batch_id, v_batch.batch_number,
    true, NEW.uploaded_by, COALESCE(NEW.uploaded_at, now())
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
