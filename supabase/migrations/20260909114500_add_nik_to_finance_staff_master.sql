-- Migration: 20260909114500_add_nik_to_finance_staff_master.sql
-- Description: Add nik (Nomor Induk Kependudukan / Citizen ID) to public.finance_staff_master for PPh 21 tax withholding and e-Bupot reporting.

BEGIN;

ALTER TABLE public.finance_staff_master
  ADD COLUMN IF NOT EXISTS nik TEXT;

COMMENT ON COLUMN public.finance_staff_master.nik IS 'Indonesian 16-digit Citizen ID (NIK / KTP) for PPh 21 tax withholding returns';

COMMIT;
