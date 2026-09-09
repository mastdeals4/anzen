-- Migration: 20260909111500_add_document_urls_to_finance_payees.sql
-- Description: Add document_urls TEXT[] column to public.finance_payees for KTP, NPWP, and KYC document uploads.

BEGIN;

ALTER TABLE public.finance_payees
  ADD COLUMN IF NOT EXISTS document_urls TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMIT;
