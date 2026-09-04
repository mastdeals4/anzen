/*
  # Fix Overly Permissive RLS Policies - Part 6: CRM & Product Management (Final)

  1. CRM Inquiry Items, Product Sources, Email Templates
     - Restrict to non-read-only users
*/

-- 1. crm_inquiry_items
DROP POLICY IF EXISTS "Users can insert inquiry items" ON crm_inquiry_items;
DROP POLICY IF EXISTS "Users can update inquiry items" ON crm_inquiry_items;
DROP POLICY IF EXISTS "Users can delete inquiry items" ON crm_inquiry_items;

CREATE POLICY "Users can insert inquiry items"
  ON crm_inquiry_items FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Users can update inquiry items"
  ON crm_inquiry_items FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Users can delete inquiry items"
  ON crm_inquiry_items FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 2. product_sources
DROP POLICY IF EXISTS "Authenticated users can insert product sources" ON product_sources;
DROP POLICY IF EXISTS "Authenticated users can update product sources" ON product_sources;
DROP POLICY IF EXISTS "Authenticated users can delete product sources" ON product_sources;

CREATE POLICY "Authenticated users can insert product sources"
  ON product_sources FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can update product sources"
  ON product_sources FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can delete product sources"
  ON product_sources FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 3. product_source_documents
DROP POLICY IF EXISTS "Authenticated users can insert source documents" ON product_source_documents;
DROP POLICY IF EXISTS "Authenticated users can update source documents" ON product_source_documents;
DROP POLICY IF EXISTS "Authenticated users can delete source documents" ON product_source_documents;

CREATE POLICY "Authenticated users can insert source documents"
  ON product_source_documents FOR INSERT
  TO authenticated
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can update source documents"
  ON product_source_documents FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());

CREATE POLICY "Authenticated users can delete source documents"
  ON product_source_documents FOR DELETE
  TO authenticated
  USING (NOT is_read_only_user());

-- 4. crm_email_templates
DROP POLICY IF EXISTS "Users can update email template usage" ON crm_email_templates;
CREATE POLICY "Users can update email template usage"
  ON crm_email_templates FOR UPDATE
  TO authenticated
  USING (NOT is_read_only_user())
  WITH CHECK (NOT is_read_only_user());
