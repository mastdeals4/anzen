/* New-document branding must always come from the effective company profile.
   Existing document snapshots remain immutable because this function is only
   attached to INSERT triggers. */
CREATE OR REPLACE FUNCTION public.auto_snapshot_company_profile()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.company_snapshot := public.get_current_company_profile();
  IF NEW.company_snapshot IS NULL THEN
    RAISE EXCEPTION 'Cannot create document: no effective company profile exists';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.auto_snapshot_company_profile()
IS 'Authoritative snapshot source for new documents. Always reads the effective company_profiles row and never changes existing snapshots.';
