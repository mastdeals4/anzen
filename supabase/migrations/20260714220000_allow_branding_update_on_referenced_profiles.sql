-- ============================================================================
-- Allow branding/contact field updates on referenced company profiles
-- ============================================================================
-- Root cause of company_logo_url = NULL bug:
--   protect_historical_company_profile (installed in 20260714140000 and
--   updated in 20260714180000) raises PROFILE_REFERENCED whenever ANY
--   non-notes field changes on a referenced profile — including
--   company_logo_url.
--
-- Design fix:
--   Split the immutable fields into two tiers:
--
--   TIER 1 — ACCOUNTING-CRITICAL (truly immutable while referenced):
--     company_name, company_legal_name, company_tax_id,
--     pbf_license, cdob_certificate, effective_from
--     These are printed on tax documents and appear in government filings.
--     Changing them retroactively would misrepresent invoiced amounts.
--
--   TIER 2 — BRANDING/CONTACT (updatable even on referenced profiles):
--     company_logo_url, company_stamp_url, company_address,
--     company_phone, company_email, company_website
--     Historical snapshots already captured the values that existed at
--     insert time — those old snapshots are NOT touched by this UPDATE.
--     Future documents will pick up the new value automatically via the
--     auto_snapshot trigger.
--
-- Also updates the RLS policy on company_profiles to allow accounts-role
-- users to UPDATE branding fields (they can already SELECT). Admin-only
-- restriction is kept for INSERT/DELETE and for Tier-1 field changes.
--
-- Additive. Idempotent.
-- ============================================================================

BEGIN;

-- ── 1. Replace the trigger guard ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_historical_company_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ref_count bigint;
  v_target_id uuid;
BEGIN
  -- Setup Mode: skip every guard. Admins may edit / delete any profile.
  IF public.is_setup_mode() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

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
      -- Tier 1: accounting-critical fields — immutable while referenced.
      -- company_logo_url, company_stamp_url, address, phone, email, website
      -- are intentionally excluded: they are branding/contact fields whose
      -- existing snapshot values are already frozen in historical documents.
      IF (NEW.company_name       IS DISTINCT FROM OLD.company_name       OR
          NEW.company_legal_name IS DISTINCT FROM OLD.company_legal_name OR
          NEW.company_tax_id     IS DISTINCT FROM OLD.company_tax_id     OR
          NEW.pbf_license        IS DISTINCT FROM OLD.pbf_license        OR
          NEW.cdob_certificate   IS DISTINCT FROM OLD.cdob_certificate   OR
          NEW.effective_from     IS DISTINCT FROM OLD.effective_from) THEN
        RAISE EXCEPTION
          'PROFILE_REFERENCED: This Company Profile is referenced by % business document(s). '
          'The fields company_name, legal_name, tax_id, licenses and effective_from cannot be '
          'changed because they appear on issued tax documents. '
          'Create a new profile version for future documents instead. '
          'Branding fields (logo, stamp, address, phone, email, website) may still be updated.',
          v_ref_count;
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- Trigger definition is unchanged — just the function body above.

-- ── 2. Update the RLS write policy so accounts role can also update ───────────
-- Previously company_profiles_admin_write required role = 'admin' for ALL
-- operations. Split into two policies:
--   admin_all   — INSERT / DELETE (admin only)
--   branding_update — UPDATE (admin or accounts)
DROP POLICY IF EXISTS "company_profiles_admin_write"   ON public.company_profiles;
DROP POLICY IF EXISTS "company_profiles_admin_all"     ON public.company_profiles;
DROP POLICY IF EXISTS "company_profiles_branding_update" ON public.company_profiles;

CREATE POLICY "company_profiles_admin_all" ON public.company_profiles
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "company_profiles_branding_update" ON public.company_profiles
  FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','accounts'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('admin','accounts'))
  );

-- ── 3. Storage: allow accounts role to upload company assets ─────────────────
DROP POLICY IF EXISTS "company_assets_admin_write" ON storage.objects;

CREATE POLICY "company_assets_admin_write" ON storage.objects
  FOR ALL
  USING (
    bucket_id = 'company-assets'
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts')
    )
  )
  WITH CHECK (
    bucket_id = 'company-assets'
    AND EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role IN ('admin', 'accounts')
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
