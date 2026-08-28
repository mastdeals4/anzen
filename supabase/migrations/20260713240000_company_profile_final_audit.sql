-- ============================================================================
-- Company Profile Versioning — Final Audit Hardening (2026-07-13)
-- ============================================================================
-- 1. Add company_snapshot to purchase_invoices (missed in initial migration)
-- 2. Prevent deletion/update of historical company_profiles that have already
--    been "used" (effective_from <= CURRENT_DATE). Future-dated profiles
--    remain editable so admins can correct typos before the date arrives.
-- ============================================================================

BEGIN;

-- ── 1. purchase_invoices: add company_snapshot + trigger + backfill ───────────

ALTER TABLE public.purchase_invoices
  ADD COLUMN IF NOT EXISTS company_snapshot jsonb;

DROP TRIGGER IF EXISTS trg_snapshot_company_purchase_invoices ON public.purchase_invoices;
CREATE TRIGGER trg_snapshot_company_purchase_invoices
  BEFORE INSERT ON public.purchase_invoices
  FOR EACH ROW EXECUTE FUNCTION public.auto_snapshot_company_profile();

-- Backfill existing rows
UPDATE public.purchase_invoices
SET company_snapshot = public.get_current_company_profile()
WHERE company_snapshot IS NULL;

-- ── 2. Historical company_profiles: immutability protection ───────────────────
-- Prevent any DELETE or UPDATE (except notes) of a company_profiles row once
-- its effective_from date has passed. Future-dated rows are freely editable.
--
-- Rule: if OLD.effective_from <= CURRENT_DATE → raise exception.

CREATE OR REPLACE FUNCTION public.protect_historical_company_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.effective_from <= CURRENT_DATE THEN
      RAISE EXCEPTION
        'Cannot delete historical company profile (effective_from=%). '
        'Historical profiles are immutable because they are embedded in document snapshots.',
        OLD.effective_from;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: allow changes ONLY to future-dated profiles OR notes-only changes
  IF TG_OP = 'UPDATE' THEN
    IF OLD.effective_from <= CURRENT_DATE THEN
      -- Only allow notes to be updated on historical profiles
      IF (NEW.company_name     IS DISTINCT FROM OLD.company_name     OR
          NEW.company_address  IS DISTINCT FROM OLD.company_address  OR
          NEW.company_phone    IS DISTINCT FROM OLD.company_phone    OR
          NEW.company_email    IS DISTINCT FROM OLD.company_email    OR
          NEW.company_tax_id   IS DISTINCT FROM OLD.company_tax_id   OR
          NEW.company_logo_url IS DISTINCT FROM OLD.company_logo_url OR
          NEW.pbf_license      IS DISTINCT FROM OLD.pbf_license      OR
          NEW.cdob_certificate IS DISTINCT FROM OLD.cdob_certificate OR
          NEW.effective_from   IS DISTINCT FROM OLD.effective_from) THEN
        RAISE EXCEPTION
          'Cannot modify a historical company profile (effective_from=%). '
          'Create a new profile version for future documents instead. '
          'Only the "notes" field may be updated on historical profiles.',
          OLD.effective_from;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_company_profile ON public.company_profiles;
CREATE TRIGGER trg_protect_company_profile
  BEFORE DELETE OR UPDATE ON public.company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_historical_company_profile();

NOTIFY pgrst, 'reload schema';

COMMIT;
