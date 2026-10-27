-- Migration: 20261027200000_harden_credit_note_number_generation_and_permissions.sql
-- Purpose:
--   1. Harden generate_credit_note_number() with SECURITY DEFINER and grant EXECUTE to authenticated users.
--   2. Enforce server-side BEFORE INSERT trigger on credit_notes to automatically generate canonical sequence
--      number (CN-YY-XXXX) whenever credit_note_number is omitted, null, or empty string.
--   3. Provide a separate, safe data-repair procedure for unnumbered legacy record 83953d95-7baf-4a07-b7c5-b63d6f08945c.

-- 1. Harden generate_credit_note_number
CREATE OR REPLACE FUNCTION public.generate_credit_note_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_year text;
  v_number text;
BEGIN
  v_year := TO_CHAR(CURRENT_DATE, 'YY');
  v_number := LPAD(nextval('credit_note_number_seq')::text, 4, '0');
  RETURN 'CN-' || v_year || '-' || v_number;
END;
$$;

GRANT EXECUTE ON FUNCTION public.generate_credit_note_number() TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_credit_note_number() TO anon;

-- 2. Server-side auto-numbering trigger
CREATE OR REPLACE FUNCTION public.trg_ensure_credit_note_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.credit_note_number IS NULL OR trim(NEW.credit_note_number) = '' THEN
    NEW.credit_note_number := public.generate_credit_note_number();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_credit_note_number ON public.credit_notes;
CREATE TRIGGER trg_ensure_credit_note_number
  BEFORE INSERT ON public.credit_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_ensure_credit_note_number();

-- 3. Production Data Repair Plan (To be reviewed and approved prior to production execution)
-- Record ID: 83953d95-7baf-4a07-b7c5-b63d6f08945c
-- Invoice: SAPJ-26-013 (03162b99-b06b-475b-b00c-e14cb9dd6123)
-- Customer: 47410ca0-44b7-423a-8d85-09bdc3aa2c78
-- Precondition: credit_note_number is empty/null, status = 'pending_approval'
/*
DO $$
DECLARE
  v_target_id uuid := '83953d95-7baf-4a07-b7c5-b63d6f08945c';
  v_new_number text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.credit_notes
    WHERE id = v_target_id AND (credit_note_number IS NULL OR trim(credit_note_number) = '')
  ) THEN
    v_new_number := public.generate_credit_note_number();
    UPDATE public.credit_notes
    SET credit_note_number = v_new_number,
        updated_at = now()
    WHERE id = v_target_id;
    RAISE NOTICE 'Credit Note % repaired with number %', v_target_id, v_new_number;
  END IF;
END $$;
*/

