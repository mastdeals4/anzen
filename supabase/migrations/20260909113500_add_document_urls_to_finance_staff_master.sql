-- Migration: 20260909113500_add_document_urls_to_finance_staff_master.sql
-- Description: Add document_urls TEXT[] column to public.finance_staff_master for KTP, NPWP, contracts, and HR/KYC document uploads.

BEGIN;

ALTER TABLE public.finance_staff_master
  ADD COLUMN IF NOT EXISTS document_urls TEXT[] NOT NULL DEFAULT '{}'::text[];

COMMIT;
