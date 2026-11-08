-- Migration: 20261108200000_crm_product_documents_rls_security_hardening.sql
-- Description: Least-privilege RLS security hardening for CRM Document Bank.
-- 1. Sales can view shared Document Bank records (inquiry_id IS NULL) and their own inquiries.
-- 2. Sales CANNOT access private documents belonging to unauthorized inquiries.
-- 3. Revoke all privileges from anon and public on crm_product_documents.
-- 4. Revoke overly broad anon policies from crm_contact_phones.

-- Rollback script for reference:
-- DROP POLICY IF EXISTS crm_product_documents_read_sales_owned ON public.crm_product_documents;
-- CREATE POLICY crm_product_documents_read_sales_owned ON public.crm_product_documents
--   FOR SELECT TO authenticated
--   USING (
--     current_user_has_pricing_role(ARRAY['sales'::text]) AND (
--       (inquiry_id IS NULL) OR (is_permanent = true) OR (EXISTS (
--         SELECT 1 FROM crm_inquiries ci
--         WHERE ci.id = crm_product_documents.inquiry_id
--           AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
--       ))
--     )
--   );

-- 1. Secure crm_contact_phones by removing overly broad anon access
DROP POLICY IF EXISTS "Allow anon delete crm_contact_phones" ON public.crm_contact_phones;
DROP POLICY IF EXISTS "Allow anon insert crm_contact_phones" ON public.crm_contact_phones;
DROP POLICY IF EXISTS "Allow anon read crm_contact_phones" ON public.crm_contact_phones;
DROP POLICY IF EXISTS "Allow anon update crm_contact_phones" ON public.crm_contact_phones;

-- 2. Hardened least-privilege sales read policy on crm_product_documents
DROP POLICY IF EXISTS crm_product_documents_read_sales_owned ON public.crm_product_documents;
CREATE POLICY crm_product_documents_read_sales_owned ON public.crm_product_documents
  FOR SELECT TO authenticated
  USING (
    current_user_has_pricing_role(ARRAY['sales'::text]) AND (
      (inquiry_id IS NULL)
      OR
      (EXISTS (
        SELECT 1 FROM public.crm_inquiries ci
        WHERE ci.id = crm_product_documents.inquiry_id
          AND (ci.created_by = auth.uid() OR ci.assigned_to = auth.uid())
      ))
    )
  );

-- 3. Explicit privilege revocation from unauthenticated roles
REVOKE ALL ON public.crm_product_documents FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.crm_product_documents TO authenticated, service_role;

