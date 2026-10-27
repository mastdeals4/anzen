-- ============================================================================
-- Company Profile Edit & Delete Support (2026-07-14)
-- ============================================================================
-- Additive extension to the existing Company Profile Versioning feature.
--
-- Policy: a company profile is locked ONLY when at least one document
-- snapshot references its id. Unreferenced profiles — whether historical,
-- active, or future — may be freely edited/deleted. Editing an unreferenced
-- profile is safe because existing document snapshots are JSONB copies and
-- never change when the underlying profile is edited.
--
-- Contents:
--   1. Add legal_name, website, stamp_url columns to company_profiles.
--   2. Create private `company-assets` storage bucket for logo/stamp uploads.
--   3. get_company_profile_reference_counts() (defined first so the trigger
--      can call it).
--   4. protect_historical_company_profile trigger function replaced with a
--      reference-count based rule (was: effective_from-based).
--   5. delete_company_profile(id) — clean PROFILE_REFERENCED error.
--
-- Does NOT introduce a company_profile_id FK on document tables (the JSONB
-- snapshot design is intentional — history is embedded, not linked).
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

-- ── 1. Add new profile columns ───────────────────────────────────────────────
ALTER TABLE public.company_profiles
  ADD COLUMN IF NOT EXISTS company_legal_name text,
  ADD COLUMN IF NOT EXISTS company_website    text,
  ADD COLUMN IF NOT EXISTS company_stamp_url  text;

-- ── 2. Storage bucket for logo/stamp assets ──────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('company-assets', 'company-assets', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "company_assets_read" ON storage.objects;
CREATE POLICY "company_assets_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'company-assets');

DROP POLICY IF EXISTS "company_assets_admin_write" ON storage.objects;
CREATE POLICY "company_assets_admin_write" ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'company-assets'
    AND EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    bucket_id = 'company-assets'
    AND EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ── 3. Per-profile reference counts across every snapshot-bearing table ──────
CREATE OR REPLACE FUNCTION public.get_company_profile_reference_counts()
RETURNS TABLE (profile_id uuid, ref_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH refs AS (
    SELECT NULLIF(company_snapshot->>'id','')::uuid AS pid FROM sales_invoices     WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM delivery_challans  WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM credit_notes      WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM material_returns  WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM stock_rejections  WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM purchase_orders   WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM payment_vouchers  WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM receipt_vouchers  WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM purchase_invoices WHERE company_snapshot ? 'id'
    UNION ALL SELECT NULLIF(company_snapshot->>'id','')::uuid FROM sales_orders      WHERE company_snapshot ? 'id'
  )
  SELECT pid AS profile_id, count(*)::bigint AS ref_count
  FROM refs
  WHERE pid IS NOT NULL
  GROUP BY pid;
$$;

REVOKE ALL ON FUNCTION public.get_company_profile_reference_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_profile_reference_counts() TO authenticated;

-- ── 4. Reference-based edit/delete guard trigger ─────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_historical_company_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ref_count bigint;
  v_target_id uuid;
BEGIN
  v_target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  SELECT COALESCE(SUM(ref_count), 0) INTO v_ref_count
  FROM public.get_company_profile_reference_counts()
  WHERE profile_id = v_target_id;

  IF v_ref_count > 0 THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'PROFILE_REFERENCED: This Company Profile is referenced by % business document(s) and cannot be deleted. '
        'Historical company identities must remain permanently available.',
        v_ref_count;
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.company_name       IS DISTINCT FROM OLD.company_name       OR
          NEW.company_legal_name IS DISTINCT FROM OLD.company_legal_name OR
          NEW.company_address    IS DISTINCT FROM OLD.company_address    OR
          NEW.company_phone      IS DISTINCT FROM OLD.company_phone      OR
          NEW.company_email      IS DISTINCT FROM OLD.company_email      OR
          NEW.company_website    IS DISTINCT FROM OLD.company_website    OR
          NEW.company_tax_id     IS DISTINCT FROM OLD.company_tax_id     OR
          NEW.company_logo_url   IS DISTINCT FROM OLD.company_logo_url   OR
          NEW.company_stamp_url  IS DISTINCT FROM OLD.company_stamp_url  OR
          NEW.pbf_license        IS DISTINCT FROM OLD.pbf_license        OR
          NEW.cdob_certificate   IS DISTINCT FROM OLD.cdob_certificate   OR
          NEW.effective_from     IS DISTINCT FROM OLD.effective_from) THEN
        RAISE EXCEPTION
          'PROFILE_REFERENCED: This Company Profile is referenced by % business document(s) and cannot be edited. '
          'Create a new profile version for future documents instead. Only the "notes" field may be updated.',
          v_ref_count;
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Ensure the trigger from 20260713240000 is attached.
DROP TRIGGER IF EXISTS trg_protect_company_profile ON public.company_profiles;
CREATE TRIGGER trg_protect_company_profile
  BEFORE DELETE OR UPDATE ON public.company_profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_historical_company_profile();

-- ── 5. Safe delete RPC ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_company_profile(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ref_count bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'FORBIDDEN: Only admins may delete company profiles.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.company_profiles WHERE id = p_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: Company profile does not exist.';
  END IF;

  SELECT COALESCE(SUM(ref_count), 0) INTO v_ref_count
  FROM public.get_company_profile_reference_counts()
  WHERE profile_id = p_id;

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION
      'PROFILE_REFERENCED: This Company Profile is already referenced by % business document(s) and cannot be deleted. Historical company identities must remain permanently available.',
      v_ref_count;
  END IF;

  DELETE FROM public.company_profiles WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_company_profile(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_company_profile(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
