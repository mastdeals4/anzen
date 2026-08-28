-- ============================================================================
-- Company Profile Versioning
-- ============================================================================
-- Creates a versioned company_profiles table so that company identity changes
-- (name, address, NPWP, logo, PBF/CDOB license) are tracked over time.
-- Each document table gets a company_snapshot JSONB column populated at INSERT
-- via a BEFORE INSERT trigger. Existing rows are backfilled with the seeded
-- initial profile. PDF templates read from the snapshot, never from hardcoded strings.
-- ============================================================================

BEGIN;

-- ── 1. company_profiles table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_profiles (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from   date        NOT NULL DEFAULT CURRENT_DATE,
  company_name     text        NOT NULL,
  company_address  text,
  company_phone    text,
  company_email    text,
  company_tax_id   text,
  company_logo_url text,
  pbf_license      text,
  cdob_certificate text,
  notes            text,
  created_by       uuid        REFERENCES auth.users(id),
  created_at       timestamptz DEFAULT now(),
  CONSTRAINT company_profiles_effective_from_unique UNIQUE (effective_from)
);

ALTER TABLE public.company_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_profiles_select" ON public.company_profiles;
CREATE POLICY "company_profiles_select" ON public.company_profiles
  FOR SELECT USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS "company_profiles_admin_write" ON public.company_profiles;
CREATE POLICY "company_profiles_admin_write" ON public.company_profiles
  FOR ALL USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ── 2. Seed initial profile from app_settings ─────────────────────────────────
INSERT INTO public.company_profiles
  (effective_from, company_name, company_address, company_phone, company_email,
   company_tax_id, company_logo_url, pbf_license, cdob_certificate, notes)
SELECT
  '2020-01-01'::date,
  COALESCE(company_name, 'PT. SHUBHAM ANZEN PHARMA JAYA'),
  company_address,
  company_phone,
  company_email,
  company_tax_id,
  company_logo_url,
  'No izin PBF: 27092400534390007',
  'No Sertifikasi CDOB: 270924005343900070001',
  'Initial profile seeded from app_settings'
FROM app_settings
ORDER BY created_at LIMIT 1
ON CONFLICT (effective_from) DO NOTHING;

-- ── 3. Helper: get current company profile as JSONB ───────────────────────────
CREATE OR REPLACE FUNCTION public.get_current_company_profile()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(cp)
  FROM company_profiles cp
  WHERE cp.effective_from <= CURRENT_DATE
  ORDER BY cp.effective_from DESC
  LIMIT 1;
$$;

-- ── 4. Trigger function: auto-snapshot on INSERT ───────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_snapshot_company_profile()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.company_snapshot IS NULL THEN
    NEW.company_snapshot := public.get_current_company_profile();
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Add company_snapshot column + trigger to each document table ────────────
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sales_invoices',
    'delivery_challans',
    'credit_notes',
    'material_returns',
    'stock_rejections',
    'purchase_orders',
    'payment_vouchers',
    'receipt_vouchers'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS company_snapshot jsonb', t
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_snapshot_company_%s ON public.%I', t, t
    );
    EXECUTE format(
      'CREATE TRIGGER trg_snapshot_company_%s BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.auto_snapshot_company_profile()',
      t, t
    );
  END LOOP;
END;
$outer$;

-- ── 6. Backfill existing rows ─────────────────────────────────────────────────
DO $outer$
DECLARE
  snap jsonb;
  t    text;
BEGIN
  snap := public.get_current_company_profile();
  FOREACH t IN ARRAY ARRAY[
    'sales_invoices',
    'delivery_challans',
    'credit_notes',
    'material_returns',
    'stock_rejections',
    'purchase_orders',
    'payment_vouchers',
    'receipt_vouchers'
  ] LOOP
    EXECUTE format(
      'UPDATE public.%I SET company_snapshot = $1 WHERE company_snapshot IS NULL', t
    ) USING snap;
  END LOOP;
END;
$outer$;

NOTIFY pgrst, 'reload schema';

COMMIT;
